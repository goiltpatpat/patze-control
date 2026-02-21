import os from 'node:os';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { MachineId } from '@patze/telemetry-core';
import type { BridgeSourceMode } from './types.js';

export interface BridgeConfig {
  controlPlaneBaseUrl: string;
  controlPlaneToken?: string;
  machineId: MachineId;
  machineLabel: string;
  machineKind: 'local' | 'vps';
  sourceMode: BridgeSourceMode;
  sessionDir: string;
  openclawBin: string;
  openclawArgs: readonly string[];
  heartbeatIntervalMs: number;
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

export async function loadBridgeConfigFromEnv(): Promise<BridgeConfig> {
  const hostname = os.hostname();
  const controlPlaneBaseUrl = process.env.CONTROL_PLANE_BASE_URL ?? 'http://127.0.0.1:8080';
  const machineIdFile = path.join(os.homedir(), '.patze-control', 'machine-id');

  const machineId = process.env.MACHINE_ID
    ? asMachineId(process.env.MACHINE_ID)
    : await ensurePersistedMachineId(machineIdFile);

  return {
    controlPlaneBaseUrl,
    ...(process.env.CONTROL_PLANE_TOKEN
      ? { controlPlaneToken: process.env.CONTROL_PLANE_TOKEN }
      : {}),
    machineId,
    machineLabel: process.env.MACHINE_LABEL ?? hostname,
    machineKind: normalizeMachineKind(process.env.MACHINE_KIND),
    sourceMode: normalizeSourceMode(process.env.OPENCLAW_BRIDGE_SOURCE),
    sessionDir: expandHome(process.env.OPENCLAW_SESSION_DIR ?? '~/.openclaw/sessions'),
    openclawBin: process.env.OPENCLAW_BIN ?? 'openclaw',
    openclawArgs: parseCliArgs(process.env.OPENCLAW_CLI_ARGS),
    heartbeatIntervalMs: normalizeIntervalMs(process.env.HEARTBEAT_INTERVAL_MS),
  };
}
