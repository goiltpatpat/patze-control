import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import fs, { createReadStream } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client, type SFTPWrapper } from 'ssh2';
import { resolveSshConfig } from './ssh-config-parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export interface BridgeSetupInput {
  readonly label: string;
  readonly sshHost: string;
  readonly sshPort: number;
  readonly sshUser: string;
  readonly sshKeyPath: string;
  readonly sshMode?: 'alias' | 'explicit' | undefined;
  readonly authToken: string;
  readonly remotePort: number;
  readonly expiresIn?: string | undefined;
  readonly openclawHome?: string | undefined;
}

export type BridgeSetupPhase =
  | 'connecting'
  | 'ssh_test'
  | 'tunnel_open'
  | 'installing'
  | 'needs_sudo_password'
  | 'running'
  | 'telemetry_active'
  | 'error'
  | 'disconnected';

export type BridgeInstallMode = 'system' | 'user' | undefined;

export interface ManagedBridgeState {
  readonly id: string;
  readonly label: string;
  readonly sshHost: string;
  readonly sshUser: string;
  readonly sshPort: number;
  readonly remotePort: number;
  readonly status: BridgeSetupPhase;
  readonly error: string | undefined;
  readonly logs: readonly string[];
  readonly machineId: string | undefined;
  readonly connectedAt: string | undefined;
  readonly installMode: BridgeInstallMode;
}

interface ActiveBridge {
  id: string;
  label: string;
  sshHost: string;
  sshUser: string;
  sshPort: number;
  remotePort: number;
  client: Client;
  status: BridgeSetupPhase;
  error: string | undefined;
  logs: string[];
  machineId: string | undefined;
  connectedAt: string | undefined;
  closing: boolean;
  installMode: BridgeInstallMode;
  pendingInput: BridgeSetupInput | undefined;
  lastInput: BridgeSetupInput | undefined;
  retryAttempt: number;
  retryTimer: NodeJS.Timeout | null;
}

interface EffectiveSshConfig {
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly keyPath: string;
  readonly mode: 'alias' | 'explicit';
  readonly alias?: string | undefined;
}

interface SshAuthOptions {
  readonly privateKey?: string;
  readonly agentSocket?: string;
}

export interface BridgePreflightResult {
  readonly ok: boolean;
  readonly mode: 'alias' | 'explicit';
  readonly sshHost: string;
  readonly sshUser: string;
  readonly sshPort: number;
  readonly authMethod: 'private_key' | 'ssh_agent';
  readonly acceptedNewHostKey: boolean;
  readonly hints: readonly string[];
  readonly message: string;
}

const SSH_CONNECT_TIMEOUT_MS = 15_000;
const SSH_PREFLIGHT_EXEC_TIMEOUT_MS = 10_000;
const SSH_SFTP_OPEN_TIMEOUT_MS = 20_000;
const TELEMETRY_VERIFY_TIMEOUT_MS = 30_000;
const TELEMETRY_VERIFY_INTERVAL_MS = 2_000;
const BRIDGE_AUTO_RETRY_BASE_MS = 4_000;
const BRIDGE_AUTO_RETRY_MAX_MS = 60_000;
const BRIDGE_AUTO_RETRY_MAX_ATTEMPTS = 6;
const ALLOWED_SSH_KEY_DIRS = ['.ssh'];

function makeBridgeId(host: string, port: number): string {
  return `bridge_${host.replace(/[^a-zA-Z0-9._-]/g, '_')}_${port}`;
}

function resolveHomePath(p: string): string {
  return p.startsWith('~') ? p.replace('~', os.homedir()) : p;
}

function isPathUnderSshDir(keyPath: string): boolean {
  const resolved = path.resolve(resolveHomePath(keyPath));
  return ALLOWED_SSH_KEY_DIRS.some((dir) => {
    const allowedDir = path.resolve(os.homedir(), dir);
    return resolved.startsWith(allowedDir + path.sep) || resolved === allowedDir;
  });
}

async function loadKnownHostKeys(
  hostName: string,
  port: number,
  knownHostsPath: string
): Promise<Set<string>> {
  const keys = new Set<string>();
  try {
    const content = await readFile(knownHostsPath, 'utf-8');
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const parts = trimmed.split(/\s+/);
      const offset = parts[0]?.startsWith('@') ? 1 : 0;
      const hostsField = parts[offset];
      const keyBase64 = parts[offset + 2];
      if (!hostsField || !keyBase64) continue;

      const hosts = hostsField.split(',');
      const matches = hosts.some((h) => {
        const ht = h.trim();
        if (ht.startsWith('[')) {
          const close = ht.indexOf(']');
          if (close <= 0) return false;
          const bracketHost = ht.slice(1, close);
          const portPart = ht.slice(close + 1);
          if (!portPart.startsWith(':')) return false;
          return bracketHost === hostName && Number(portPart.slice(1)) === port;
        }
        return port === 22 && ht === hostName;
      });
      if (matches) keys.add(keyBase64);
    }
  } catch {
    // known_hosts file may not exist
  }
  return keys;
}

async function appendKnownHost(
  host: string,
  port: number,
  keyType: string,
  keyBase64: string,
  knownHostsPath: string
): Promise<void> {
  const hostEntry = port === 22 ? host : `[${host}]:${port}`;
  const line = `${hostEntry} ${keyType} ${keyBase64}\n`;
  try {
    await mkdir(path.dirname(knownHostsPath), { recursive: true });
    await writeFile(knownHostsPath, line, { flag: 'a' });
  } catch {
    // Best effort
  }
}

const LOG_SCRUB_PATTERNS = [
  /TOKEN=\S+/gi,
  /PASSWORD=\S+/gi,
  /CONTROL_PLANE_TOKEN=\S+/gi,
  /Bearer\s+\S+/gi,
];

function scrubSensitive(text: string): string {
  let result = text;
  for (const pattern of LOG_SCRUB_PATTERNS) {
    result = result.replace(pattern, (match) => {
      const eqIdx = match.indexOf('=');
      const spaceIdx = match.indexOf(' ');
      const sep = eqIdx >= 0 ? eqIdx : spaceIdx;
      if (sep >= 0) return match.slice(0, sep + 1) + '***';
      return '***';
    });
  }
  return result;
}

export class BridgeSetupManager {
  private readonly bridges = new Map<string, ActiveBridge>();
  private readonly localPort: number;
  private readonly installScriptPath: string | undefined;

  constructor(options: { localPort: number; installScriptPath?: string }) {
    this.localPort = options.localPort;
    this.installScriptPath = options.installScriptPath;
  }

  async setup(input: BridgeSetupInput): Promise<ManagedBridgeState> {
    const id = makeBridgeId(input.sshHost, input.sshPort);

    const existing = this.bridges.get(id);
    if (
      existing &&
      !existing.closing &&
      existing.status !== 'error' &&
      existing.status !== 'disconnected'
    ) {
      return this.toState(existing);
    }

    if (existing) {
      this.cleanupBridge(existing);
    }

    const bridge: ActiveBridge = {
      id,
      label: input.label,
      sshHost: input.sshHost,
      sshUser: input.sshUser,
      sshPort: input.sshPort,
      remotePort: input.remotePort,
      client: new Client(),
      status: 'connecting',
      error: undefined,
      logs: [],
      machineId: undefined,
      connectedAt: undefined,
      closing: false,
      installMode: undefined,
      pendingInput: undefined,
      lastInput: input,
      retryAttempt: 0,
      retryTimer: null,
    };

    this.bridges.set(id, bridge);
    this.addLog(bridge, `Starting bridge setup to ${input.sshUser}@${input.sshHost}...`);

    void this.runSetup(bridge, input).catch((err: unknown) => {
      this.handleSetupFailure(bridge, input, err);
    });

    return this.toState(bridge);
  }

  async preflight(input: BridgeSetupInput): Promise<BridgePreflightResult> {
    const effective = await this.resolveEffectiveSsh(input);
    const auth = await this.resolveSshAuth(effective);

    const client = new Client();
    try {
      const acceptedNewKey = await this.connectClient(client, effective, auth, true);
      const authMethod: 'private_key' | 'ssh_agent' = auth.privateKey ? 'private_key' : 'ssh_agent';

      const result = await this.remoteExec(client, 'echo ok', SSH_PREFLIGHT_EXEC_TIMEOUT_MS);
      if (result.exitCode !== 0 || result.stdout !== 'ok\n') {
        throw new Error('SSH pre-flight check failed (echo ok mismatch).');
      }

      const warning = acceptedNewKey
        ? `New host key accepted and saved for ${effective.host}:${effective.port}. Verify the fingerprint for production use.`
        : undefined;
      const hints = acceptedNewKey
        ? [
            'Host key was accepted via TOFU. Confirm fingerprint on first connect for production safety.',
          ]
        : [];

      return {
        ok: true,
        mode: effective.mode,
        sshHost: effective.host,
        sshUser: effective.user,
        sshPort: effective.port,
        authMethod,
        acceptedNewHostKey: acceptedNewKey,
        hints,
        message: warning ? `SSH pre-flight passed. ${warning}` : 'SSH pre-flight passed.',
      };
    } finally {
      try {
        client.end();
      } catch {
        /* noop */
      }
    }
  }

  disconnect(id: string): boolean {
    const bridge = this.bridges.get(id);
    if (!bridge) return false;
    this.cleanupBridge(bridge);
    bridge.status = 'disconnected';
    this.addLog(bridge, 'Disconnected by user.');
    return true;
  }

  remove(id: string): boolean {
    const bridge = this.bridges.get(id);
    if (!bridge) return false;
    this.cleanupBridge(bridge);
    this.bridges.delete(id);
    return true;
  }

  list(): readonly ManagedBridgeState[] {
    return Array.from(this.bridges.values()).map((b) => this.toState(b));
  }

  get(id: string): ManagedBridgeState | null {
    const bridge = this.bridges.get(id);
    return bridge ? this.toState(bridge) : null;
  }

  getSshClient(id: string): Client | null {
    const bridge = this.bridges.get(id);
    if (
      !bridge ||
      bridge.closing ||
      bridge.status === 'disconnected' ||
      bridge.status === 'error'
    ) {
      return null;
    }
    return bridge.client;
  }

  async closeAll(): Promise<void> {
    for (const bridge of this.bridges.values()) {
      this.cleanupBridge(bridge);
    }
    this.bridges.clear();
  }

  private async runSetup(bridge: ActiveBridge, input: BridgeSetupInput): Promise<void> {
    bridge.lastInput = input;
    this.clearRetryTimer(bridge);
    const { client } = bridge;
    const effective = await this.resolveEffectiveSsh(input);
    const auth = await this.resolveSshAuth(effective);

    bridge.sshHost = effective.host;
    bridge.sshUser = effective.user;
    bridge.sshPort = effective.port;
    this.addLog(
      bridge,
      `SSH mode: ${effective.mode}${effective.alias ? ` (${effective.alias})` : ''}`
    );
    this.addLog(
      bridge,
      `Connecting SSH to ${effective.user}@${effective.host}:${effective.port}...`
    );
    const acceptedNewKey = await this.connectClient(client, effective, auth, true);
    if (acceptedNewKey) {
      this.addLog(
        bridge,
        'WARNING: Unknown SSH host key accepted on first use (TOFU). Verify host fingerprint for production use.'
      );
    }

    if (bridge.closing) return;
    this.addLog(bridge, 'SSH connected.');
    bridge.status = 'ssh_test';
    this.addLog(bridge, 'Running SSH pre-flight check: echo ok');
    const preflight = await this.remoteExec(client, 'echo ok', SSH_PREFLIGHT_EXEC_TIMEOUT_MS);
    if (preflight.exitCode !== 0 || preflight.stdout !== 'ok\n') {
      throw new Error('SSH pre-flight check failed (echo ok mismatch).');
    }
    this.addLog(bridge, 'SSH pre-flight passed.');

    this.addLog(
      bridge,
      `Opening reverse tunnel VPS:${input.remotePort} → localhost:${this.localPort}...`
    );
    await new Promise<void>((resolve, reject) => {
      client.forwardIn('127.0.0.1', input.remotePort, (err: Error | undefined) => {
        if (err) {
          reject(new Error(`Reverse tunnel failed: ${err.message}`));
        } else {
          resolve();
        }
      });
    });

    if (bridge.closing) return;
    bridge.status = 'tunnel_open';
    this.addLog(
      bridge,
      `Reverse tunnel open: VPS:${input.remotePort} → localhost:${this.localPort}`
    );
    this.addLog(
      bridge,
      'Security note: if SSHD has GatewayPorts enabled, bind behavior may still widen.'
    );

    client.on('tcp connection', (_info: unknown, accept: () => import('ssh2').ClientChannel) => {
      const channel = accept();
      const socket = net.connect(this.localPort, '127.0.0.1');

      channel.pipe(socket);
      socket.pipe(channel);

      const cleanup = (): void => {
        socket.destroy();
        channel.destroy();
      };

      socket.on('error', cleanup);
      channel.on('error', cleanup);
      socket.on('close', cleanup);
      channel.on('close', cleanup);
    });

    const installResult = await this.tryInstallBridge(bridge, input);

    if (bridge.closing) return;

    if (installResult === 'needs_sudo_password') {
      this.resetRetryState(bridge);
      return;
    }

    if (installResult === 'installed' || installResult === 'already_running') {
      const machineId = await this.tryGetMachineId(client, bridge.installMode);
      bridge.machineId = machineId ?? undefined;
      bridge.status = 'running';
      bridge.connectedAt = new Date().toISOString();
      this.addLog(bridge, `Bridge is running. Machine ID: ${bridge.machineId ?? 'pending'}`);
      const telemetryActive = await this.verifyTelemetry(bridge, input.remotePort);
      if (telemetryActive) {
        bridge.status = 'telemetry_active';
        this.addLog(bridge, 'Telemetry verification passed. Bridge is active.');
      } else {
        this.addLog(
          bridge,
          'Telemetry verification timed out after 30s. Keeping bridge running and will wait for data.'
        );
      }
      this.resetRetryState(bridge);
    } else {
      bridge.status = 'tunnel_open';
      this.addLog(bridge, 'Reverse tunnel is open. Bridge can connect through it.');
      this.addLog(
        bridge,
        'If the bridge is not installed on VPS, install it manually or wait for data to flow.'
      );
      this.resetRetryState(bridge);
    }

    client.on('close', () => {
      if (!bridge.closing) {
        bridge.status = 'error';
        bridge.error = 'SSH connection closed unexpectedly';
        this.addLog(bridge, 'SSH connection lost.');
        this.scheduleAutoRetry(bridge, bridge.error);
      }
    });

    client.on('error', (err: Error) => {
      if (!bridge.closing) {
        bridge.status = 'error';
        bridge.error = err.message;
        this.addLog(bridge, `SSH error: ${err.message}`);
        this.scheduleAutoRetry(bridge, err.message);
      }
    });
  }

  private async resolveEffectiveSsh(input: BridgeSetupInput): Promise<EffectiveSshConfig> {
    const requestedMode = input.sshMode ?? 'alias';
    const aliasResolution =
      requestedMode === 'explicit'
        ? { isAlias: false as const }
        : await resolveSshConfig(input.sshHost);

    if (aliasResolution.isAlias) {
      return {
        host: aliasResolution.hostname,
        user: aliasResolution.user ?? input.sshUser,
        port: aliasResolution.port ?? input.sshPort,
        keyPath: aliasResolution.identityFile ?? input.sshKeyPath,
        mode: 'alias',
        alias: aliasResolution.alias,
      };
    }

    return {
      host: input.sshHost,
      user: input.sshUser,
      port: input.sshPort,
      keyPath: input.sshKeyPath,
      mode: 'explicit',
    };
  }

  private async connectClient(
    client: Client,
    effective: EffectiveSshConfig,
    auth: SshAuthOptions,
    trustOnFirstUse = false
  ): Promise<boolean> {
    const knownHostsPath = path.join(os.homedir(), '.ssh', 'known_hosts');
    const expectedKeys = await loadKnownHostKeys(effective.host, effective.port, knownHostsPath);
    let acceptedNewKey = false;

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        client.end();
        reject(new Error(`SSH connection timed out after ${SSH_CONNECT_TIMEOUT_MS}ms`));
      }, SSH_CONNECT_TIMEOUT_MS);

      client.once('ready', () => {
        clearTimeout(timer);
        resolve();
      });

      client.once('error', (err: Error) => {
        clearTimeout(timer);
        reject(err);
      });

      client.connect({
        host: effective.host,
        port: effective.port,
        username: effective.user,
        ...(auth.privateKey ? { privateKey: auth.privateKey } : {}),
        ...(auth.agentSocket ? { agent: auth.agentSocket } : {}),
        readyTimeout: SSH_CONNECT_TIMEOUT_MS,
        hostVerifier: (key: Buffer): boolean => {
          const presented = key.toString('base64');
          if (expectedKeys.size === 0) {
            if (trustOnFirstUse) {
              acceptedNewKey = true;
              return true;
            }
            return false;
          }
          return expectedKeys.has(presented);
        },
      });
    });

    if (acceptedNewKey) {
      const keyInfo = client as unknown as {
        _sock?: { _server_host_key_algo?: string; _server_host_key?: Buffer };
      };
      const algo = keyInfo._sock?._server_host_key_algo ?? 'ssh-rsa';
      const rawKey = keyInfo._sock?._server_host_key;
      if (rawKey) {
        void appendKnownHost(
          effective.host,
          effective.port,
          algo,
          rawKey.toString('base64'),
          knownHostsPath
        );
      }
    }

    return acceptedNewKey;
  }

  private async resolveSshAuth(effective: EffectiveSshConfig): Promise<SshAuthOptions> {
    const keyPath = effective.keyPath.trim();
    if (keyPath.length > 0) {
      if (!isPathUnderSshDir(keyPath)) {
        throw new Error(`SSH key path must be under ~/.ssh/ — got "${keyPath}"`);
      }
      try {
        const privateKey = await this.loadSshKey(keyPath);
        return { privateKey };
      } catch (error) {
        const agentSocket = process.env.SSH_AUTH_SOCK;
        if (agentSocket && agentSocket.trim().length > 0) {
          return { agentSocket };
        }
        throw error;
      }
    }

    const agentSocket = process.env.SSH_AUTH_SOCK;
    if (agentSocket && agentSocket.trim().length > 0) {
      return { agentSocket };
    }

    throw new Error(
      'No SSH key found and SSH agent is unavailable. Configure key path or load ssh-agent.'
    );
  }

  private buildInstallArgs(input: BridgeSetupInput, extra?: string): string {
    const remoteUrl = `http://localhost:${input.remotePort}`;
    let cmdArgs = `--url ${this.shellQuote(remoteUrl)} --token ${this.shellQuote(input.authToken)}`;
    if (input.expiresIn) {
      cmdArgs += ` --expires-in ${this.shellQuote(input.expiresIn)}`;
    }
    if (input.openclawHome) {
      cmdArgs += ` --openclaw-home ${this.shellQuote(input.openclawHome)}`;
    }
    if (extra) cmdArgs += ` ${extra}`;
    return cmdArgs;
  }

  private async detectPrivilege(
    client: Client
  ): Promise<'root' | 'sudo_nopass' | 'sudo_needs_pass' | 'no_sudo'> {
    const idResult = await this.remoteExec(client, 'id -u');
    if (idResult.exitCode === 0 && idResult.stdout.trim() === '0') {
      return 'root';
    }
    const sudoCheck = await this.remoteExec(client, 'sudo -n true 2>/dev/null');
    if (sudoCheck.exitCode === 0) {
      return 'sudo_nopass';
    }
    const hasSudo = await this.remoteExec(client, 'command -v sudo >/dev/null 2>&1 && echo yes');
    if (hasSudo.exitCode === 0 && hasSudo.stdout.trim() === 'yes') {
      return 'sudo_needs_pass';
    }
    return 'no_sudo';
  }

  private async tryInstallBridge(
    bridge: ActiveBridge,
    input: BridgeSetupInput
  ): Promise<'installed' | 'already_running' | 'skipped' | 'needs_sudo_password'> {
    const { client } = bridge;

    const serviceActive = await this.remoteExec(
      client,
      'systemctl is-active --quiet patze-bridge 2>/dev/null'
    );
    if (serviceActive.exitCode === 0) {
      this.addLog(
        bridge,
        'Bridge service already running on VPS. Uploading new bundle & restarting...'
      );
      bridge.installMode = 'system';
      let bundleUpdated = false;
      let bundleUpdateFailed = false;
      try {
        bundleUpdated = await this.uploadAndReplaceBridgeBundleIfChanged(
          bridge,
          '/opt/patze-bridge/bridge.mjs',
          true
        );
      } catch (error) {
        bundleUpdateFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        this.addLog(
          bridge,
          `Bundle update failed (${message}). Falling back to restart existing bundle.`
        );
      }
      const configUpdated = await this.remoteWriteConfigIfChanged(bridge, input);
      if (!bundleUpdated && !configUpdated && !bundleUpdateFailed) {
        this.addLog(bridge, 'No bundle/config changes detected. Skip restart.');
        return 'already_running';
      }

      const sudoRestart = await this.remoteExec(
        client,
        'sudo -n systemctl restart patze-bridge 2>&1'
      );
      if (sudoRestart.exitCode === 0) {
        this.addLog(
          bridge,
          bundleUpdated
            ? 'Service restarted with new bundle.'
            : 'Service restarted with existing bundle (bundle update skipped).'
        );
        return 'already_running';
      }

      this.addLog(bridge, 'sudo password required to restart service.');
      bridge.status = 'needs_sudo_password';
      bridge.pendingInput = input;
      return 'needs_sudo_password';
    }

    const userServiceActive = await this.remoteExec(
      client,
      'systemctl --user is-active --quiet patze-bridge 2>/dev/null'
    );
    if (userServiceActive.exitCode === 0) {
      this.addLog(
        bridge,
        'Bridge user service already running. Uploading new bundle & restarting...'
      );
      bridge.installMode = 'user';
      const homeDir = (await this.remoteExec(client, 'echo $HOME')).stdout.trim();
      let bundleUpdated = false;
      let bundleUpdateFailed = false;
      try {
        bundleUpdated = await this.uploadAndReplaceBridgeBundleIfChanged(
          bridge,
          `${homeDir}/patze-bridge/bridge.mjs`,
          false
        );
      } catch (error) {
        bundleUpdateFailed = true;
        const message = error instanceof Error ? error.message : String(error);
        this.addLog(
          bridge,
          `Bundle update failed (${message}). Falling back to restart existing bundle.`
        );
      }
      const configUpdated = await this.remoteWriteConfigIfChanged(bridge, input);
      if (!bundleUpdated && !configUpdated && !bundleUpdateFailed) {
        this.addLog(bridge, 'No bundle/config changes detected. Skip restart.');
        return 'already_running';
      }
      await this.remoteExec(client, 'systemctl --user restart patze-bridge');
      this.addLog(
        bridge,
        bundleUpdated
          ? 'User service restarted with new bundle.'
          : 'User service restarted with existing bundle (bundle update skipped).'
      );
      return 'already_running';
    }

    if (!this.installScriptPath || !fs.existsSync(this.installScriptPath)) {
      this.addLog(bridge, 'Install script not found locally. Skipping auto-install.');
      return 'skipped';
    }

    const privilege = await this.detectPrivilege(client);
    this.addLog(bridge, `Privilege detection: ${privilege}`);

    if (privilege === 'sudo_needs_pass') {
      bridge.status = 'needs_sudo_password';
      bridge.pendingInput = input;
      this.addLog(
        bridge,
        'sudo requires a password. Waiting for user to provide it or skip to user-level install.'
      );
      return 'needs_sudo_password';
    }

    bridge.status = 'installing';
    if (privilege === 'no_sudo') {
      bridge.installMode = 'user';
      this.addLog(bridge, 'Installing bridge (user-level, no sudo required)...');
    } else {
      bridge.installMode = 'system';
      this.addLog(bridge, 'Installing bridge (system-level)...');
    }

    const bundlePath = await this.uploadBridgeBundle(bridge, bridge.installMode);
    const extraFlags =
      privilege === 'no_sudo'
        ? `--user-mode --bundle-path ${this.shellQuote(bundlePath)}`
        : `--bundle-path ${this.shellQuote(bundlePath)}`;

    return this.runInstallScript(bridge, input, extraFlags);
  }

  private async runInstallScript(
    bridge: ActiveBridge,
    input: BridgeSetupInput,
    extraFlags: string,
    sudoPassword?: string
  ): Promise<'installed' | 'skipped'> {
    try {
      const scriptContent = await readFile(this.installScriptPath!, 'utf-8');
      const cmdArgs = this.buildInstallArgs(input, extraFlags);

      if (sudoPassword) {
        const tmpPath = `/tmp/.patze-install-${Date.now()}.sh`;
        await this.remoteExecWithStdin(
          bridge.client,
          `cat > ${tmpPath} && chmod 700 ${tmpPath}`,
          scriptContent
        );
        try {
          const result = await this.remoteExecWithStdin(
            bridge.client,
            `bash ${tmpPath} ${cmdArgs}`,
            sudoPassword + '\n'
          );
          if (result.stdout) this.addLog(bridge, scrubSensitive(result.stdout));
          if (result.stderr) this.addLog(bridge, `stderr: ${scrubSensitive(result.stderr)}`);

          if (result.exitCode !== 0) {
            this.addLog(
              bridge,
              `Install script exited with code ${result.exitCode}. Bridge may not be running.`
            );
            return 'skipped';
          }
        } finally {
          this.remoteExecWithStdin(bridge.client, `rm -f ${tmpPath}`, '').catch(() => undefined);
        }
      } else {
        const result = await this.remoteExecWithStdin(
          bridge.client,
          `bash -s -- ${cmdArgs}`,
          scriptContent
        );
        if (result.stdout) this.addLog(bridge, scrubSensitive(result.stdout));
        if (result.stderr) this.addLog(bridge, `stderr: ${scrubSensitive(result.stderr)}`);

        if (result.exitCode !== 0) {
          this.addLog(
            bridge,
            `Install script exited with code ${result.exitCode}. Bridge may not be running.`
          );
          return 'skipped';
        }
      }

      this.addLog(bridge, 'Bridge installed successfully.');
      return 'installed';
    } catch (err) {
      this.addLog(bridge, `Install failed: ${err instanceof Error ? err.message : String(err)}`);
      return 'skipped';
    }
  }

  async retryInstallWithSudoPassword(
    bridgeId: string,
    password: string
  ): Promise<ManagedBridgeState | null> {
    const bridge = this.bridges.get(bridgeId);
    if (!bridge || bridge.status !== 'needs_sudo_password' || !bridge.pendingInput) {
      return bridge ? this.toState(bridge) : null;
    }

    const { client } = bridge;
    const serviceActive = await this.remoteExec(
      client,
      'systemctl is-active --quiet patze-bridge 2>/dev/null'
    );

    if (serviceActive.exitCode === 0) {
      bridge.status = 'installing';
      bridge.installMode = 'system';
      this.addLog(bridge, 'Restarting bridge service with sudo password...');

      const restartResult = await this.remoteExecWithStdin(
        client,
        'sudo -S systemctl restart patze-bridge 2>&1',
        password + '\n'
      );

      bridge.pendingInput = undefined;

      if (restartResult.exitCode === 0) {
        this.addLog(bridge, 'Service restarted with new bundle.');
        const machineId = await this.tryGetMachineId(client, bridge.installMode);
        bridge.machineId = machineId ?? undefined;
        bridge.status = 'running';
        bridge.connectedAt = new Date().toISOString();
        this.addLog(bridge, `Bridge is running. Machine ID: ${bridge.machineId ?? 'pending'}`);
        const telemetryActive = await this.verifyTelemetry(bridge, bridge.remotePort);
        if (telemetryActive) {
          bridge.status = 'telemetry_active';
          this.addLog(bridge, 'Telemetry verification passed. Bridge is active.');
        }
      } else {
        bridge.status = 'error';
        bridge.error = `sudo restart failed: ${restartResult.stderr.trim()}`;
        this.addLog(bridge, `Restart failed: ${restartResult.stderr.trim()}`);
      }
      return this.toState(bridge);
    }

    bridge.status = 'installing';
    bridge.installMode = 'system';
    this.addLog(bridge, 'Retrying install with sudo password...');
    const pendingInput = bridge.pendingInput;

    const bundlePath = await this.uploadBridgeBundle(bridge, 'system');
    const result = await this.runInstallScript(
      bridge,
      pendingInput,
      `--sudo-pass --bundle-path ${this.shellQuote(bundlePath)}`,
      password
    );
    bridge.pendingInput = undefined;

    if (result === 'skipped') {
      this.addLog(
        bridge,
        'System-mode install failed after sudo retry. Falling back to user-mode install...'
      );
      bridge.installMode = 'user';
      const userBundlePath = await this.uploadBridgeBundle(bridge, 'user');
      const userResult = await this.runInstallScript(
        bridge,
        pendingInput,
        `--user-mode --bundle-path ${this.shellQuote(userBundlePath)}`
      );
      await this.finishPostInstall(bridge, userResult);
      return this.toState(bridge);
    }

    await this.finishPostInstall(bridge, result);
    return this.toState(bridge);
  }

  async retryInstallUserMode(bridgeId: string): Promise<ManagedBridgeState | null> {
    const bridge = this.bridges.get(bridgeId);
    if (!bridge || bridge.status !== 'needs_sudo_password' || !bridge.pendingInput) {
      return bridge ? this.toState(bridge) : null;
    }

    bridge.status = 'installing';
    bridge.installMode = 'user';
    this.addLog(bridge, 'Installing bridge (user-level, no sudo required)...');

    const bundlePath = await this.uploadBridgeBundle(bridge, 'user');
    const result = await this.runInstallScript(
      bridge,
      bridge.pendingInput,
      `--user-mode --bundle-path ${this.shellQuote(bundlePath)}`
    );
    bridge.pendingInput = undefined;

    await this.finishPostInstall(bridge, result);
    return this.toState(bridge);
  }

  private async finishPostInstall(
    bridge: ActiveBridge,
    result: 'installed' | 'skipped'
  ): Promise<void> {
    if (bridge.closing) return;

    if (result === 'installed') {
      const machineId = await this.tryGetMachineId(bridge.client, bridge.installMode);
      bridge.machineId = machineId ?? undefined;
      bridge.status = 'running';
      bridge.connectedAt = new Date().toISOString();
      this.addLog(bridge, `Bridge is running. Machine ID: ${bridge.machineId ?? 'pending'}`);
      const telemetryActive = await this.verifyTelemetry(bridge, bridge.remotePort);
      if (telemetryActive) {
        bridge.status = 'telemetry_active';
        this.addLog(bridge, 'Telemetry verification passed. Bridge is active.');
      } else {
        this.addLog(
          bridge,
          'Telemetry verification timed out after 30s. Keeping bridge running and will wait for data.'
        );
      }
    } else {
      bridge.status = 'tunnel_open';
      bridge.error =
        'Bridge install/start failed. Tunnel is open but bridge service is not running yet.';
      this.addLog(bridge, 'Reverse tunnel is open. Bridge can connect through it.');
      this.addLog(
        bridge,
        'Bridge service is not running yet. Retry with user-mode or check sudo/systemd.'
      );
    }
  }

  private async verifyTelemetry(bridge: ActiveBridge, remotePort: number): Promise<boolean> {
    const deadline = Date.now() + TELEMETRY_VERIFY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      if (bridge.closing) {
        return false;
      }

      const healthResult = await this.remoteExec(
        bridge.client,
        `curl -sf http://localhost:${remotePort}/health >/dev/null`
      );
      if (healthResult.exitCode === 0) {
        return true;
      }

      await new Promise((resolve) => setTimeout(resolve, TELEMETRY_VERIFY_INTERVAL_MS));
    }

    return false;
  }

  private async remoteWriteConfigIfChanged(
    bridge: ActiveBridge,
    input: BridgeSetupInput
  ): Promise<boolean> {
    const remoteUrl = `http://localhost:${input.remotePort}`;
    const configContent = [
      `CONTROL_PLANE_BASE_URL=${remoteUrl}`,
      `CONTROL_PLANE_TOKEN=${input.authToken}`,
      `HEARTBEAT_INTERVAL_MS=5000`,
      `CRON_SYNC_PATH=/openclaw/bridge/cron-sync`,
      `CRON_SYNC_INTERVAL_MS=30000`,
    ].join('\n');

    const configPath =
      bridge.installMode === 'user'
        ? '$HOME/.config/patze-bridge/config.env'
        : '/etc/patze-bridge/config.env';
    const mkdirCmd =
      bridge.installMode === 'user'
        ? 'mkdir -p $HOME/.config/patze-bridge'
        : 'sudo mkdir -p /etc/patze-bridge';
    const writeCmd =
      bridge.installMode === 'user'
        ? `tee ${configPath} > /dev/null`
        : `sudo tee ${configPath} > /dev/null`;

    await this.remoteExec(bridge.client, mkdirCmd);
    const existing = await this.remoteExec(bridge.client, `cat ${configPath} 2>/dev/null`);
    if (existing.exitCode === 0 && existing.stdout.trimEnd() === configContent.trimEnd()) {
      this.addLog(bridge, `Config unchanged at ${configPath}.`);
      return false;
    }

    const cmd = `${writeCmd} << 'PATZE_EOF'\n${configContent}\nPATZE_EOF`;
    const result = await this.remoteExec(bridge.client, cmd);
    if (result.exitCode !== 0) {
      this.addLog(bridge, `Config update failed: ${result.stderr}`);
      return false;
    }
    this.addLog(bridge, `Config updated at ${configPath}.`);
    return true;
  }

  private async tryGetMachineId(
    client: Client,
    installMode?: BridgeInstallMode
  ): Promise<string | null> {
    const idPath =
      installMode === 'user'
        ? '$HOME/.config/patze-bridge/machine-id'
        : '/etc/patze-bridge/machine-id';
    try {
      const result = await this.remoteExec(client, `cat ${idPath} 2>/dev/null`);
      return result.exitCode === 0 && result.stdout.trim() ? result.stdout.trim() : null;
    } catch {
      return null;
    }
  }

  private remoteExec(
    client: Client,
    command: string,
    timeoutMs?: number
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';
        const timeout =
          timeoutMs && timeoutMs > 0
            ? setTimeout(() => {
                stream.close();
                reject(new Error(`Remote command timed out after ${timeoutMs}ms: ${command}`));
              }, timeoutMs)
            : null;

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        stream.on('close', (code: number | null) => {
          if (timeout) clearTimeout(timeout);
          resolve({ stdout, stderr, exitCode: code ?? 1 });
        });
        stream.on('error', (streamErr: Error) => {
          if (timeout) clearTimeout(timeout);
          reject(streamErr);
        });
      });
    });
  }

  private async ensureBridgeBundle(): Promise<string> {
    const bundlePath = path.resolve(
      __dirname,
      '../../../packages/openclaw-bridge/dist/bridge-bundle.mjs'
    );
    try {
      await stat(bundlePath);
      return bundlePath;
    } catch {
      const root = path.resolve(__dirname, '../../..');
      execSync('pnpm --filter @patze/openclaw-bridge run build:bundle', {
        cwd: root,
        stdio: 'pipe',
        timeout: 30_000,
      });
      return bundlePath;
    }
  }

  private openSftp(client: Client): Promise<SFTPWrapper> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(new Error(`SFTP open timed out after ${SSH_SFTP_OPEN_TIMEOUT_MS / 1000}s`));
      }, SSH_SFTP_OPEN_TIMEOUT_MS);
      client.sftp((err, sftp) => {
        clearTimeout(timer);
        if (settled) return;
        if (err) {
          settled = true;
          reject(err);
          return;
        }
        settled = true;
        resolve(sftp);
      });
    });
  }

  private sftpMkdir(sftp: SFTPWrapper, remotePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      sftp.mkdir(remotePath, (err) => {
        if (err && (err as unknown as { code?: number }).code !== 4) return reject(err);
        resolve();
      });
    });
  }

  private sftpUpload(
    sftp: SFTPWrapper,
    localPath: string,
    remotePath: string,
    timeoutMs = 60_000
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error(`SFTP upload timed out after ${timeoutMs / 1000}s: ${remotePath}`));
        }
      }, timeoutMs);

      const readStream = createReadStream(localPath);
      const writeStream = sftp.createWriteStream(remotePath, { mode: 0o755 });
      writeStream.on('close', () => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          resolve();
        }
      });
      writeStream.on('error', (err: Error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      readStream.on('error', (err: Error) => {
        clearTimeout(timer);
        if (!settled) {
          settled = true;
          reject(err);
        }
      });
      readStream.pipe(writeStream);
    });
  }

  private async uploadBridgeBundle(bridge: ActiveBridge, mode: BridgeInstallMode): Promise<string> {
    const localBundle = await this.ensureBridgeBundle();

    const modeTag = mode ?? 'auto';
    const tmpRemotePath = `/tmp/patze-bridge-${modeTag}-${Date.now()}.mjs`;

    const sftp = await this.openSftp(bridge.client);
    try {
      await this.sftpUpload(sftp, localBundle, tmpRemotePath);
      const sizeKB = (fs.statSync(localBundle).size / 1024).toFixed(1);
      this.addLog(bridge, `Bundle uploaded (${modeTag}) to ${tmpRemotePath} (${sizeKB}KB)`);
      return tmpRemotePath;
    } finally {
      sftp.end();
    }
  }

  private async uploadAndReplaceBridgeBundle(
    bridge: ActiveBridge,
    remoteDestination: string
  ): Promise<void> {
    const localBundle = await this.ensureBridgeBundle();
    const tmpRemotePath = `/tmp/patze-bridge-${Date.now()}.mjs`;

    const sftp = await this.openSftp(bridge.client);
    try {
      await this.sftpUpload(sftp, localBundle, tmpRemotePath);
    } finally {
      sftp.end();
    }

    const sizeKB = (fs.statSync(localBundle).size / 1024).toFixed(1);
    const mv = await this.remoteExec(
      bridge.client,
      `cp ${this.shellQuote(tmpRemotePath)} ${this.shellQuote(remoteDestination)} && rm -f ${this.shellQuote(tmpRemotePath)}`
    );
    if (mv.exitCode !== 0) {
      this.addLog(bridge, `Bundle copy failed (exit ${mv.exitCode}), trying sudo...`);
      await this.remoteExec(
        bridge.client,
        `sudo cp ${this.shellQuote(tmpRemotePath)} ${this.shellQuote(remoteDestination)} && rm -f ${this.shellQuote(tmpRemotePath)}`
      );
    }
    this.addLog(bridge, `Bundle replaced at ${remoteDestination} (${sizeKB}KB)`);
  }

  private async uploadAndReplaceBridgeBundleIfChanged(
    bridge: ActiveBridge,
    remoteDestination: string,
    useSudoForRead: boolean
  ): Promise<boolean> {
    const localBundle = await this.ensureBridgeBundle();
    const localHash = await this.computeLocalFileSha256(localBundle);
    const remoteHash = await this.tryReadRemoteFileSha256(
      bridge.client,
      remoteDestination,
      useSudoForRead
    );

    if (remoteHash && remoteHash === localHash) {
      this.addLog(bridge, `Bundle unchanged at ${remoteDestination}.`);
      return false;
    }

    await this.uploadAndReplaceBridgeBundle(bridge, remoteDestination);
    return true;
  }

  private async computeLocalFileSha256(localPath: string): Promise<string> {
    const content = await readFile(localPath);
    return createHash('sha256').update(content).digest('hex');
  }

  private async tryReadRemoteFileSha256(
    client: Client,
    remotePath: string,
    useSudo: boolean
  ): Promise<string | null> {
    const safePath = this.shellQuote(remotePath);
    const base = useSudo ? 'sudo ' : '';
    const command = [
      `${base}test -f ${safePath} || exit 3`,
      `if command -v sha256sum >/dev/null 2>&1; then ${base}sha256sum ${safePath} | awk '{print $1}'`,
      `elif command -v shasum >/dev/null 2>&1; then ${base}shasum -a 256 ${safePath} | awk '{print $1}'`,
      `elif command -v openssl >/dev/null 2>&1; then ${base}openssl dgst -sha256 ${safePath} | awk '{print $2}'`,
      'else exit 2',
      'fi',
    ].join('; ');
    const result = await this.remoteExec(client, command);
    if (result.exitCode !== 0) {
      return null;
    }
    const hash = result.stdout.trim().toLowerCase();
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      return null;
    }
    return hash;
  }

  private remoteExecWithStdin(
    client: Client,
    command: string,
    stdinContent: string
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    return new Promise((resolve, reject) => {
      client.exec(command, (err, stream) => {
        if (err) {
          reject(err);
          return;
        }

        let stdout = '';
        let stderr = '';

        stream.on('data', (data: Buffer) => {
          stdout += data.toString();
        });
        stream.stderr.on('data', (data: Buffer) => {
          stderr += data.toString();
        });
        stream.on('close', (code: number | null) => {
          resolve({ stdout, stderr, exitCode: code ?? 1 });
        });
        stream.on('error', (streamErr: Error) => {
          reject(streamErr);
        });

        stream.write(stdinContent);
        stream.end();
      });
    });
  }

  private async loadSshKey(keyPath: string): Promise<string> {
    const resolved = keyPath.startsWith('~') ? keyPath.replace('~', os.homedir()) : keyPath;

    try {
      return await readFile(resolved, 'utf-8');
    } catch {
      throw new Error(`Cannot read SSH key at "${resolved}". Check the file path and permissions.`);
    }
  }

  private shellQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  private cleanupBridge(bridge: ActiveBridge): void {
    bridge.closing = true;
    this.clearRetryTimer(bridge);
    try {
      bridge.client.end();
    } catch {
      /* ok */
    }
  }

  private handleSetupFailure(bridge: ActiveBridge, input: BridgeSetupInput, err: unknown): void {
    if (bridge.closing) return;
    const message = err instanceof Error ? err.message : String(err);
    bridge.status = 'error';
    bridge.error = message;
    bridge.lastInput = input;
    this.addLog(bridge, `Setup failed: ${message}`);
    this.scheduleAutoRetry(bridge, message);
  }

  private isTransientBridgeError(message: string): boolean {
    const lowered = message.toLowerCase();
    return (
      lowered.includes('timed out') ||
      lowered.includes('timeout') ||
      lowered.includes('econnreset') ||
      lowered.includes('ehostunreach') ||
      lowered.includes('enotfound') ||
      lowered.includes('network') ||
      lowered.includes('ssh connection closed') ||
      lowered.includes('ssh connection lost') ||
      lowered.includes('sftp')
    );
  }

  private scheduleAutoRetry(bridge: ActiveBridge, reason: string): void {
    if (!this.isTransientBridgeError(reason)) return;
    if (bridge.closing) return;
    if (!bridge.lastInput) return;
    if (bridge.pendingInput) return;
    if (bridge.retryAttempt >= BRIDGE_AUTO_RETRY_MAX_ATTEMPTS) {
      this.addLog(
        bridge,
        `Auto-retry stopped after ${BRIDGE_AUTO_RETRY_MAX_ATTEMPTS} attempts. Please reconnect manually.`
      );
      return;
    }

    this.clearRetryTimer(bridge);
    bridge.retryAttempt += 1;
    const delayMs = Math.min(
      BRIDGE_AUTO_RETRY_BASE_MS * 2 ** (bridge.retryAttempt - 1),
      BRIDGE_AUTO_RETRY_MAX_MS
    );
    this.addLog(
      bridge,
      `Auto-retry ${bridge.retryAttempt}/${BRIDGE_AUTO_RETRY_MAX_ATTEMPTS} in ${Math.round(delayMs / 1000)}s (${reason}).`
    );

    bridge.retryTimer = setTimeout(() => {
      bridge.retryTimer = null;
      if (bridge.closing || !bridge.lastInput) return;
      try {
        bridge.client.end();
      } catch {
        /* noop */
      }
      bridge.client = new Client();
      bridge.status = 'connecting';
      bridge.error = undefined;
      this.addLog(bridge, 'Auto-retry reconnecting bridge...');
      void this.runSetup(bridge, bridge.lastInput).catch((err: unknown) => {
        this.handleSetupFailure(bridge, bridge.lastInput as BridgeSetupInput, err);
      });
    }, delayMs);
  }

  private clearRetryTimer(bridge: ActiveBridge): void {
    if (!bridge.retryTimer) return;
    clearTimeout(bridge.retryTimer);
    bridge.retryTimer = null;
  }

  private resetRetryState(bridge: ActiveBridge): void {
    this.clearRetryTimer(bridge);
    bridge.retryAttempt = 0;
  }

  private addLog(bridge: ActiveBridge, message: string): void {
    const timestamp = new Date().toISOString().slice(11, 19);
    bridge.logs.push(`[${timestamp}] ${message}`);
    if (bridge.logs.length > 200) {
      bridge.logs.splice(0, bridge.logs.length - 200);
    }
  }

  private toState(bridge: ActiveBridge): ManagedBridgeState {
    return Object.freeze({
      id: bridge.id,
      label: bridge.label,
      sshHost: bridge.sshHost,
      sshUser: bridge.sshUser,
      sshPort: bridge.sshPort,
      remotePort: bridge.remotePort,
      status: bridge.status,
      error: bridge.error,
      logs: Object.freeze([...bridge.logs]),
      machineId: bridge.machineId,
      connectedAt: bridge.connectedAt,
      installMode: bridge.installMode,
    });
  }
}
