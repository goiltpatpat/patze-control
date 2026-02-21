import type { MachineReadModel, RunReadModel, SessionReadModel } from './telemetry-aggregator.js';
import type { IsoUtcTimestamp, SessionRunLifecycleState } from './types.js';

/**
 * UI contract: arrays are pre-sorted in deterministic order by producer.
 * - machines: machineId ASC
 * - sessions: updatedAt DESC, then sessionId ASC
 * - runs: updatedAt DESC, then runId ASC
 * - activeRuns: updatedAt DESC, then runId ASC
 */
export type SortedReadonlyArray<T> = readonly Readonly<T>[];

export type FrontendMachineSnapshot = Readonly<MachineReadModel>;

export type FrontendSessionSnapshot = Readonly<SessionReadModel>;

export type FrontendRunSnapshot = Readonly<RunReadModel>;

export interface FrontendMachineHealthIndicator {
  machineId: string;
  status: FrontendHealthStatus;
  activeRunCount: number;
  lastSeenAt: IsoUtcTimestamp;
}

export interface FrontendHealthIndicators {
  overall: FrontendHealthStatus;
  machines: SortedReadonlyArray<FrontendMachineHealthIndicator>;
  activeRunsTotal: number;
  failedRunsTotal: number;
  staleMachinesTotal: number;
}

export type FrontendHealthStatus = 'healthy' | 'degraded' | 'critical' | 'unknown';

export type FrontendActiveRunSnapshot = Readonly<
  FrontendRunSnapshot & {
    isActive: true;
    state: Exclude<SessionRunLifecycleState, 'completed' | 'failed' | 'cancelled'>;
  }
>;

export interface FrontendToolCallSnapshot {
  toolCallId: string;
  toolName: string;
  status: 'started' | 'completed' | 'failed' | 'cancelled';
  startedAt: IsoUtcTimestamp;
  durationMs?: number;
  success?: boolean;
  errorMessage?: string;
}

export interface FrontendModelUsageSnapshot {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
}

export interface FrontendRunDetailSnapshot {
  runId: string;
  toolCalls: readonly Readonly<FrontendToolCallSnapshot>[];
  modelUsage?: Readonly<FrontendModelUsageSnapshot>;
}

export interface FrontendLogSnapshot {
  id: string;
  runId: string;
  sessionId: string;
  machineId: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  message: string;
  ts: IsoUtcTimestamp;
}

export interface FrontendUnifiedSnapshot {
  machines: SortedReadonlyArray<FrontendMachineSnapshot>;
  sessions: SortedReadonlyArray<FrontendSessionSnapshot>;
  runs: SortedReadonlyArray<FrontendRunSnapshot>;
  activeRuns: SortedReadonlyArray<FrontendActiveRunSnapshot>;
  health: Readonly<FrontendHealthIndicators>;
  runDetails: Readonly<Record<string, Readonly<FrontendRunDetailSnapshot>>>;
  logs: SortedReadonlyArray<FrontendLogSnapshot>;
  recentEvents: SortedReadonlyArray<FrontendRecentEvent>;
  lastUpdated: IsoUtcTimestamp;
}

export interface FrontendRecentEvent {
  id: string;
  ts: IsoUtcTimestamp;
  type: string;
  machineId: string;
  summary: string;
}
