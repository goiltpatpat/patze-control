import { readFile, writeFile, mkdir } from 'node:fs/promises';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { Client } from 'ssh2';
import { resolveSshConfig } from './ssh-config-parser.js';

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
}

interface EffectiveSshConfig {
  readonly host: string;
  readonly user: string;
  readonly port: number;
  readonly keyPath: string;
  readonly mode: 'alias' | 'explicit';
  readonly alias?: string | undefined;
}

export interface BridgePreflightResult {
  readonly ok: boolean;
  readonly mode: 'alias' | 'explicit';
  readonly sshHost: string;
  readonly sshUser: string;
  readonly sshPort: number;
  readonly message: string;
}

const SSH_CONNECT_TIMEOUT_MS = 15_000;
const TELEMETRY_VERIFY_TIMEOUT_MS = 30_000;
const TELEMETRY_VERIFY_INTERVAL_MS = 2_000;
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
    };

    this.bridges.set(id, bridge);
    this.addLog(bridge, `Starting bridge setup to ${input.sshUser}@${input.sshHost}...`);

    void this.runSetup(bridge, input).catch((err: unknown) => {
      if (!bridge.closing) {
        bridge.status = 'error';
        bridge.error = err instanceof Error ? err.message : String(err);
        this.addLog(bridge, `Setup failed: ${bridge.error}`);
      }
    });

    return this.toState(bridge);
  }

  async preflight(input: BridgeSetupInput): Promise<BridgePreflightResult> {
    const effective = await this.resolveEffectiveSsh(input);
    if (!isPathUnderSshDir(effective.keyPath)) {
      throw new Error(`SSH key path must be under ~/.ssh/ — got "${effective.keyPath}"`);
    }

    const client = new Client();
    try {
      const privateKey = await this.loadSshKey(effective.keyPath);
      const acceptedNewKey = await this.connectClient(client, effective, privateKey, true);

      const result = await this.remoteExec(client, 'echo ok');
      if (result.exitCode !== 0 || result.stdout !== 'ok\n') {
        throw new Error('SSH pre-flight check failed (echo ok mismatch).');
      }

      const warning = acceptedNewKey
        ? `New host key accepted and saved for ${effective.host}:${effective.port}. Verify the fingerprint for production use.`
        : undefined;

      return {
        ok: true,
        mode: effective.mode,
        sshHost: effective.host,
        sshUser: effective.user,
        sshPort: effective.port,
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
    const { client } = bridge;
    const effective = await this.resolveEffectiveSsh(input);

    if (!isPathUnderSshDir(effective.keyPath)) {
      throw new Error(`SSH key path must be under ~/.ssh/ — got "${effective.keyPath}"`);
    }

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
    const privateKey = await this.loadSshKey(effective.keyPath);
    const acceptedNewKey = await this.connectClient(client, effective, privateKey, true);
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
    const preflight = await this.remoteExec(client, 'echo ok');
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
    } else {
      bridge.status = 'tunnel_open';
      this.addLog(bridge, 'Reverse tunnel is open. Bridge can connect through it.');
      this.addLog(
        bridge,
        'If the bridge is not installed on VPS, install it manually or wait for data to flow.'
      );
    }

    client.on('close', () => {
      if (!bridge.closing) {
        bridge.status = 'error';
        bridge.error = 'SSH connection closed unexpectedly';
        this.addLog(bridge, 'SSH connection lost.');
      }
    });

    client.on('error', (err: Error) => {
      if (!bridge.closing) {
        bridge.status = 'error';
        bridge.error = err.message;
        this.addLog(bridge, `SSH error: ${err.message}`);
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
    privateKey: string,
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
        privateKey,
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
      this.addLog(bridge, 'Bridge service already running on VPS. Restarting with new config...');
      bridge.installMode = 'system';
      await this.remoteWriteConfig(bridge, input);
      await this.remoteExec(client, 'sudo systemctl restart patze-bridge');
      return 'already_running';
    }

    const userServiceActive = await this.remoteExec(
      client,
      'systemctl --user is-active --quiet patze-bridge 2>/dev/null'
    );
    if (userServiceActive.exitCode === 0) {
      this.addLog(bridge, 'Bridge user service already running. Restarting with new config...');
      bridge.installMode = 'user';
      await this.remoteWriteConfig(bridge, input);
      await this.remoteExec(client, 'systemctl --user restart patze-bridge');
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
    const extraFlags = privilege === 'no_sudo' ? '--user-mode' : '';
    if (privilege === 'no_sudo') {
      bridge.installMode = 'user';
      this.addLog(bridge, 'Installing bridge (user-level, no sudo required)...');
    } else {
      bridge.installMode = 'system';
      this.addLog(bridge, 'Installing bridge (system-level)...');
    }

    return this.runInstallScript(bridge, input, extraFlags);
  }

  private async runInstallScript(
    bridge: ActiveBridge,
    input: BridgeSetupInput,
    extraFlags: string,
    stdinPrefix?: string
  ): Promise<'installed' | 'skipped'> {
    try {
      const scriptContent = await readFile(this.installScriptPath!, 'utf-8');
      const cmdArgs = this.buildInstallArgs(input, extraFlags);
      const fullStdin = stdinPrefix ? stdinPrefix + '\n' + scriptContent : scriptContent;

      const result = await this.remoteExecWithStdin(
        bridge.client,
        `bash -s -- ${cmdArgs}`,
        fullStdin
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

    bridge.status = 'installing';
    bridge.installMode = 'system';
    this.addLog(bridge, 'Retrying install with sudo password...');

    const result = await this.runInstallScript(
      bridge,
      bridge.pendingInput,
      '--sudo-pass',
      password
    );
    bridge.pendingInput = undefined;

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

    const result = await this.runInstallScript(bridge, bridge.pendingInput, '--user-mode');
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
    } else {
      bridge.status = 'tunnel_open';
      this.addLog(bridge, 'Reverse tunnel is open. Bridge can connect through it.');
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

  private async remoteWriteConfig(bridge: ActiveBridge, input: BridgeSetupInput): Promise<void> {
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
    const cmd = `${writeCmd} << 'PATZE_EOF'\n${configContent}\nPATZE_EOF`;
    const result = await this.remoteExec(bridge.client, cmd);
    if (result.exitCode !== 0) {
      this.addLog(bridge, `Config update failed: ${result.stderr}`);
    }
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
    command: string
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
      });
    });
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
    try {
      bridge.client.end();
    } catch {
      /* ok */
    }
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
