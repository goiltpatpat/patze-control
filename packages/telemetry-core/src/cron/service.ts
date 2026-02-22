import { AsyncLock } from './lock.js';
import { computeNextRunMs } from './schedule.js';
import { TaskSnapshotStore, type TaskSnapshot } from './snapshot.js';
import { TaskStore } from './store.js';
import type {
  ScheduledTask,
  TaskCreateInput,
  TaskPatchInput,
  TaskRunRecord,
  TaskStoreData,
} from './types.js';
import { BACKOFF_STEPS_MS, DEFAULT_TIMEOUT_MS, MAX_TIMER_DELAY_MS } from './types.js';

export type TaskExecutor = (task: ScheduledTask) => Promise<{ ok: boolean; error?: string }>;

export type TaskEventKind =
  | 'task:created'
  | 'task:updated'
  | 'task:removed'
  | 'task:started'
  | 'task:completed'
  | 'task:error';

export interface TaskEvent {
  readonly kind: TaskEventKind;
  readonly taskId: string;
  readonly task?: ScheduledTask;
  readonly run?: TaskRunRecord;
  readonly ts: string;
}

export type TaskEventListener = (event: TaskEvent) => void;

export interface CronServiceOptions {
  readonly storeDir: string;
  readonly executor: TaskExecutor;
  readonly maxConcurrentRuns?: number;
  readonly onTaskUpdate?: (tasks: readonly ScheduledTask[]) => void;
  readonly onTaskEvent?: TaskEventListener;
}

export class CronService {
  private readonly store: TaskStore;
  private readonly snapshots: TaskSnapshotStore;
  private readonly executor: TaskExecutor;
  private readonly lock = new AsyncLock();
  private readonly maxConcurrentRuns: number;
  private readonly onTaskUpdate: ((tasks: readonly ScheduledTask[]) => void) | undefined;
  private readonly onTaskEvent: TaskEventListener | undefined;
  private tasks: ScheduledTask[] = [];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private activeRunCount = 0;

  public constructor(options: CronServiceOptions) {
    this.store = new TaskStore(options.storeDir);
    this.snapshots = new TaskSnapshotStore(options.storeDir);
    this.executor = options.executor;
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? 3;
    this.onTaskUpdate = options.onTaskUpdate;
    this.onTaskEvent = options.onTaskEvent;
  }

  public async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    await this.lock.run(() => {
      const data = this.store.load();
      this.tasks = [...data.tasks].map((t) => {
        if (t.status === 'running') {
          return { ...t, status: 'enabled' as const, updatedAt: new Date().toISOString() };
        }
        return t;
      });
      this.recomputeAllNextRuns();
      this.persist();
    });

    await this.catchUpMissedJobs();
    this.armTimer();
  }

  public stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public list(): readonly ScheduledTask[] {
    return this.tasks;
  }

  public getRunHistory(taskId?: string): readonly TaskRunRecord[] {
    return this.store.loadRunHistory(taskId);
  }

  public async add(input: TaskCreateInput): Promise<ScheduledTask> {
    return this.lock.run(() => {
      this.snapshot('add', `Add task: ${input.name}`);
      const now = new Date().toISOString();
      const nextMs = computeNextRunMs(input.schedule);
      const task: ScheduledTask = {
        id: input.id ?? generateId(),
        name: input.name,
        description: input.description ?? undefined,
        schedule: input.schedule,
        action: input.action,
        status: 'enabled',
        createdAt: now,
        updatedAt: now,
        lastRunAt: undefined,
        lastRunStatus: undefined,
        lastRunError: undefined,
        consecutiveErrors: 0,
        totalRuns: 0,
        timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        nextRunAtMs: nextMs ?? undefined,
      };
      this.tasks.push(task);
      this.persist();
      this.emitEvent({ kind: 'task:created', taskId: task.id, task, ts: now });
      this.armTimer();
      return task;
    });
  }

  public async update(taskId: string, patch: TaskPatchInput): Promise<ScheduledTask | null> {
    return this.lock.run(() => {
      const idx = this.tasks.findIndex((t) => t.id === taskId);
      if (idx === -1) return null;

      this.snapshot('update', `Update task: ${this.tasks[idx]!.name}`);
      const existing = this.tasks[idx]!;
      const merged = { ...existing, ...filterDefined(patch), updatedAt: new Date().toISOString() };

      if (patch.schedule) {
        const nextMs = computeNextRunMs(patch.schedule);
        merged.nextRunAtMs = nextMs ?? undefined;
      }

      this.tasks[idx] = merged;
      this.persist();
      this.emitEvent({ kind: 'task:updated', taskId, task: merged, ts: merged.updatedAt });
      this.armTimer();
      return merged;
    });
  }

  public async remove(taskId: string): Promise<boolean> {
    return this.lock.run(() => {
      const target = this.tasks.find((t) => t.id === taskId);
      if (!target) return false;
      this.snapshot('remove', `Remove task: ${target.name}`);
      this.tasks = this.tasks.filter((t) => t.id !== taskId);
      this.persist();
      this.emitEvent({ kind: 'task:removed', taskId, ts: new Date().toISOString() });
      this.armTimer();
      return true;
    });
  }

  public async runNow(taskId: string): Promise<TaskRunRecord> {
    const task = this.tasks.find((t) => t.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} not found`);
    }
    return this.executeTask(task);
  }

  private armTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.running) return;

    const enabled = this.tasks.filter((t) => t.status === 'enabled' && t.nextRunAtMs !== undefined);
    if (enabled.length === 0) return;

    const earliest = Math.min(...enabled.map((t) => t.nextRunAtMs!));
    const rawDelay = Math.max(0, Math.min(earliest - Date.now(), MAX_TIMER_DELAY_MS));
    const delay = rawDelay + jitterMs(Math.min(rawDelay, 5_000));

    this.timer = setTimeout(() => {
      void this.onTick();
    }, delay);
  }

  private async onTick(): Promise<void> {
    try {
      if (!this.running) return;
      const now = Date.now();

      const due = this.tasks.filter(
        (t) => t.status === 'enabled' && t.nextRunAtMs !== undefined && t.nextRunAtMs <= now
      );

      const slots = Math.max(0, this.maxConcurrentRuns - this.activeRunCount);
      const batch = due.slice(0, slots);

      if (batch.length > 0) {
        await Promise.allSettled(batch.map((task) => this.executeTask(task)));
      }
    } finally {
      this.armTimer();
    }
  }

  private async catchUpMissedJobs(): Promise<void> {
    const now = Date.now();
    const missed = this.tasks.filter(
      (t) => t.status === 'enabled' && t.nextRunAtMs !== undefined && t.nextRunAtMs <= now
    );

    for (const task of missed) {
      if (!this.running) break;
      if (this.activeRunCount >= this.maxConcurrentRuns) break;
      await this.executeTask(task);
    }
  }

  private async executeTask(task: ScheduledTask): Promise<TaskRunRecord> {
    if (task.status === 'running') {
      return {
        taskId: task.id,
        runId: generateId(),
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        status: 'error',
        error: 'Task already running',
        durationMs: 0,
      };
    }

    const runId = generateId();
    const startedAt = new Date().toISOString();
    this.activeRunCount++;

    await this.lock.run(() => {
      this.patchTaskUnsafe(task.id, { status: 'running' });
    });

    this.emitEvent({ kind: 'task:started', taskId: task.id, task, ts: startedAt });

    let status: TaskRunRecord['status'] = 'ok';
    let error: string | undefined;

    const abortController = new AbortController();
    const timeoutHandle = setTimeout(() => {
      abortController.abort();
    }, task.timeoutMs);

    try {
      const result = await Promise.race([this.executor(task), rejectAfter(task.timeoutMs)]);

      if (!result.ok) {
        status = result.error?.includes('Timeout') ? 'timeout' : 'error';
        error = result.error;
      }
    } catch (err) {
      status = 'error';
      error = err instanceof Error ? err.message : String(err);
    } finally {
      clearTimeout(timeoutHandle);
    }

    this.activeRunCount--;
    const endedAt = new Date().toISOString();
    const durationMs = new Date(endedAt).getTime() - new Date(startedAt).getTime();

    const consecutiveErrors = status === 'ok' ? 0 : task.consecutiveErrors + 1;
    const backoffMs =
      consecutiveErrors > 0
        ? (BACKOFF_STEPS_MS[Math.min(consecutiveErrors - 1, BACKOFF_STEPS_MS.length - 1)] ??
          BACKOFF_STEPS_MS[BACKOFF_STEPS_MS.length - 1]!)
        : 0;

    let nextRunAtMs: number | undefined;
    if (task.schedule.kind === 'at') {
      nextRunAtMs = undefined;
    } else if (backoffMs > 0) {
      nextRunAtMs = Date.now() + backoffMs;
    } else {
      nextRunAtMs = computeNextRunMs(task.schedule) ?? undefined;
    }

    const newStatus: ScheduledTask['status'] =
      task.schedule.kind === 'at'
        ? 'disabled'
        : consecutiveErrors >= BACKOFF_STEPS_MS.length
          ? 'error'
          : 'enabled';

    await this.lock.run(() => {
      this.patchTaskUnsafe(task.id, {
        status: newStatus,
        lastRunAt: endedAt,
        lastRunStatus: status === 'ok' ? 'ok' : 'error',
        lastRunError: error ?? undefined,
        nextRunAtMs,
        consecutiveErrors,
        totalRuns: task.totalRuns + 1,
      });
    });

    const record: TaskRunRecord = {
      taskId: task.id,
      runId,
      startedAt,
      endedAt,
      status,
      error: error ?? undefined,
      durationMs,
    };
    this.store.appendRunRecord(record);

    this.emitEvent({
      kind: status === 'ok' ? 'task:completed' : 'task:error',
      taskId: task.id,
      run: record,
      ts: endedAt,
    });

    return record;
  }

  /** Must be called while holding the lock. */
  private patchTaskUnsafe(taskId: string, patch: Partial<ScheduledTask>): void {
    const idx = this.tasks.findIndex((t) => t.id === taskId);
    if (idx === -1) return;
    this.tasks[idx] = {
      ...this.tasks[idx]!,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    this.persist();
  }

  public listSnapshots(limit?: number, offset?: number): readonly TaskSnapshot[] {
    return this.snapshots.list(limit, offset);
  }

  public async rollback(snapshotId: string): Promise<readonly ScheduledTask[] | null> {
    return this.lock.run(() => {
      const data = this.snapshots.getSnapshotData(snapshotId);
      if (!data) return null;

      this.snapshot('rollback', `Rollback to ${snapshotId}`);
      this.tasks = [...data.tasks];
      this.recomputeAllNextRuns();
      this.persist();
      this.armTimer();
      return this.tasks;
    });
  }

  private recomputeAllNextRuns(): void {
    const now = Date.now();
    this.tasks = this.tasks.map((t) => {
      if (t.status !== 'enabled') return t;
      const next = computeNextRunMs(t.schedule, now);
      return { ...t, nextRunAtMs: next ?? undefined };
    });
  }

  private persist(): void {
    const data: TaskStoreData = { version: 1, tasks: this.tasks };
    this.store.persist(data);
    this.onTaskUpdate?.(this.tasks);
  }

  private snapshot(source: TaskSnapshot['source'], description: string): void {
    try {
      const data: TaskStoreData = { version: 1, tasks: this.tasks };
      this.snapshots.capture(data, source, description);
    } catch {
      // best-effort snapshotting
    }
  }

  private emitEvent(event: TaskEvent): void {
    try {
      this.onTaskEvent?.(event);
    } catch {
      /* listener should not throw */
    }
  }
}

function generateId(): string {
  return `task_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function rejectAfter(ms: number): Promise<{ ok: false; error: string }> {
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ ok: false, error: `Timeout after ${ms}ms` });
    }, ms);
  });
}

function jitterMs(maxMs: number): number {
  return Math.floor(Math.random() * maxMs);
}

function filterDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) result[key] = value;
  }
  return result as Partial<T>;
}
