import type { UseOpenClawTargetsResult } from '../../hooks/useOpenClawTargets';
import type { ConnectionStatus } from '../../types';

export interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  schedule: { kind: string; expr?: string; everyMs?: number; at?: string; tz?: string };
  action: { action: string; params?: Record<string, unknown> };
  status: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunStatus?: string;
  lastRunError?: string;
  nextRunAtMs?: number;
  consecutiveErrors: number;
  totalRuns: number;
  timeoutMs: number;
}

export interface TaskRunRecord {
  taskId: string;
  runId: string;
  startedAt: string;
  endedAt?: string;
  status: string;
  error?: string;
  durationMs?: number;
}

export interface OpenClawCronJob {
  jobId: string;
  name?: string;
  schedule: {
    kind: string;
    expr?: string;
    everyMs?: number;
    at?: string;
    tz?: string;
    anchorMs?: number;
    staggerMs?: number;
  };
  execution: { style: string; agentId?: string; sessionTag?: string };
  payload?: {
    kind?: 'systemEvent' | 'agentTurn';
    text?: string;
    message?: string;
    model?: string;
    thinking?: string;
    timeoutSeconds?: number;
  };
  delivery: {
    mode: string;
    webhookUrl?: string;
    webhookMethod?: string;
    channelId?: string;
    channel?: string;
    to?: string;
    bestEffort?: boolean;
  };
  sessionTarget?: 'main' | 'isolated';
  wakeMode?: 'next-heartbeat' | 'now';
  deleteAfterRun?: boolean;
  enabled: boolean;
  createdAt: string;
  updatedAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
  nextRunAtMs?: number;
  lastError?: string;
  lastDurationMs?: number;
  lastDelivered?: boolean;
  consecutiveErrors?: number;
}

export interface OpenClawRunRecord {
  jobId: string;
  runId: string;
  startedAt: string;
  endedAt?: string;
  status: string;
  error?: string;
  durationMs?: number;
  sessionId?: string;
}

export interface OpenClawSyncStatus {
  running: boolean;
  available: boolean;
  pollIntervalMs: number;
  jobsCount: number;
  lastAttemptAt?: string;
  lastSuccessfulSyncAt?: string;
  consecutiveFailures: number;
  lastError?: string;
  stale: boolean;
}

export interface OpenClawHealthCheck {
  readonly ok: boolean;
  readonly target: string;
  readonly checks: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: 'ok' | 'warn' | 'error';
    readonly message: string;
    readonly details?: string;
  }[];
  readonly syncStatus: OpenClawSyncStatus;
  readonly cliAvailable?: boolean;
  readonly cliVersion?: string | null;
}

export interface OpenClawTarget {
  id: string;
  label: string;
  type: 'local' | 'remote';
  openclawDir: string;
  pollIntervalMs: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TargetSyncStatusEntry {
  target: OpenClawTarget;
  syncStatus: OpenClawSyncStatus;
}

export interface TaskSnapshot {
  id: string;
  createdAt: string;
  source: string;
  description: string;
  taskCount: number;
}

export interface TasksViewProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly status: ConnectionStatus;
  readonly openclawTargets: UseOpenClawTargetsResult;
  readonly initialFilter?: 'openclaw';
}

export type TaskFilter = 'all' | 'enabled' | 'disabled' | 'error' | 'openclaw' | 'timeline';
