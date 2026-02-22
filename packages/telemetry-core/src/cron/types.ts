export type ScheduleKind = 'at' | 'every' | 'cron';

export interface AtSchedule {
  readonly kind: 'at';
  readonly at: string;
}

export interface EverySchedule {
  readonly kind: 'every';
  readonly everyMs: number;
  readonly anchorMs?: number;
}

export interface CronExprSchedule {
  readonly kind: 'cron';
  readonly expr: string;
  readonly tz?: string;
}

export type TaskSchedule = AtSchedule | EverySchedule | CronExprSchedule;

export type TaskStatus = 'enabled' | 'disabled' | 'running' | 'error';

export type TaskAction =
  | 'health_check'
  | 'reconnect_endpoints'
  | 'cleanup_sessions'
  | 'generate_report'
  | 'custom_webhook'
  | 'openclaw_cron_run';

export interface TaskActionConfig {
  readonly action: TaskAction;
  readonly params?: Readonly<Record<string, unknown>>;
}

export interface ScheduledTask {
  readonly id: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly schedule: TaskSchedule;
  readonly action: TaskActionConfig;
  readonly status: TaskStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lastRunAt: string | undefined;
  readonly lastRunStatus: 'ok' | 'error' | undefined;
  readonly lastRunError: string | undefined;
  readonly nextRunAtMs: number | undefined;
  readonly consecutiveErrors: number;
  readonly totalRuns: number;
  readonly timeoutMs: number;
}

export interface TaskRunRecord {
  readonly taskId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string | undefined;
  readonly status: 'ok' | 'error' | 'timeout' | 'running';
  readonly error: string | undefined;
  readonly durationMs: number | undefined;
}

export interface TaskStoreData {
  readonly version: 1;
  readonly tasks: readonly ScheduledTask[];
}

export type TaskCreateInput = Omit<
  ScheduledTask,
  | 'id'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
  | 'lastRunAt'
  | 'lastRunStatus'
  | 'lastRunError'
  | 'nextRunAtMs'
  | 'consecutiveErrors'
  | 'totalRuns'
> & { id?: string };

export type TaskPatchInput = Partial<
  Pick<ScheduledTask, 'name' | 'description' | 'schedule' | 'action' | 'status' | 'timeoutMs'>
>;

export const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
export const MAX_TIMER_DELAY_MS = 60_000;
export const BACKOFF_STEPS_MS = [30_000, 60_000, 300_000, 900_000, 3_600_000] as const;
export const RUN_HISTORY_MAX = 100;
