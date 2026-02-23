import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Client, type SFTPWrapper } from 'ssh2';
import type { BridgeSetupManager } from './bridge-setup-manager.js';

async function loadKnownHostKeys(hostName: string, port: number): Promise<Set<string>> {
  const keys = new Set<string>();
  const knownHostsPath = path.join(os.homedir(), '.ssh', 'known_hosts');
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
    /* known_hosts may not exist */
  }
  return keys;
}

export interface CustomSshConnection {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly keyPath: string;
}

export interface FileConnection {
  readonly id: string;
  readonly label: string;
  readonly type: 'bridge' | 'custom';
  readonly host: string;
  readonly user: string;
  readonly status: 'connected' | 'available' | 'error';
}

interface CachedSession {
  sftp: SFTPWrapper;
  client: Client | null;
  type: 'bridge' | 'custom';
}

const CONNECTIONS_DIR = path.join(os.homedir(), '.patze-control');
const CONNECTIONS_FILE = path.join(CONNECTIONS_DIR, 'ssh-connections.json');

function generateId(): string {
  return `ssh-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export class SftpSessionManager {
  private readonly sessions = new Map<string, CachedSession>();
  private customConnections: CustomSshConnection[] = [];
  private loaded = false;

  constructor(private readonly bridgeManager: BridgeSetupManager) {}

  private async loadConnections(): Promise<void> {
    if (this.loaded) return;
    try {
      const data = await readFile(CONNECTIONS_FILE, 'utf-8');
      this.customConnections = JSON.parse(data) as CustomSshConnection[];
    } catch {
      this.customConnections = [];
    }
    this.loaded = true;
  }

  private async saveConnections(): Promise<void> {
    await mkdir(CONNECTIONS_DIR, { recursive: true, mode: 0o700 });
    await writeFile(CONNECTIONS_FILE, JSON.stringify(this.customConnections, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    try {
      await chmod(CONNECTIONS_FILE, 0o600);
    } catch {
      /* best effort */
    }
  }

  async getConnections(): Promise<FileConnection[]> {
    await this.loadConnections();
    const connections: FileConnection[] = [];

    for (const b of this.bridgeManager.list()) {
      const isActive = b.status === 'running' || b.status === 'telemetry_active';
      connections.push({
        id: `bridge-${b.id}`,
        label: b.label || `${b.sshUser}@${b.sshHost}`,
        type: 'bridge',
        host: b.sshHost,
        user: b.sshUser,
        status: isActive ? 'connected' : 'available',
      });
    }

    for (const c of this.customConnections) {
      const cached = this.sessions.get(c.id);
      connections.push({
        id: c.id,
        label: c.label || `${c.user}@${c.host}`,
        type: 'custom',
        host: c.host,
        user: c.user,
        status: cached ? 'connected' : 'available',
      });
    }

    return connections;
  }

  async addCustomConnection(conn: Omit<CustomSshConnection, 'id'>): Promise<CustomSshConnection> {
    await this.loadConnections();
    const entry: CustomSshConnection = { ...conn, id: generateId() };
    this.customConnections.push(entry);
    await this.saveConnections();
    return entry;
  }

  async removeCustomConnection(id: string): Promise<boolean> {
    await this.loadConnections();
    const idx = this.customConnections.findIndex((c) => c.id === id);
    if (idx < 0) return false;
    this.closeSession(id);
    this.customConnections.splice(idx, 1);
    await this.saveConnections();
    return true;
  }

  async getSftp(connId: string): Promise<SFTPWrapper> {
    const cached = this.sessions.get(connId);
    if (cached) return cached.sftp;

    if (connId.startsWith('bridge-')) {
      return this.openBridgeSftp(connId);
    }
    return this.openCustomSftp(connId);
  }

  private async openBridgeSftp(connId: string): Promise<SFTPWrapper> {
    const bridgeId = connId.replace(/^bridge-/, '');
    const client = this.bridgeManager.getSshClient(bridgeId);
    if (!client) {
      throw new Error(`Bridge ${bridgeId} is not connected`);
    }

    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftpSession) => {
        if (err) return reject(err);
        resolve(sftpSession);
      });
    });

    this.sessions.set(connId, { sftp, client: null, type: 'bridge' });

    sftp.on('close', () => this.sessions.delete(connId));
    sftp.on('error', () => this.sessions.delete(connId));

    return sftp;
  }

  private async openCustomSftp(connId: string): Promise<SFTPWrapper> {
    await this.loadConnections();
    const conn = this.customConnections.find((c) => c.id === connId);
    if (!conn) throw new Error(`Unknown connection: ${connId}`);

    const homeDir = os.homedir();
    const resolvedKey = conn.keyPath.startsWith('~/')
      ? path.join(homeDir, conn.keyPath.slice(2))
      : conn.keyPath;
    const sshDir = path.join(homeDir, '.ssh');
    const normalizedKey = path.resolve(resolvedKey);
    if (!normalizedKey.startsWith(sshDir + path.sep)) {
      throw new Error(`SSH key path must be under ~/.ssh/ — got "${conn.keyPath}"`);
    }

    let privateKey: Buffer;
    try {
      privateKey = await readFile(normalizedKey);
    } catch {
      throw new Error(`Cannot read SSH key: ${conn.keyPath}`);
    }

    const expectedKeys = await loadKnownHostKeys(conn.host, conn.port);

    const client = new Client();

    await new Promise<void>((resolve, reject) => {
      client.on('ready', resolve);
      client.on('error', reject);
      client.connect({
        host: conn.host,
        port: conn.port,
        username: conn.user,
        privateKey,
        readyTimeout: 15_000,
        hostVerifier: (key: Buffer): boolean => {
          const presented = key.toString('base64');
          if (expectedKeys.size === 0) return false;
          return expectedKeys.has(presented);
        },
      });
    });

    const sftp = await new Promise<SFTPWrapper>((resolve, reject) => {
      client.sftp((err, sftpSession) => {
        if (err) {
          client.end();
          return reject(err);
        }
        resolve(sftpSession);
      });
    });

    this.sessions.set(connId, { sftp, client, type: 'custom' });

    client.on('close', () => {
      this.sessions.delete(connId);
    });
    client.on('error', () => {
      this.sessions.delete(connId);
    });

    return sftp;
  }

  closeSession(connId: string): void {
    const cached = this.sessions.get(connId);
    if (!cached) return;
    this.sessions.delete(connId);
    try {
      cached.sftp.end();
    } catch {
      /* ignore */
    }
    if (cached.client) {
      try {
        cached.client.end();
      } catch {
        /* ignore */
      }
    }
  }

  closeAll(): void {
    for (const [id] of this.sessions) {
      this.closeSession(id);
    }
  }
}
