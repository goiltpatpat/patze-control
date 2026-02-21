export type OpaqueId<T extends string> = string & { readonly __opaqueType: T };

export type IsoUtcTimestamp = string;

export type MachineId = OpaqueId<'machine_id'>;
export type AgentId = OpaqueId<'agent_id'>;
export type SessionId = OpaqueId<'session_id'>;
export type RunId = OpaqueId<'run_id'>;
export type ToolCallId = OpaqueId<'tool_call_id'>;
export type TraceId = OpaqueId<'trace_id'>;
export type SpanId = OpaqueId<'span_id'>;
export type LogEntryId = OpaqueId<'log_entry_id'>;

export type TelemetrySeverity = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export type SessionRunLifecycleState =
  | 'created'
  | 'queued'
  | 'running'
  | 'waiting_tool'
  | 'streaming'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface Machine {
  id: MachineId;
  name: string;
  kind: 'local' | 'vps';
  status: 'online' | 'offline' | 'degraded';
  region?: string;
  labels: Record<string, string>;
  lastSeenAt: IsoUtcTimestamp;
}

export interface Agent {
  id: AgentId;
  machineId: MachineId;
  name: string;
  runtime: string;
  version: string;
  state: SessionRunLifecycleState;
  startedAt?: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
}

export interface Session {
  id: SessionId;
  machineId: MachineId;
  agentId: AgentId;
  state: SessionRunLifecycleState;
  title?: string;
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
  endedAt?: IsoUtcTimestamp;
}

export interface Run {
  id: RunId;
  sessionId: SessionId;
  machineId: MachineId;
  agentId: AgentId;
  state: SessionRunLifecycleState;
  trigger: 'manual' | 'scheduled' | 'api' | 'system';
  startedAt?: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
  endedAt?: IsoUtcTimestamp;
  errorCode?: string;
  errorMessage?: string;
}

export interface ToolCall {
  id: ToolCallId;
  runId: RunId;
  machineId: MachineId;
  toolName: string;
  status: 'started' | 'completed' | 'failed' | 'cancelled';
  startedAt: IsoUtcTimestamp;
  completedAt?: IsoUtcTimestamp;
  durationMs?: number;
  success?: boolean;
  errorMessage?: string;
}

export interface ModelUsage {
  runId: RunId;
  machineId: MachineId;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCostUsd?: number;
  measuredAt: IsoUtcTimestamp;
}

export interface ResourceUsage {
  runId?: RunId;
  machineId: MachineId;
  cpuPct: number;
  memoryBytes: number;
  memoryPct: number;
  diskReadBytes?: number;
  diskWriteBytes?: number;
  netRxBytes?: number;
  netTxBytes?: number;
  measuredAt: IsoUtcTimestamp;
}

export interface LogEntry {
  id: LogEntryId;
  machineId: MachineId;
  sessionId?: SessionId;
  runId?: RunId;
  level: TelemetrySeverity;
  message: string;
  ts: IsoUtcTimestamp;
  source?: string;
}

export interface TraceSpan {
  id: SpanId;
  traceId: TraceId;
  parentSpanId?: SpanId;
  machineId: MachineId;
  runId?: RunId;
  name: string;
  kind: 'internal' | 'client' | 'server' | 'producer' | 'consumer';
  startedAt: IsoUtcTimestamp;
  endedAt?: IsoUtcTimestamp;
  status: 'ok' | 'error' | 'unset';
}
