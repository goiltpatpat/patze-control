import { readFile } from 'node:fs/promises';
import net, { type AddressInfo } from 'node:net';
import { Client, type ClientChannel, type ConnectConfig } from 'ssh2';
import type { MachineEndpoint, SshConfig } from '@patze/telemetry-core';

export interface TunnelInfo {
  endpointId: string;
  label: string;
  localHost: string;
  localPort: number;
  localBaseUrl: string;
  remoteHost: string;
  remotePort: number;
  openedAt: string;
}

interface KnownHostEntry {
  hosts: readonly string[];
  keyBase64: string;
}

interface TunnelHandle {
  endpointId: string;
  endpoint: MachineEndpoint;
  remoteHost: string;
  remotePort: number;
  localHost: string;
  localPort: number;
  openedAt: string;
  server: net.Server;
  client: Client;
  closing: boolean;
}

export type TunnelClosedListener = (endpointId: string) => void;

function assertSshConfig(endpoint: MachineEndpoint): SshConfig {
  if (!endpoint.ssh) {
    throw new Error(`SSH config is required for endpoint '${endpoint.id}'.`);
  }

  return endpoint.ssh;
}

function parseRemoteTarget(baseUrl: string): { host: string; port: number } {
  const url = new URL(baseUrl);

  const host = url.hostname;
  const port = url.port.length > 0
    ? Number(url.port)
    : url.protocol === 'https:'
      ? 443
      : 80;

  if (!host) {
    throw new Error(`Invalid endpoint baseUrl: ${baseUrl}`);
  }

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new Error(`Invalid endpoint baseUrl port: ${baseUrl}`);
  }

  return { host, port };
}

function normalizeKnownHostPattern(pattern: string): string {
  return pattern.trim();
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wildcardToRegex(pattern: string): RegExp {
  const escaped = escapeRegex(pattern)
    .replace(/\\\*/g, '.*')
    .replace(/\\\?/g, '.');

  return new RegExp(`^${escaped}$`);
}

function hostPatternMatches(patternRaw: string, host: string, port: number): boolean {
  const pattern = normalizeKnownHostPattern(patternRaw);
  if (pattern.length === 0) {
    return false;
  }

  if (pattern.startsWith('|')) {
    return false;
  }

  if (pattern.startsWith('[')) {
    const closed = pattern.indexOf(']');
    if (closed <= 0) {
      return false;
    }

    const bracketHost = pattern.slice(1, closed);
    const portPart = pattern.slice(closed + 1);
    if (!portPart.startsWith(':')) {
      return false;
    }

    const patternPort = Number(portPart.slice(1));
    if (!Number.isInteger(patternPort)) {
      return false;
    }

    return wildcardToRegex(bracketHost).test(host) && patternPort === port;
  }

  if (port !== 22) {
    return false;
  }

  return wildcardToRegex(pattern).test(host);
}

function parseKnownHosts(content: string): KnownHostEntry[] {
  const entries: KnownHostEntry[] = [];
  const lines = content.split(/\r?\n/);

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) {
      continue;
    }

    const parts = trimmed.split(/\s+/);
    if (parts.length < 3) {
      continue;
    }

    const offset = parts[0]?.startsWith('@') ? 1 : 0;
    if (parts.length < 3 + offset) {
      continue;
    }

    const hostsField = parts[offset];
    const keyBase64 = parts[offset + 2];
    if (!hostsField || !keyBase64) {
      continue;
    }

    entries.push({
      hosts: hostsField.split(',').map((hostPattern) => hostPattern.trim()).filter(Boolean),
      keyBase64,
    });
  }

  return entries;
}

async function loadKnownHostKeySet(
  knownHostsPath: string,
  host: string,
  port: number
): Promise<Set<string>> {
  const text = await readFile(knownHostsPath, 'utf8');
  const entries = parseKnownHosts(text);

  const keySet = new Set<string>();
  for (const entry of entries) {
    const matches = entry.hosts.some((hostPattern) => hostPatternMatches(hostPattern, host, port));
    if (matches) {
      keySet.add(entry.keyBase64);
    }
  }

  return keySet;
}

const SSH_CONNECT_TIMEOUT_MS = 10_000;

function connectSsh(config: ConnectConfig): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const client = new Client();
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        client.end();
        reject(new Error(`SSH connection timed out after ${String(SSH_CONNECT_TIMEOUT_MS)}ms`));
      }
    }, SSH_CONNECT_TIMEOUT_MS);

    const cleanup = (): void => {
      clearTimeout(timer);
      client.off('ready', onReady);
      client.off('error', onError);
    };

    const onReady = (): void => {
      if (settled) { return; }
      settled = true;
      cleanup();
      resolve(client);
    };

    const onError = (error: Error): void => {
      if (settled) { return; }
      settled = true;
      cleanup();
      reject(error);
    };

    client.once('ready', onReady);
    client.once('error', onError);
    client.connect({ ...config, readyTimeout: SSH_CONNECT_TIMEOUT_MS });
  });
}

function createForwardServer(
  client: Client,
  remoteHost: string,
  remotePort: number
): Promise<net.Server> {
  return new Promise<net.Server>((resolve, reject) => {
    const server = net.createServer((socket) => {
      const sourceHost = socket.remoteAddress ?? '127.0.0.1';
      const sourcePort = socket.remotePort ?? 0;

      client.forwardOut(
        sourceHost,
        sourcePort,
        remoteHost,
        remotePort,
        (error: Error | undefined, stream: ClientChannel) => {
        if (error || !stream) {
          socket.destroy(error ?? undefined);
          return;
        }

        socket.pipe(stream);
        stream.pipe(socket);

        const destroyBoth = (): void => {
          socket.destroy();
          stream.destroy();
        };

        socket.on('error', destroyBoth);
        stream.on('error', destroyBoth);
        }
      );
    });

    server.once('error', (error) => {
      reject(error);
    });

    server.listen(0, '127.0.0.1', () => {
      resolve(server);
    });
  });
}

function closeServer(server: net.Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

export class SshTunnelRuntime {
  private readonly tunnels = new Map<string, TunnelHandle>();

  private readonly closedListeners = new Set<TunnelClosedListener>();

  public onTunnelClosed(listener: TunnelClosedListener): () => void {
    this.closedListeners.add(listener);
    return (): void => {
      this.closedListeners.delete(listener);
    };
  }

  private emitTunnelClosed(endpointId: string): void {
    for (const listener of this.closedListeners) {
      listener(endpointId);
    }
  }

  public async openTunnel(endpoint: MachineEndpoint): Promise<TunnelInfo> {
    if (!endpoint.baseUrl) {
      throw new Error(`Endpoint '${endpoint.id}' requires baseUrl for tunnel forwarding.`);
    }

    const existing = this.tunnels.get(endpoint.id);
    if (existing) {
      return this.toTunnelInfo(existing);
    }

    const ssh = assertSshConfig(endpoint);
    const expectedHostKeys = await loadKnownHostKeySet(ssh.knownHostsPath, ssh.host, ssh.port);

    if (expectedHostKeys.size === 0) {
      throw new Error(
        `No matching host key found in known_hosts for ${ssh.host}:${String(ssh.port)}.`
      );
    }

    const privateKey = await readFile(ssh.privateKeyPath, 'utf8');
    const remoteTarget = parseRemoteTarget(endpoint.baseUrl);

    const client = await connectSsh({
      host: ssh.host,
      port: ssh.port,
      username: ssh.user,
      privateKey,
      hostVerifier: (key: Buffer): boolean => {
        const presented = key.toString('base64');
        return expectedHostKeys.has(presented);
      },
    });

    try {
      const server = await createForwardServer(client, remoteTarget.host, remoteTarget.port);
      const address = server.address();

      if (!address || typeof address === 'string') {
        throw new Error('Could not resolve local forwarded port.');
      }

      const localAddress = address as AddressInfo;
      const handle: TunnelHandle = {
        endpointId: endpoint.id,
        endpoint,
        remoteHost: remoteTarget.host,
        remotePort: remoteTarget.port,
        localHost: localAddress.address,
        localPort: localAddress.port,
        openedAt: new Date().toISOString(),
        server,
        client,
        closing: false,
      };

      client.on('close', () => {
        void this.closeTunnel(endpoint.id);
      });
      client.on('error', () => {
        void this.closeTunnel(endpoint.id);
      });

      this.tunnels.set(endpoint.id, handle);
      return this.toTunnelInfo(handle);
    } catch (error) {
      client.end();
      throw error;
    }
  }

  public async closeTunnel(endpointId: string): Promise<void> {
    const handle = this.tunnels.get(endpointId);
    if (!handle) {
      return;
    }

    if (handle.closing) {
      return;
    }
    handle.closing = true;

    this.tunnels.delete(endpointId);
    await closeServer(handle.server);
    handle.client.end();
    this.emitTunnelClosed(endpointId);
  }

  public listTunnels(): readonly TunnelInfo[] {
    return Object.freeze(
      Array.from(this.tunnels.values())
        .map((handle) => this.toTunnelInfo(handle))
        .sort((left, right) => left.endpointId.localeCompare(right.endpointId))
    );
  }

  private toTunnelInfo(handle: TunnelHandle): TunnelInfo {
    return Object.freeze({
      endpointId: handle.endpointId,
      label: handle.endpoint.label,
      localHost: handle.localHost,
      localPort: handle.localPort,
      localBaseUrl: `http://${handle.localHost}:${String(handle.localPort)}`,
      remoteHost: handle.remoteHost,
      remotePort: handle.remotePort,
      openedAt: handle.openedAt,
    });
  }
}
