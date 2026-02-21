import type {
  AnyTelemetryEvent,
  TelemetryEvent,
  TelemetryEventType,
} from './events.js';
import type { EventStore } from './event-store.js';
import type { IsoUtcTimestamp, TelemetrySeverity } from './types.js';
import { isRecord } from './utils.js';

export const TELEMETRY_SCHEMA_VERSION = 'telemetry.v1' as const;

export type TelemetrySchemaVersion = typeof TELEMETRY_SCHEMA_VERSION;

export type IngestErrorCode =
  | 'invalid_envelope'
  | 'invalid_payload'
  | 'invalid_schema_version'
  | 'invalid_event_type'
  | 'missing_machine_id'
  | 'invalid_timestamp'
  | 'invalid_severity'
  | 'invalid_trace';

export interface IngestError {
  code: IngestErrorCode;
  message: string;
}

export interface IngestSuccess {
  ok: true;
  event: Readonly<AnyTelemetryEvent>;
}

export interface IngestFailure {
  ok: false;
  error: IngestError;
}

export type IngestResult = IngestSuccess | IngestFailure;

export interface BatchIngestResult {
  accepted: readonly Readonly<AnyTelemetryEvent>[];
  rejected: readonly IngestFailure[];
}

export interface TelemetryIngestor {
  ingest(input: unknown): IngestResult;
  ingestMany(inputs: readonly unknown[]): BatchIngestResult;
}

interface TelemetryEventEnvelopeInput {
  version: string;
  id: string;
  ts: unknown;
  machineId: string;
  severity: string;
  type: string;
  payload: unknown;
  trace: unknown;
}

const TELEMETRY_EVENT_TYPES = new Set<TelemetryEventType>([
  'machine.registered',
  'machine.heartbeat',
  'agent.state.changed',
  'session.state.changed',
  'run.state.changed',
  'run.log.emitted',
  'run.tool.started',
  'run.tool.completed',
  'run.model.usage',
  'run.resource.usage',
  'trace.span.recorded',
]);

const TELEMETRY_SEVERITIES = new Set<TelemetrySeverity>([
  'debug',
  'info',
  'warn',
  'error',
  'critical',
]);

const MAX_EVENT_ID_LENGTH = 256;
const MAX_MACHINE_ID_LENGTH = 256;
const MAX_PAYLOAD_JSON_BYTES = 512 * 1024;

function containsNewlines(value: string): boolean {
  return value.includes('\n') || value.includes('\r');
}

function isEnvelopeInput(value: unknown): value is TelemetryEventEnvelopeInput {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.version === 'string' &&
    typeof value.id === 'string' &&
    typeof value.machineId === 'string' &&
    typeof value.severity === 'string' &&
    typeof value.type === 'string' &&
    'payload' in value &&
    'trace' in value &&
    'ts' in value
  );
}

function normalizeTimestamp(value: unknown): IsoUtcTimestamp | null {
  if (typeof value !== 'string' && !(value instanceof Date)) {
    return null;
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  return date.toISOString();
}

function normalizeTrace(trace: unknown): { traceId: string; spanId?: string; parentSpanId?: string } | null {
  if (!isRecord(trace)) {
    return null;
  }

  if (typeof trace.traceId !== 'string' || trace.traceId.length === 0) {
    return null;
  }

  const normalized: { traceId: string; spanId?: string; parentSpanId?: string } = {
    traceId: trace.traceId,
  };

  if (typeof trace.spanId === 'string' && trace.spanId.length > 0) {
    normalized.spanId = trace.spanId;
  }

  if (typeof trace.parentSpanId === 'string' && trace.parentSpanId.length > 0) {
    normalized.parentSpanId = trace.parentSpanId;
  }

  return normalized;
}

function normalizePayloadTimestamps(type: TelemetryEventType, payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }

  const normalized = structuredClone(payload) as Record<string, unknown>;

  const normalizeField = (field: string): void => {
    if (!(field in normalized)) {
      return;
    }

    const next = normalizeTimestamp(normalized[field]);
    if (next) {
      normalized[field] = next;
    }
  };

  if (type === 'machine.registered') {
    normalizeField('registeredAt');
  }

  if (type === 'run.log.emitted') {
    normalizeField('ts');
  }

  if (type === 'run.tool.started') {
    normalizeField('startedAt');
  }

  if (type === 'run.model.usage' || type === 'run.resource.usage') {
    normalizeField('measuredAt');
  }

  if (type === 'trace.span.recorded') {
    normalizeField('startedAt');
    normalizeField('endedAt');
  }

  return normalized;
}

function validatePayloadShape(type: TelemetryEventType, payload: unknown): string | null {
  if (!isRecord(payload)) {
    return `Payload for '${type}' must be an object.`;
  }

  if (type === 'machine.registered') {
    if (typeof payload.machineId !== 'string') return 'machine.registered.payload.machineId is required.';
    if (typeof payload.name !== 'string') return 'machine.registered.payload.name is required.';
    if (typeof payload.kind !== 'string') return 'machine.registered.payload.kind is required.';
    if (typeof payload.status !== 'string') return 'machine.registered.payload.status is required.';
    if (typeof payload.registeredAt !== 'string' && !(payload.registeredAt instanceof Date)) {
      return 'machine.registered.payload.registeredAt must be a timestamp.';
    }
    return null;
  }

  if (type === 'machine.heartbeat') {
    if (typeof payload.machineId !== 'string') return 'machine.heartbeat.payload.machineId is required.';
    if (typeof payload.status !== 'string') return 'machine.heartbeat.payload.status is required.';
    if (!isRecord(payload.resource)) return 'machine.heartbeat.payload.resource is required.';
    if (typeof payload.resource.cpuPct !== 'number') return 'machine.heartbeat.payload.resource.cpuPct is required.';
    if (typeof payload.resource.memoryBytes !== 'number') return 'machine.heartbeat.payload.resource.memoryBytes is required.';
    if (typeof payload.resource.memoryPct !== 'number') return 'machine.heartbeat.payload.resource.memoryPct is required.';
    return null;
  }

  if (type === 'agent.state.changed') {
    if (typeof payload.agentId !== 'string') return 'agent.state.changed.payload.agentId is required.';
    if (typeof payload.machineId !== 'string') return 'agent.state.changed.payload.machineId is required.';
    if (typeof payload.from !== 'string' || typeof payload.to !== 'string') {
      return 'agent.state.changed.payload.from/to are required.';
    }
    return null;
  }

  if (type === 'session.state.changed') {
    if (typeof payload.sessionId !== 'string') return 'session.state.changed.payload.sessionId is required.';
    if (typeof payload.agentId !== 'string') return 'session.state.changed.payload.agentId is required.';
    if (typeof payload.machineId !== 'string') return 'session.state.changed.payload.machineId is required.';
    if (typeof payload.from !== 'string' || typeof payload.to !== 'string') {
      return 'session.state.changed.payload.from/to are required.';
    }
    return null;
  }

  if (type === 'run.state.changed') {
    if (typeof payload.runId !== 'string') return 'run.state.changed.payload.runId is required.';
    if (typeof payload.sessionId !== 'string') return 'run.state.changed.payload.sessionId is required.';
    if (typeof payload.agentId !== 'string') return 'run.state.changed.payload.agentId is required.';
    if (typeof payload.from !== 'string' || typeof payload.to !== 'string') {
      return 'run.state.changed.payload.from/to are required.';
    }
    return null;
  }

  if (type === 'run.log.emitted') {
    if (typeof payload.logEntryId !== 'string') return 'run.log.emitted.payload.logEntryId is required.';
    if (typeof payload.runId !== 'string') return 'run.log.emitted.payload.runId is required.';
    if (typeof payload.sessionId !== 'string') return 'run.log.emitted.payload.sessionId is required.';
    if (typeof payload.level !== 'string') return 'run.log.emitted.payload.level is required.';
    if (typeof payload.message !== 'string') return 'run.log.emitted.payload.message is required.';
    if (typeof payload.ts !== 'string' && !(payload.ts instanceof Date)) {
      return 'run.log.emitted.payload.ts must be a timestamp.';
    }
    return null;
  }

  if (type === 'run.tool.started') {
    if (typeof payload.runId !== 'string') return 'run.tool.started.payload.runId is required.';
    if (typeof payload.toolCallId !== 'string') return 'run.tool.started.payload.toolCallId is required.';
    if (typeof payload.toolName !== 'string') return 'run.tool.started.payload.toolName is required.';
    if (typeof payload.startedAt !== 'string' && !(payload.startedAt instanceof Date)) {
      return 'run.tool.started.payload.startedAt must be a timestamp.';
    }
    return null;
  }

  if (type === 'run.tool.completed') {
    if (typeof payload.runId !== 'string') return 'run.tool.completed.payload.runId is required.';
    if (typeof payload.toolCallId !== 'string') return 'run.tool.completed.payload.toolCallId is required.';
    if (typeof payload.toolName !== 'string') return 'run.tool.completed.payload.toolName is required.';
    if (typeof payload.status !== 'string') return 'run.tool.completed.payload.status is required.';
    if (typeof payload.durationMs !== 'number') return 'run.tool.completed.payload.durationMs is required.';
    if (typeof payload.success !== 'boolean') return 'run.tool.completed.payload.success is required.';
    return null;
  }

  if (type === 'run.model.usage') {
    if (typeof payload.runId !== 'string') return 'run.model.usage.payload.runId is required.';
    if (typeof payload.machineId !== 'string') return 'run.model.usage.payload.machineId is required.';
    if (typeof payload.provider !== 'string') return 'run.model.usage.payload.provider is required.';
    if (typeof payload.model !== 'string') return 'run.model.usage.payload.model is required.';
    return null;
  }

  if (type === 'run.resource.usage') {
    if (typeof payload.machineId !== 'string') return 'run.resource.usage.payload.machineId is required.';
    if (typeof payload.cpuPct !== 'number') return 'run.resource.usage.payload.cpuPct is required.';
    if (typeof payload.memoryBytes !== 'number') return 'run.resource.usage.payload.memoryBytes is required.';
    if (typeof payload.memoryPct !== 'number') return 'run.resource.usage.payload.memoryPct is required.';
    return null;
  }

  if (type === 'trace.span.recorded') {
    if (typeof payload.id !== 'string') return 'trace.span.recorded.payload.id is required.';
    if (typeof payload.traceId !== 'string') return 'trace.span.recorded.payload.traceId is required.';
    if (typeof payload.machineId !== 'string') return 'trace.span.recorded.payload.machineId is required.';
    if (typeof payload.name !== 'string') return 'trace.span.recorded.payload.name is required.';
    return null;
  }

  return null;
}

function toFailure(code: IngestErrorCode, message: string): IngestFailure {
  return {
    ok: false,
    error: { code, message },
  };
}

export class DefaultTelemetryIngestor implements TelemetryIngestor {
  private readonly eventStore: EventStore;

  public constructor(eventStore: EventStore) {
    this.eventStore = eventStore;
  }

  public ingest(input: unknown): IngestResult {
    if (!isEnvelopeInput(input)) {
      return toFailure('invalid_envelope', 'Invalid telemetry envelope structure.');
    }

    if (input.version !== TELEMETRY_SCHEMA_VERSION) {
      return toFailure(
        'invalid_schema_version',
        `Unsupported telemetry schema version: ${input.version}.`
      );
    }

    if (containsNewlines(input.id)) {
      return toFailure('invalid_envelope', 'Event id must not contain newline characters.');
    }

    if (input.id.length > MAX_EVENT_ID_LENGTH) {
      return toFailure('invalid_envelope', `Event id exceeds maximum length of ${String(MAX_EVENT_ID_LENGTH)}.`);
    }

    if (input.machineId.trim().length === 0) {
      return toFailure('missing_machine_id', 'machineId is required.');
    }

    if (input.machineId.length > MAX_MACHINE_ID_LENGTH) {
      return toFailure('invalid_envelope', `machineId exceeds maximum length of ${String(MAX_MACHINE_ID_LENGTH)}.`);
    }

    if (containsNewlines(input.machineId)) {
      return toFailure('invalid_envelope', 'machineId must not contain newline characters.');
    }

    if (!TELEMETRY_EVENT_TYPES.has(input.type as TelemetryEventType)) {
      return toFailure('invalid_event_type', `Unsupported telemetry event type: ${input.type}.`);
    }

    if (!TELEMETRY_SEVERITIES.has(input.severity as TelemetrySeverity)) {
      return toFailure('invalid_severity', `Unsupported severity: ${input.severity}.`);
    }

    const normalizedTs = normalizeTimestamp(input.ts);
    if (!normalizedTs) {
      return toFailure('invalid_timestamp', 'Envelope timestamp must be a valid ISO-8601 UTC value.');
    }

    const normalizedTrace = normalizeTrace(input.trace);
    if (!normalizedTrace) {
      return toFailure('invalid_trace', 'trace.traceId is required.');
    }

    const eventType = input.type as TelemetryEventType;

    const payloadError = validatePayloadShape(eventType, input.payload);
    if (payloadError) {
      return toFailure('invalid_payload', payloadError);
    }

    if (isRecord(input.payload) && 'machineId' in input.payload) {
      const payloadMachineId = input.payload.machineId;
      if (typeof payloadMachineId === 'string' && payloadMachineId !== input.machineId) {
        return toFailure(
          'invalid_envelope',
          'Envelope machineId must match payload machineId when payload includes machineId.'
        );
      }
    }

    const payloadJson = JSON.stringify(input.payload);
    if (payloadJson.length > MAX_PAYLOAD_JSON_BYTES) {
      return toFailure('invalid_envelope', 'Payload exceeds maximum allowed size.');
    }

    const normalizedPayload = normalizePayloadTimestamps(eventType, input.payload);

    const normalizedEvent = {
      id: input.id,
      ts: normalizedTs,
      machineId: input.machineId,
      severity: input.severity,
      type: eventType,
      payload: normalizedPayload,
      trace: normalizedTrace,
    } as AnyTelemetryEvent;

    const appended = this.eventStore.append(
      normalizedEvent as TelemetryEvent<typeof normalizedEvent.type>
    ) as Readonly<AnyTelemetryEvent>;

    return {
      ok: true,
      event: appended,
    };
  }

  public ingestMany(inputs: readonly unknown[]): BatchIngestResult {
    const accepted: Readonly<AnyTelemetryEvent>[] = [];
    const rejected: IngestFailure[] = [];

    for (const input of inputs) {
      const result = this.ingest(input);
      if (result.ok) {
        accepted.push(result.event);
      } else {
        rejected.push(result);
      }
    }

    return {
      accepted,
      rejected,
    };
  }
}
