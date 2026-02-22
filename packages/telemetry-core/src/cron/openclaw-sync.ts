import {
  OpenClawCronReader,
  type OpenClawCronJob,
  type OpenClawRunRecord,
} from './openclaw-reader.js';
import type { ScheduledTask, TaskSchedule, TaskActionConfig, TaskRunRecord } from './types.js';

/**
 * Merged view: our patze tasks + native OpenClaw cron jobs.
 */
export interface MergedCronView {
  readonly patzeTasks: readonly ScheduledTask[];
  readonly openclawJobs: readonly OpenClawCronJob[];
  readonly timestamp: number;
}

export interface OpenClawSyncOptions {
  readonly openclawDir: string;
  readonly pollIntervalMs?: number;
  readonly onSync?: (view: MergedCronView) => void;
  readonly onStatus?: (status: OpenClawSyncStatus) => void;
}

export interface OpenClawSyncStatus {
  readonly running: boolean;
  readonly available: boolean;
  readonly pollIntervalMs: number;
  readonly jobsCount: number;
  readonly lastAttemptAt: string | undefined;
  readonly lastSuccessfulSyncAt: string | undefined;
  readonly consecutiveFailures: number;
  readonly lastError: string | undefined;
  readonly stale: boolean;
}

/**
 * Periodically reads OpenClaw's native cron files and provides a
 * unified view alongside patze tasks. Inspired by ClawPal's
 * `list_cron_jobs` / `get_cron_runs` pattern but adds real-time sync.
 */
export class OpenClawCronSync {
  private readonly reader: OpenClawCronReader;
  private readonly pollIntervalMs: number;
  private readonly onSync: ((view: MergedCronView) => void) | undefined;
  private readonly onStatus: ((status: OpenClawSyncStatus) => void) | undefined;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastJobs: OpenClawCronJob[] = [];
  private running = false;
  private lastAttemptAt: string | undefined;
  private lastSuccessfulSyncAt: string | undefined;
  private consecutiveFailures = 0;
  private lastError: string | undefined;
  private lastReportedStatus: string | undefined;
  private currentPollIntervalMs: number;
  private readonly maxPollIntervalMs = 3_600_000;

  public constructor(options: OpenClawSyncOptions) {
    this.reader = new OpenClawCronReader(options.openclawDir);
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
    this.onSync = options.onSync;
    this.onStatus = options.onStatus;
    this.currentPollIntervalMs = this.pollIntervalMs;
  }

  public get available(): boolean {
    return this.reader.hasJobsFile();
  }

  public start(): void {
    if (this.running) return;
    this.running = true;
    this.refresh();
  }

  public stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  public getJobs(): readonly OpenClawCronJob[] {
    return this.lastJobs;
  }

  public getRunHistory(jobId: string, limit?: number): readonly OpenClawRunRecord[] {
    return this.reader.readRuns(jobId, limit);
  }

  /**
   * Convert an OpenClaw job into a read-only ScheduledTask for
   * unified display. The `id` is prefixed with `oc:` to distinguish
   * from patze-native tasks.
   */
  public toScheduledTask(job: OpenClawCronJob): ScheduledTask {
    return {
      id: `oc:${job.jobId}`,
      name: job.name ?? job.jobId,
      description: buildDescription(job),
      schedule: toTaskSchedule(job.schedule),
      action: toTaskAction(job),
      status: job.enabled ? 'enabled' : 'disabled',
      createdAt: job.createdAt,
      updatedAt: job.updatedAt ?? job.createdAt,
      lastRunAt: job.lastRunAt,
      lastRunStatus: job.lastStatus === 'ok' ? 'ok' : job.lastStatus ? 'error' : undefined,
      lastRunError: undefined,
      nextRunAtMs: undefined,
      consecutiveErrors: job.consecutiveErrors ?? 0,
      totalRuns: 0,
      timeoutMs: 600_000,
    };
  }

  /**
   * Convert OpenClaw run records to patze TaskRunRecord format.
   */
  public toRunRecords(runs: readonly OpenClawRunRecord[]): readonly TaskRunRecord[] {
    return runs.map((r) => ({
      taskId: `oc:${r.jobId}`,
      runId: r.runId,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      status: r.status,
      error: r.error,
      durationMs: r.durationMs,
    }));
  }

  public createMergedView(patzeTasks: readonly ScheduledTask[]): MergedCronView {
    return {
      patzeTasks,
      openclawJobs: this.lastJobs,
      timestamp: Date.now(),
    };
  }

  public getStatus(): OpenClawSyncStatus {
    const stale = this.lastSuccessfulSyncAt
      ? Date.now() - new Date(this.lastSuccessfulSyncAt).getTime() > this.currentPollIntervalMs * 3
      : this.available;
    return {
      running: this.running,
      available: this.available,
      pollIntervalMs: this.currentPollIntervalMs,
      jobsCount: this.lastJobs.length,
      lastAttemptAt: this.lastAttemptAt,
      lastSuccessfulSyncAt: this.lastSuccessfulSyncAt,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      stale,
    };
  }

  private refresh(): void {
    if (!this.running) {
      this.lastReportedStatus = undefined;
      return;
    }

    this.lastAttemptAt = new Date().toISOString();
    try {
      this.lastJobs = this.reader.readJobs();
      this.lastSuccessfulSyncAt = new Date().toISOString();
      this.consecutiveFailures = 0;
      this.lastError = undefined;
      this.currentPollIntervalMs = this.pollIntervalMs;
      this.onSync?.(this.createMergedView([]));
    } catch (err) {
      // best-effort, keep last known state
      this.consecutiveFailures += 1;
      this.lastError = err instanceof Error ? err.message : 'sync_failed';
      this.currentPollIntervalMs = this.getBackoffIntervalMs(this.consecutiveFailures);
    } finally {
      this.emitStatusIfChanged();
      this.scheduleNextRefresh();
    }
  }

  private scheduleNextRefresh(): void {
    if (!this.running) return;

    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    this.timer = setTimeout(() => {
      this.refresh();
    }, this.currentPollIntervalMs);
  }

  private emitStatusIfChanged(): void {
    const status = this.getStatus();
    const serialized = JSON.stringify(status);
    if (this.lastReportedStatus === serialized) return;
    this.lastReportedStatus = serialized;
    this.onStatus?.(status);
  }

  private getBackoffIntervalMs(failures: number): number {
    const exponent = Math.min(Math.max(failures, 1), 10);
    const backoff = 2 ** (exponent - 1);
    return Math.min(this.pollIntervalMs * backoff, this.maxPollIntervalMs);
  }
}

function toTaskSchedule(s: OpenClawCronJob['schedule']): TaskSchedule {
  switch (s.kind) {
    case 'at':
      return { kind: 'at', at: s.at ?? new Date().toISOString() };
    case 'every':
      return { kind: 'every', everyMs: s.everyMs ?? 60_000 };
    case 'cron':
      return { kind: 'cron', expr: s.expr ?? '* * * * *', ...(s.tz ? { tz: s.tz } : {}) };
  }
}

function toTaskAction(job: OpenClawCronJob): TaskActionConfig {
  if (job.delivery.mode === 'webhook' && job.delivery.webhookUrl) {
    return {
      action: 'custom_webhook',
      params: {
        url: job.delivery.webhookUrl,
        method: job.delivery.webhookMethod ?? 'POST',
      },
    };
  }
  return {
    action: 'health_check',
    params: {
      source: 'openclaw',
      jobId: job.jobId,
      execution: job.execution,
      delivery: job.delivery,
    },
  };
}

function buildDescription(job: OpenClawCronJob): string {
  const parts = [`OpenClaw ${job.execution.style} session`];
  if (job.execution.agentId) parts.push(`agent: ${job.execution.agentId}`);
  if (job.delivery.mode !== 'none') parts.push(`delivery: ${job.delivery.mode}`);
  return parts.join(' · ');
}
