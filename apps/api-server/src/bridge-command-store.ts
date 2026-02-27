import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type BridgeCommandIntent =
  | 'trigger_job'
  | 'agent_set_enabled'
  | 'approve_request'
  | 'run_command';

export type BridgeCommandState =
  | 'queued'
  | 'leased'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'deadletter';

export interface BridgeCommandSnapshot {
  readonly targetId: string;
  readonly machineId: string;
  readonly targetVersion: string;
  readonly intent: BridgeCommandIntent;
  readonly args: Readonly<Record<string, unknown>>;
  readonly createdBy: string;
  readonly idempotencyKey: string;
  readonly approvalRequired: boolean;
  readonly policyVersion?: string | undefined;
}

export interface BridgeCommandResult {
  readonly status: 'succeeded' | 'failed';
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly artifact?: string | undefined;
  readonly duplicate?: boolean | undefined;
}

export interface BridgeCommandRecord {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: BridgeCommandState;
  readonly leaseOwnerMachineId?: string | undefined;
  readonly leaseUntil?: string | undefined;
  readonly leaseAttempts: number;
  readonly executionAttempts: number;
  readonly approvedAt?: string | undefined;
  readonly approvedBy?: string | undefined;
  readonly rejectedReason?: string | undefined;
  readonly result?: BridgeCommandResult | undefined;
  readonly snapshot: BridgeCommandSnapshot;
}

interface BridgeCommandStoreData {
  readonly version: 1;
  readonly commands: readonly BridgeCommandRecord[];
}

export interface CreateBridgeCommandInput {
  readonly snapshot: BridgeCommandSnapshot;
}

export interface BridgeCommandFilter {
  readonly targetId?: string | undefined;
  readonly machineId?: string | undefined;
  readonly state?: BridgeCommandState | undefined;
  readonly limit?: number | undefined;
}

export interface ApproveBridgeCommandInput {
  readonly commandId: string;
  readonly targetId: string;
  readonly targetVersion: string;
  readonly approvedBy: string;
}

export interface PollBridgeCommandInput {
  readonly machineId: string;
  readonly leaseTtlMs: number;
  readonly nowMs?: number | undefined;
}

const MAX_DEFAULT_LIST = 100;
const DEADLETTER_FAILED_ATTEMPTS = 3;
const DEADLETTER_EXPIRED_ATTEMPTS = 3;

function nowIso(nowMs?: number): string {
  return new Date(nowMs ?? Date.now()).toISOString();
}

function isTerminalState(state: BridgeCommandState): boolean {
  switch (state) {
    case 'succeeded':
    case 'failed':
    case 'rejected':
    case 'deadletter':
      return true;
    case 'queued':
    case 'leased':
    case 'running':
    case 'expired':
      return false;
    default: {
      const _exhaustive: never = state;
      return _exhaustive;
    }
  }
}

function cloneRecord(record: BridgeCommandRecord): BridgeCommandRecord {
  return JSON.parse(JSON.stringify(record)) as BridgeCommandRecord;
}

function generateCommandId(): string {
  return `bcmd_${Date.now().toString(36)}_${crypto.randomUUID().slice(0, 8)}`;
}

export class BridgeCommandStore {
  private readonly filePath: string;
  private commands: BridgeCommandRecord[] = [];

  public constructor(storeDir: string) {
    this.filePath = path.join(storeDir, 'bridge-commands.json');
    this.load();
  }

  public create(input: CreateBridgeCommandInput): BridgeCommandRecord {
    const now = nowIso();
    const record: BridgeCommandRecord = {
      id: generateCommandId(),
      createdAt: now,
      updatedAt: now,
      state: input.snapshot.approvalRequired ? 'queued' : 'queued',
      leaseAttempts: 0,
      executionAttempts: 0,
      snapshot: input.snapshot,
    };
    this.commands.push(record);
    this.save();
    return cloneRecord(record);
  }

  public list(filter?: BridgeCommandFilter): readonly BridgeCommandRecord[] {
    const limit = Math.max(1, Math.min(filter?.limit ?? MAX_DEFAULT_LIST, 500));
    const filtered = this.commands
      .filter((command) => {
        if (filter?.targetId && command.snapshot.targetId !== filter.targetId) return false;
        if (filter?.machineId && command.snapshot.machineId !== filter.machineId) return false;
        if (filter?.state && command.state !== filter.state) return false;
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
    return filtered.map(cloneRecord);
  }

  public get(commandId: string): BridgeCommandRecord | null {
    const found = this.commands.find((command) => command.id === commandId);
    return found ? cloneRecord(found) : null;
  }

  public approve(input: ApproveBridgeCommandInput): BridgeCommandRecord | null {
    const idx = this.commands.findIndex((command) => command.id === input.commandId);
    if (idx === -1) return null;
    const existing = this.commands[idx]!;
    if (existing.snapshot.targetId !== input.targetId) return null;
    if (existing.snapshot.targetVersion !== input.targetVersion) return null;
    if (!existing.snapshot.approvalRequired) return cloneRecord(existing);
    if (isTerminalState(existing.state)) return cloneRecord(existing);

    const now = nowIso();
    const next: BridgeCommandRecord = {
      ...existing,
      state: 'queued',
      approvedAt: now,
      approvedBy: input.approvedBy,
      updatedAt: now,
    };
    this.commands[idx] = next;
    this.save();
    return cloneRecord(next);
  }

  public reject(commandId: string, reason: string): BridgeCommandRecord | null {
    const idx = this.commands.findIndex((command) => command.id === commandId);
    if (idx === -1) return null;
    const existing = this.commands[idx]!;
    if (isTerminalState(existing.state)) return cloneRecord(existing);
    const next: BridgeCommandRecord = {
      ...existing,
      state: 'rejected',
      rejectedReason: reason,
      updatedAt: nowIso(),
    };
    this.commands[idx] = next;
    this.save();
    return cloneRecord(next);
  }

  public poll(input: PollBridgeCommandInput): BridgeCommandRecord | null {
    const nowMs = input.nowMs ?? Date.now();
    this.expireLeases(nowMs);
    const now = nowIso(nowMs);

    const candidateIndex = this.commands.findIndex((command) => {
      if (command.snapshot.machineId !== input.machineId) return false;
      if (command.state !== 'queued' && command.state !== 'expired') return false;
      if (command.snapshot.approvalRequired && !command.approvedAt) return false;
      return true;
    });
    if (candidateIndex === -1) {
      return null;
    }

    const existing = this.commands[candidateIndex]!;
    const leaseUntil = nowIso(nowMs + input.leaseTtlMs);
    const next: BridgeCommandRecord = {
      ...existing,
      state: 'leased',
      leaseOwnerMachineId: input.machineId,
      leaseUntil,
      leaseAttempts: existing.leaseAttempts + 1,
      updatedAt: now,
    };
    this.commands[candidateIndex] = next;
    this.save();
    return cloneRecord(next);
  }

  public ackRunning(commandId: string, machineId: string): BridgeCommandRecord | null {
    const idx = this.commands.findIndex((command) => command.id === commandId);
    if (idx === -1) return null;
    const existing = this.commands[idx]!;
    if (existing.snapshot.machineId !== machineId) return null;
    if (existing.state !== 'leased' && existing.state !== 'running') return null;
    if (existing.leaseOwnerMachineId && existing.leaseOwnerMachineId !== machineId) return null;
    const next: BridgeCommandRecord = {
      ...existing,
      state: 'running',
      leaseOwnerMachineId: machineId,
      executionAttempts: existing.executionAttempts + (existing.state === 'running' ? 0 : 1),
      updatedAt: nowIso(),
    };
    this.commands[idx] = next;
    this.save();
    return cloneRecord(next);
  }

  public renewLease(
    commandId: string,
    machineId: string,
    leaseTtlMs: number
  ): BridgeCommandRecord | null {
    const idx = this.commands.findIndex((command) => command.id === commandId);
    if (idx === -1) return null;
    const existing = this.commands[idx]!;
    if (existing.leaseOwnerMachineId !== machineId) return null;
    if (existing.state !== 'leased' && existing.state !== 'running') return null;
    const now = Date.now();
    const next: BridgeCommandRecord = {
      ...existing,
      leaseUntil: nowIso(now + leaseTtlMs),
      updatedAt: nowIso(now),
    };
    this.commands[idx] = next;
    this.save();
    return cloneRecord(next);
  }

  public pushResult(
    commandId: string,
    machineId: string,
    result: BridgeCommandResult
  ): BridgeCommandRecord | null {
    const idx = this.commands.findIndex((command) => command.id === commandId);
    if (idx === -1) return null;
    const existing = this.commands[idx]!;
    if (existing.snapshot.machineId !== machineId) return null;
    if (existing.state === 'succeeded' || existing.state === 'failed') {
      return cloneRecord(existing);
    }
    if (existing.state !== 'running' && existing.state !== 'leased') return null;
    if (existing.leaseOwnerMachineId && existing.leaseOwnerMachineId !== machineId) return null;
    const next: BridgeCommandRecord = {
      ...existing,
      state: result.status,
      leaseOwnerMachineId: machineId,
      leaseUntil: undefined,
      result,
      updatedAt: nowIso(),
    };
    this.commands[idx] = next;
    this.save();
    return cloneRecord(next);
  }

  private expireLeases(nowMs: number): void {
    let changed = false;
    for (let index = 0; index < this.commands.length; index += 1) {
      const command = this.commands[index]!;
      if (command.state !== 'leased' && command.state !== 'running') continue;
      if (!command.leaseUntil) continue;
      if (Date.parse(command.leaseUntil) > nowMs) continue;

      const expireCount = command.leaseAttempts;
      const shouldDeadletter =
        command.executionAttempts >= DEADLETTER_FAILED_ATTEMPTS ||
        expireCount >= DEADLETTER_EXPIRED_ATTEMPTS;
      const next: BridgeCommandRecord = {
        ...command,
        state: shouldDeadletter ? 'deadletter' : 'expired',
        leaseOwnerMachineId: undefined,
        leaseUntil: undefined,
        updatedAt: nowIso(nowMs),
      };
      this.commands[index] = next;
      changed = true;
    }
    if (changed) {
      this.save();
    }
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) {
        return;
      }
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as BridgeCommandStoreData;
      if (parsed.version !== 1 || !Array.isArray(parsed.commands)) {
        this.commands = [];
        return;
      }
      this.commands = parsed.commands.map((command) => cloneRecord(command));
    } catch {
      this.commands = [];
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const payload: BridgeCommandStoreData = {
      version: 1,
      commands: this.commands,
    };
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }
}
