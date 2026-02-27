import type {
  AnyTelemetryEvent,
  AgentId,
  MachineId,
  RunId,
  SessionId,
  SessionRunLifecycleState,
} from '@patze/telemetry-core';

export type BridgeSourceMode = 'files' | 'cli';

export interface DetectedToolCall {
  toolCallId: string;
  toolName: string;
  status: 'started' | 'completed' | 'failed' | 'cancelled';
  startedAt?: string;
  durationMs?: number;
  success?: boolean;
  errorMessage?: string;
}

export interface DetectedModelUsage {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
}

export interface DetectedLogEntry {
  id: string;
  level: 'debug' | 'info' | 'warn' | 'error' | 'critical';
  message: string;
  ts: string;
}

export interface DetectedRun {
  runId: RunId;
  sessionId: SessionId;
  agentId: AgentId;
  state: SessionRunLifecycleState;
  startedAt?: string;
  toolCalls?: readonly DetectedToolCall[];
  modelUsage?: DetectedModelUsage;
  logs?: readonly DetectedLogEntry[];
  errorMessage?: string;
}

export interface SourceSnapshot {
  activeRuns: readonly DetectedRun[];
}

export interface RunDetector {
  collect(): Promise<SourceSnapshot>;
}

export type TelemetryEnvelope = Readonly<AnyTelemetryEvent> & {
  readonly version: 'telemetry.v1';
};

export interface BridgeLogger {
  info(message: string, context?: Record<string, string | number | boolean>): void;
  warn(message: string, context?: Record<string, string | number | boolean>): void;
  error(message: string, context?: Record<string, string | number | boolean>): void;
}

export type BridgeControlIntent =
  | 'trigger_job'
  | 'agent_set_enabled'
  | 'approve_request'
  | 'run_command';

export type BridgeControlCommandState =
  | 'queued'
  | 'leased'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'rejected'
  | 'expired'
  | 'deadletter';

export interface BridgeControlCommandSnapshot {
  readonly targetId: string;
  readonly machineId: string;
  readonly targetVersion: string;
  readonly intent: BridgeControlIntent;
  readonly args: Readonly<Record<string, unknown>>;
  readonly createdBy: string;
  readonly idempotencyKey: string;
  readonly approvalRequired: boolean;
  readonly policyVersion?: string | undefined;
}

export interface BridgeControlCommand {
  readonly id: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly state: BridgeControlCommandState;
  readonly snapshot: BridgeControlCommandSnapshot;
}

export interface BridgeControlCommandResult {
  readonly status: 'succeeded' | 'failed';
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly truncated: boolean;
  readonly artifact?: string | undefined;
  readonly duplicate?: boolean | undefined;
}

export interface MachineInfo {
  machineId: MachineId;
  machineLabel: string;
  machineKind: 'local' | 'vps';
}

export interface RunRef {
  runId: RunId;
  sessionId: SessionId;
  agentId: AgentId;
}

export interface SessionTrack {
  sessionId: SessionId;
  agentId: AgentId;
  machineId: MachineId;
  state: SessionRunLifecycleState;
  activeRunIds: Set<RunId>;
  /** epoch ms when session entered a terminal state — used for eviction */
  terminalSince?: number;
}

export const MAPPER_SESSION_CAP = 5000;
export const MAPPER_SESSION_EVICT_MS = 10 * 60 * 1000;

export interface MapperState {
  knownRuns: Map<RunId, DetectedRun>;
  knownSessions: Map<SessionId, SessionTrack>;
  emittedToolCallIds: Set<string>;
  emittedLogIds: Set<string>;
  emittedModelUsageRunIds: Set<string>;
}
