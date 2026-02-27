import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { MachineId } from '@patze/telemetry-core';
import type { BridgeSourceMode } from './types.js';

export interface BridgeConfig {
  controlPlaneBaseUrl: string;
  controlPlaneToken?: string;
  bridgeVersion: string;
  machineId: MachineId;
  machineIdFile: string;
  machineLabel: string;
  machineKind: 'local' | 'vps';
  sourceMode: BridgeSourceMode;
  openclawHomeDir: string;
  sessionDir: string;
  openclawBin: string;
  openclawArgs: readonly string[];
  heartbeatIntervalMs: number;
  cronSyncPath: string;
  cronSyncIntervalMs: number;
  cronOffsetStateFile: string;
  controlPollPath: string;
  controlAckPathTemplate: string;
  controlHeartbeatPathTemplate: string;
  controlResultPathTemplate: string;
  controlPollIntervalMs: number;
  controlLeaseTtlMs: number;
  controlReceiptStateFile: string;
  telemetrySpoolEnabled: boolean;
  telemetrySpoolFile: string;
  healthHost: string;
  healthPort: number;
  tokenExpiresAt?: string;
}

function parseEnvLine(line: string): { key: string; value: string } | null {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.startsWith('#')) return null;
  const equalsAt = trimmed.indexOf('=');
  if (equalsAt <= 0) return null;
  const key = trimmed.slice(0, equalsAt).trim();
  if (key.length === 0) return null;
  const value = trimmed.slice(equalsAt + 1).trim();
  return { key, value };
}

export async function loadBridgeConfigFileIntoEnv(configFile: string): Promise<void> {
  const content = await readFile(configFile, 'utf8');
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const parsed = parseEnvLine(line);
    if (!parsed) continue;
    process.env[parsed.key] = parsed.value;
  }
}

function asMachineId(value: string): MachineId {
  return value as MachineId;
}

function expandHome(value: string): string {
  if (!value.startsWith('~/')) {
    return value;
  }
  return path.join(os.homedir(), value.slice(2));
}

function normalizeIntervalMs(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : 5000;
  if (!Number.isFinite(parsed) || parsed < 1000) {
    return 5000;
  }
  return Math.floor(parsed);
}

function normalizeCronIntervalMs(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : 30_000;
  if (!Number.isFinite(parsed) || parsed < 5000) {
    return 30_000;
  }
  return Math.floor(parsed);
}

function normalizeMachineKind(raw: string | undefined): 'local' | 'vps' {
  return raw === 'vps' ? 'vps' : 'local';
}

function normalizeSourceMode(raw: string | undefined): BridgeSourceMode {
  return raw === 'cli' ? 'cli' : 'files';
}

function parseCliArgs(raw: string | undefined): readonly string[] {
  if (!raw || raw.trim().length === 0) {
    return ['runs', '--json'];
  }

  return raw
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function generateMachineId(): MachineId {
  return asMachineId(`machine_${crypto.randomUUID()}`);
}

async function ensurePersistedMachineId(pathname: string): Promise<MachineId> {
  try {
    const existing = (await readFile(pathname, 'utf8')).trim();
    if (existing.length > 0) {
      return asMachineId(existing);
    }
  } catch {
    // no-op
  }

  const next = generateMachineId();
  await mkdir(path.dirname(pathname), { recursive: true });
  await writeFile(pathname, `${next}\n`, 'utf8');
  return next;
}

function normalizeCronSyncPath(raw: string | undefined): string {
  if (!raw || raw.trim().length === 0) {
    return '/openclaw/bridge/cron-sync';
  }
  if (!raw.startsWith('/')) {
    return `/${raw}`;
  }
  return raw;
}

function normalizeControlPath(raw: string | undefined, fallback: string): string {
  if (!raw || raw.trim().length === 0) return fallback;
  if (!raw.startsWith('/')) return `/${raw}`;
  return raw;
}

function normalizeControlIntervalMs(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : 5_000;
  if (!Number.isFinite(parsed) || parsed < 1_000) return 5_000;
  return Math.floor(parsed);
}

function normalizeControlLeaseTtlMs(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : 30_000;
  if (!Number.isFinite(parsed) || parsed < 5_000) return 30_000;
  return Math.floor(parsed);
}

function normalizeHealthHost(raw: string | undefined): string {
  const next = (raw ?? '127.0.0.1').trim();
  return next.length > 0 ? next : '127.0.0.1';
}

function normalizeHealthPort(raw: string | undefined): number {
  const parsed = raw ? Number(raw) : 19701;
  if (!Number.isFinite(parsed)) return 19701;
  if (parsed <= 0) return 0;
  if (parsed > 65535) return 19701;
  return Math.floor(parsed);
}

function normalizeBoolean(raw: string | undefined, fallback: boolean): boolean {
  if (!raw) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return fallback;
}

function resolveTokenExpiresAt(raw: string | undefined): string | undefined {
  if (!raw || raw.trim().length === 0) {
    return undefined;
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('TOKEN_EXPIRES_AT must be a valid ISO-8601 timestamp.');
  }
  const iso = parsed.toISOString();
  if (Date.now() >= parsed.getTime()) {
    throw new Error(`Bridge token expired at ${iso}. Refusing to start.`);
  }
  return iso;
}

export async function loadBridgeConfigFromEnv(): Promise<BridgeConfig> {
  const hostname = os.hostname();
  const stateDir = expandHome(process.env.BRIDGE_STATE_DIR ?? '~/.patze-control');
  const controlPlaneBaseUrl = process.env.CONTROL_PLANE_BASE_URL ?? 'http://127.0.0.1:19700';
  const machineIdFile = expandHome(
    process.env.MACHINE_ID_FILE ??
      process.env.BRIDGE_MACHINE_ID_FILE ??
      path.join(stateDir, 'machine-id')
  );
  const tokenExpiresAt = resolveTokenExpiresAt(process.env.TOKEN_EXPIRES_AT);

  const machineId = process.env.MACHINE_ID
    ? asMachineId(process.env.MACHINE_ID)
    : await ensurePersistedMachineId(machineIdFile);

  return {
    controlPlaneBaseUrl,
    ...(process.env.CONTROL_PLANE_TOKEN
      ? { controlPlaneToken: process.env.CONTROL_PLANE_TOKEN }
      : {}),
    bridgeVersion: process.env.BRIDGE_VERSION ?? '0.1.0',
    machineId,
    machineIdFile,
    machineLabel: process.env.MACHINE_LABEL ?? hostname,
    machineKind: normalizeMachineKind(process.env.MACHINE_KIND),
    sourceMode: normalizeSourceMode(process.env.OPENCLAW_BRIDGE_SOURCE),
    openclawHomeDir: expandHome(process.env.OPENCLAW_HOME ?? '~/.openclaw'),
    sessionDir: expandHome(process.env.OPENCLAW_SESSION_DIR ?? '~/.openclaw/sessions'),
    openclawBin: process.env.OPENCLAW_BIN ?? 'openclaw',
    openclawArgs: parseCliArgs(process.env.OPENCLAW_CLI_ARGS),
    heartbeatIntervalMs: normalizeIntervalMs(process.env.HEARTBEAT_INTERVAL_MS),
    cronSyncPath: normalizeCronSyncPath(process.env.CRON_SYNC_PATH),
    cronSyncIntervalMs: normalizeCronIntervalMs(process.env.CRON_SYNC_INTERVAL_MS),
    cronOffsetStateFile: expandHome(
      process.env.BRIDGE_CRON_OFFSET_FILE ?? path.join(stateDir, 'cron-offsets.json')
    ),
    controlPollPath: normalizeControlPath(
      process.env.BRIDGE_CONTROL_POLL_PATH,
      '/openclaw/bridge/commands/poll'
    ),
    controlAckPathTemplate: normalizeControlPath(
      process.env.BRIDGE_CONTROL_ACK_PATH_TEMPLATE,
      '/openclaw/bridge/commands/{commandId}/ack'
    ),
    controlHeartbeatPathTemplate: normalizeControlPath(
      process.env.BRIDGE_CONTROL_HEARTBEAT_PATH_TEMPLATE,
      '/openclaw/bridge/commands/{commandId}/heartbeat'
    ),
    controlResultPathTemplate: normalizeControlPath(
      process.env.BRIDGE_CONTROL_RESULT_PATH_TEMPLATE,
      '/openclaw/bridge/commands/{commandId}/result'
    ),
    controlPollIntervalMs: normalizeControlIntervalMs(process.env.BRIDGE_CONTROL_POLL_INTERVAL_MS),
    controlLeaseTtlMs: normalizeControlLeaseTtlMs(process.env.BRIDGE_CONTROL_LEASE_TTL_MS),
    controlReceiptStateFile: expandHome(
      process.env.BRIDGE_CONTROL_RECEIPTS_FILE ??
        path.join(stateDir, 'bridge-control-receipts.json')
    ),
    telemetrySpoolEnabled: normalizeBoolean(process.env.BRIDGE_TELEMETRY_SPOOL_ENABLED, true),
    telemetrySpoolFile: expandHome(
      process.env.BRIDGE_TELEMETRY_SPOOL_FILE ?? path.join(stateDir, 'telemetry-spool.json')
    ),
    healthHost: normalizeHealthHost(process.env.BRIDGE_HEALTH_HOST),
    healthPort: normalizeHealthPort(process.env.BRIDGE_HEALTH_PORT),
    ...(tokenExpiresAt ? { tokenExpiresAt } : {}),
  };
}
