import type {
  AgentId,
  IsoUtcTimestamp,
  MachineId,
  ModelUsage,
  ResourceUsage,
  RunId,
  SessionId,
  SessionRunLifecycleState,
  SpanId,
  TelemetrySeverity,
  ToolCall,
  ToolCallId,
  TraceId,
  TraceSpan,
  OpaqueId,
  LogEntryId,
} from './types.js';

export type TelemetryEventId = OpaqueId<'telemetry_event_id'>;

export type TelemetryEventType =
  | 'machine.registered'
  | 'machine.heartbeat'
  | 'agent.state.changed'
  | 'session.state.changed'
  | 'run.state.changed'
  | 'run.log.emitted'
  | 'run.tool.started'
  | 'run.tool.completed'
  | 'run.model.usage'
  | 'run.resource.usage'
  | 'trace.span.recorded';

export interface TelemetryEventTrace {
  traceId: TraceId;
  spanId?: SpanId;
  parentSpanId?: SpanId;
}

export interface MachineRegisteredPayload {
  machineId: MachineId;
  name: string;
  kind: 'local' | 'vps';
  status: 'online' | 'offline' | 'degraded';
  registeredAt: IsoUtcTimestamp;
}

export interface MachineHeartbeatPayload {
  machineId: MachineId;
  status: 'online' | 'offline' | 'degraded';
  resource: Pick<
    ResourceUsage,
    'cpuPct' | 'memoryBytes' | 'memoryPct' | 'netRxBytes' | 'netTxBytes'
  > & {
    memoryTotalBytes?: number;
    diskUsageBytes?: number;
    diskTotalBytes?: number;
    diskPct?: number;
  };
}

export interface AgentStateChangedPayload {
  agentId: AgentId;
  machineId: MachineId;
  from: SessionRunLifecycleState;
  to: SessionRunLifecycleState;
  reason?: string;
}

export interface SessionStateChangedPayload {
  sessionId: SessionId;
  agentId: AgentId;
  machineId: MachineId;
  from: SessionRunLifecycleState;
  to: SessionRunLifecycleState;
  reason?: string;
}

export interface RunStateChangedPayload {
  runId: RunId;
  sessionId: SessionId;
  agentId: AgentId;
  from: SessionRunLifecycleState;
  to: SessionRunLifecycleState;
  reason?: string;
}

export interface RunLogEmittedPayload {
  logEntryId: LogEntryId;
  runId: RunId;
  sessionId: SessionId;
  level: TelemetrySeverity;
  message: string;
  ts: IsoUtcTimestamp;
}

export interface RunToolStartedPayload {
  runId: RunId;
  toolCallId: ToolCallId;
  toolName: ToolCall['toolName'];
  startedAt: IsoUtcTimestamp;
}

export interface RunToolCompletedPayload {
  runId: RunId;
  toolCallId: ToolCallId;
  toolName: ToolCall['toolName'];
  status: Extract<ToolCall['status'], 'completed' | 'failed' | 'cancelled'>;
  durationMs: number;
  success: boolean;
  errorMessage?: string;
}

export type RunModelUsagePayload = ModelUsage;

export type RunResourceUsagePayload = ResourceUsage & { runId: RunId };

export type TraceSpanRecordedPayload = TraceSpan;

export interface TelemetryEventPayloadMap {
  'machine.registered': MachineRegisteredPayload;
  'machine.heartbeat': MachineHeartbeatPayload;
  'agent.state.changed': AgentStateChangedPayload;
  'session.state.changed': SessionStateChangedPayload;
  'run.state.changed': RunStateChangedPayload;
  'run.log.emitted': RunLogEmittedPayload;
  'run.tool.started': RunToolStartedPayload;
  'run.tool.completed': RunToolCompletedPayload;
  'run.model.usage': RunModelUsagePayload;
  'run.resource.usage': RunResourceUsagePayload;
  'trace.span.recorded': TraceSpanRecordedPayload;
}

export type TelemetryEvent<TType extends TelemetryEventType = TelemetryEventType> = {
  id: TelemetryEventId;
  ts: IsoUtcTimestamp;
  machineId: MachineId;
  severity: TelemetrySeverity;
  type: TType;
  payload: TelemetryEventPayloadMap[TType];
  trace: TelemetryEventTrace;
};

export type AnyTelemetryEvent = {
  [TType in TelemetryEventType]: TelemetryEvent<TType>;
}[TelemetryEventType];
