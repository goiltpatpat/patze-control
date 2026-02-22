import fs from 'node:fs';
import path from 'node:path';
import { OpenClawCronSync, type OpenClawSyncStatus } from './openclaw-sync.js';
import type { OpenClawCronJob, OpenClawRunRecord } from './openclaw-reader.js';
import type { ScheduledTask } from './types.js';
import type { MergedCronView } from './openclaw-sync.js';

export interface OpenClawTarget {
  readonly id: string;
  readonly label: string;
  readonly type: 'local' | 'remote';
  readonly openclawDir: string;
  readonly pollIntervalMs: number;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type OpenClawTargetInput = Omit<OpenClawTarget, 'id' | 'createdAt' | 'updatedAt'>;
export type OpenClawTargetPatch = Partial<Omit<OpenClawTarget, 'id' | 'createdAt' | 'updatedAt'>>;

export interface TargetSyncStatusEntry {
  readonly target: OpenClawTarget;
  readonly syncStatus: OpenClawSyncStatus;
}

interface TargetStoreData {
  readonly version: 1;
  readonly targets: readonly OpenClawTarget[];
}

export class OpenClawTargetStore {
  private readonly filePath: string;
  private targets: OpenClawTarget[] = [];

  public constructor(storeDir: string) {
    this.filePath = path.join(storeDir, 'openclaw-targets.json');
    this.load();
  }

  public list(): readonly OpenClawTarget[] {
    return this.targets;
  }

  public get(id: string): OpenClawTarget | undefined {
    return this.targets.find((t) => t.id === id);
  }

  public add(input: OpenClawTargetInput): OpenClawTarget {
    const now = new Date().toISOString();
    const target: OpenClawTarget = {
      id: `oct_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
      label: input.label,
      type: input.type,
      openclawDir: input.openclawDir,
      pollIntervalMs: input.pollIntervalMs,
      enabled: input.enabled,
      createdAt: now,
      updatedAt: now,
    };
    this.targets.push(target);
    this.save();
    return target;
  }

  public update(id: string, patch: OpenClawTargetPatch): OpenClawTarget | null {
    const index = this.targets.findIndex((t) => t.id === id);
    if (index === -1) return null;

    const existing = this.targets[index]!;
    const updated: OpenClawTarget = {
      ...existing,
      ...(patch.label !== undefined ? { label: patch.label } : {}),
      ...(patch.type !== undefined ? { type: patch.type } : {}),
      ...(patch.openclawDir !== undefined ? { openclawDir: patch.openclawDir } : {}),
      ...(patch.pollIntervalMs !== undefined ? { pollIntervalMs: patch.pollIntervalMs } : {}),
      ...(patch.enabled !== undefined ? { enabled: patch.enabled } : {}),
      updatedAt: new Date().toISOString(),
    };
    this.targets[index] = updated;
    this.save();
    return updated;
  }

  public remove(id: string): boolean {
    const before = this.targets.length;
    this.targets = this.targets.filter((t) => t.id !== id);
    if (this.targets.length === before) return false;
    this.save();
    return true;
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const data = JSON.parse(raw) as TargetStoreData;
      if (data.version === 1 && Array.isArray(data.targets)) {
        this.targets = [...data.targets];
      }
    } catch {
      this.targets = [];
    }
  }

  private save(): void {
    const dir = path.dirname(this.filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const data: TargetStoreData = { version: 1, targets: this.targets };
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmpPath, this.filePath);
  }
}

interface SyncInstance {
  sync: OpenClawCronSync;
  target: OpenClawTarget;
}

export interface OpenClawSyncManagerOptions {
  readonly onStatus?: (targetId: string, status: OpenClawSyncStatus) => void;
}

export class OpenClawSyncManager {
  private readonly instances = new Map<string, SyncInstance>();
  private readonly store: OpenClawTargetStore;
  private readonly onStatus: ((targetId: string, status: OpenClawSyncStatus) => void) | undefined;

  public constructor(store: OpenClawTargetStore, options?: OpenClawSyncManagerOptions) {
    this.store = store;
    this.onStatus = options?.onStatus;
  }

  public startAll(): void {
    for (const target of this.store.list()) {
      if (target.enabled) {
        this.startTarget(target);
      }
    }
  }

  public stopAll(): void {
    for (const [, instance] of this.instances) {
      instance.sync.stop();
    }
    this.instances.clear();
  }

  public startTarget(target: OpenClawTarget): void {
    if (this.instances.has(target.id)) return;

    const targetId = target.id;
    const sync = new OpenClawCronSync({
      openclawDir: target.openclawDir,
      pollIntervalMs: target.pollIntervalMs,
      onStatus: (status) => {
        this.onStatus?.(targetId, status);
      },
    });
    sync.start();
    this.instances.set(target.id, { sync, target });
  }

  public stopTarget(targetId: string): void {
    const instance = this.instances.get(targetId);
    if (!instance) return;
    instance.sync.stop();
    this.instances.delete(targetId);
  }

  public restartTarget(target: OpenClawTarget): void {
    this.stopTarget(target.id);
    if (target.enabled) {
      this.startTarget(target);
    }
  }

  public getJobs(targetId: string): readonly OpenClawCronJob[] {
    return this.instances.get(targetId)?.sync.getJobs() ?? [];
  }

  public getRunHistory(
    targetId: string,
    jobId: string,
    limit?: number
  ): readonly OpenClawRunRecord[] {
    return this.instances.get(targetId)?.sync.getRunHistory(jobId, limit) ?? [];
  }

  public getStatus(targetId: string): OpenClawSyncStatus | null {
    return this.instances.get(targetId)?.sync.getStatus() ?? null;
  }

  public getAllStatuses(): readonly TargetSyncStatusEntry[] {
    const result: TargetSyncStatusEntry[] = [];
    for (const target of this.store.list()) {
      const instance = this.instances.get(target.id);
      const syncStatus = instance?.sync.getStatus() ?? {
        running: false,
        available: false,
        pollIntervalMs: target.pollIntervalMs,
        jobsCount: 0,
        lastAttemptAt: undefined,
        lastSuccessfulSyncAt: undefined,
        consecutiveFailures: 0,
        lastError: undefined,
        stale: false,
      };
      result.push({ target, syncStatus });
    }
    return result;
  }

  public createMergedView(
    targetId: string,
    patzeTasks: readonly ScheduledTask[]
  ): MergedCronView | null {
    const instance = this.instances.get(targetId);
    if (!instance) return null;
    return instance.sync.createMergedView(patzeTasks);
  }

  public isRunning(targetId: string): boolean {
    return this.instances.has(targetId);
  }
}
