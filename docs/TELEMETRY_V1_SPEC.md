# Telemetry v1.0 Specification (Design Only)

Status: Draft v1.0 (types + contracts only)
Scope: Generic agent runtime telemetry for control-plane architecture
Non-goals (this phase): runtime implementation, routes, persistence, OpenClaw-specific integration, UI

## 1) Objectives

Telemetry v1 defines a forward-compatible event contract for monitoring and controlling distributed agent runtimes across multiple machines (local and VPS).

Primary objectives:

- Multi-machine telemetry normalization
- Event-driven model compatible with REST snapshots and SSE streams
- Strictly typed contracts for core domain and event payloads
- Future extensibility for SSH bridge, auth, RBAC, persistence, and cost tracking

## 2) System Model (v1)

The control plane treats runtime nodes as generic machines hosting agents.

Core entities:

- `Machine`
- `Agent`
- `Session`
- `Run`
- `ToolCall`
- `ModelUsage`
- `ResourceUsage`
- `LogEntry`
- `TraceSpan`

Design constraints:

- All identifiers are opaque strings. ULID format is assumed by convention, not enforced/generated in v1.
- All timestamps are ISO-8601 UTC strings (example: `2026-02-20T16:41:00.000Z`).
- Entity references should use IDs (not embedded object graphs) to avoid circular type dependencies.

## 3) Lifecycle States

`Session` and `Run` both use the same lifecycle state union in v1:

- `created`
- `queued`
- `running`
- `waiting_tool`
- `streaming`
- `completed`
- `failed`
- `cancelled`

State handling notes:

- State transitions are event-driven (append-only event history).
- Invalid transitions are implementation concerns and out of scope for this phase.

## 4) Event Stream Contract

Telemetry events use an envelope with discriminated payloads.

Envelope fields:

- `id`: opaque event ID
- `ts`: ISO-8601 UTC timestamp
- `machineId`: origin machine
- `severity`: `debug | info | warn | error | critical`
- `type`: event type discriminator
- `payload`: payload bound to `type`
- `trace`: trace correlation object (`traceId`, optional `spanId`, optional `parentSpanId`)

Forward-compatibility requirements:

- Consumers must dispatch by `type`.
- Unknown event `type` values should be ignored (or safely stored) without failing stream processing.
- Payload shape is authoritative per `type` through `TelemetryEventPayloadMap`.

## 5) Event Types (v1)

Recommended v1 event types:

- `machine.registered`
- `machine.heartbeat`
- `agent.state.changed`
- `session.state.changed`
- `run.state.changed`
- `run.log.emitted`
- `run.tool.started`
- `run.tool.completed`
- `run.model.usage`
- `run.resource.usage`
- `trace.span.recorded`

## 6) Naming + Identifier Conventions

Naming conventions:

- IDs: `<entity>NameId` type aliases in TypeScript
- Events: lowercase dot-separated (`domain.entity.action`)
- Enums/unions: lowercase snake_case for runtime states

Identifier conventions:

- ULID string format preferred for lexical sorting and distributed generation
- IDs remain opaque to API clients and UI
- No semantic parsing of ID contents in business logic

## 7) Versioning and Compatibility Rules (v1)

Version marker:

- Contract version is `telemetry.v1` at package/spec level.

Compatibility policy:

- Additive changes are backward-compatible in v1:
  - New optional fields in payloads
  - New event types
- Breaking changes require major version bump (`v2`), including:
  - Removing/renaming event types
  - Changing required field semantics
  - Re-typing existing required fields

Consumer expectations:

- Must tolerate additional unknown fields in event payloads.
- Must handle unknown event types gracefully.

## 8) REST + SSE Compatibility

Transport guidance (design-only):

- REST: suitable for snapshots and recent history reads.
- SSE: suitable for live append-only event stream.
- Event envelope is transport-agnostic and identical across REST and SSE payloads.

## 9) JSON Event Examples (v1)

### Example A: machine heartbeat

```json
{
  "id": "01JMG0AX93G6PSW1JCKM8TG6G0",
  "ts": "2026-02-20T16:41:00.000Z",
  "machineId": "01JMG09QW93QJH8A8D5NY8SBCV",
  "severity": "info",
  "type": "machine.heartbeat",
  "trace": {
    "traceId": "01JMG0AT6P1M2N4AZ8A35QZ6D7"
  },
  "payload": {
    "machineId": "01JMG09QW93QJH8A8D5NY8SBCV",
    "status": "online",
    "resource": {
      "cpuPct": 12.4,
      "memoryBytes": 1837264896,
      "memoryPct": 44.2
    }
  }
}
```

### Example B: run state changed

```json
{
  "id": "01JMG0D3WSV8SWDRN9MM46E8Z8",
  "ts": "2026-02-20T16:42:12.000Z",
  "machineId": "01JMG09QW93QJH8A8D5NY8SBCV",
  "severity": "info",
  "type": "run.state.changed",
  "trace": {
    "traceId": "01JMG0CY5Y7D9GTAJ8VJ9RK2YB",
    "spanId": "01JMG0CYTDCQKVMVJFR5M4A8HF"
  },
  "payload": {
    "runId": "01JMG0C5WNN12RG7P0X9H8Y5NF",
    "sessionId": "01JMG0C10YGQPT0VF89BQ3E4C8",
    "agentId": "01JMG0BWV0BFC3X9JNR6Y8AGVP",
    "from": "running",
    "to": "waiting_tool",
    "reason": "awaiting external tool completion"
  }
}
```

### Example C: tool call completed

```json
{
  "id": "01JMG0FK67D6MM4T7C8KPJ1T2R",
  "ts": "2026-02-20T16:43:01.000Z",
  "machineId": "01JMG09QW93QJH8A8D5NY8SBCV",
  "severity": "info",
  "type": "run.tool.completed",
  "trace": {
    "traceId": "01JMG0CY5Y7D9GTAJ8VJ9RK2YB",
    "spanId": "01JMG0F5A8WQJVRKX9M1G6A2X4",
    "parentSpanId": "01JMG0CYTDCQKVMVJFR5M4A8HF"
  },
  "payload": {
    "runId": "01JMG0C5WNN12RG7P0X9H8Y5NF",
    "toolCallId": "01JMG0EXR2D5DA2P64XEPYFW5W",
    "toolName": "read_file",
    "status": "completed",
    "durationMs": 184,
    "success": true
  }
}
```

## 10) Envelope Invariants (Locked for v1)

The following invariants are normative for all telemetry envelopes in `telemetry.v1`:

- `version` MUST be exactly `telemetry.v1`.
- `id` MUST be a non-empty string, MUST NOT include `\n` or `\r`, and MUST be <= 256 chars.
- `machineId` MUST be a non-empty string, MUST NOT include `\n` or `\r`, and MUST be <= 256 chars.
- `ts` MUST be a valid ISO-8601 UTC timestamp.
- `severity` MUST be one of: `debug | info | warn | error | critical`.
- `type` MUST be one of the v1 event types in this spec.
- `trace.traceId` MUST be a non-empty string.
- Envelope JSON payload size SHOULD be bounded by implementation to mitigate memory pressure and abuse.

Forward-compatibility rules remain unchanged:

- Consumers MUST ignore unknown extra fields.
- Unknown event types MUST NOT crash stream processing.

## 11) Batch Ingest Semantics (`POST /ingest/batch`)

`/ingest/batch` is additive and does not replace `/ingest`.

Request contract:

- Method: `POST`
- Path: `/ingest/batch`
- Content-Type: `application/json`
- Auth: same as `/ingest`
- Body:

```json
{
  "events": [
    { "version": "telemetry.v1", "...": "envelope-1" },
    { "version": "telemetry.v1", "...": "envelope-2" }
  ]
}
```

Semantics:

- Processing is **non-atomic**. Each event is validated and ingested independently.
- Partial success is expected and valid.
- Empty batch (`events: []`) is valid.

Response contract (`200 OK`):

```json
{
  "accepted": [{ "index": 0, "event": { "...": "normalized event" } }],
  "rejected": [{ "index": 1, "error": { "code": "invalid_envelope", "message": "..." } }],
  "acceptedCount": 1,
  "rejectedCount": 1
}
```

Rules:

- `index` is the zero-based position from request array.
- `accepted` and `rejected` MUST be deterministic and index-addressable.
- Status codes:
  - `200` for valid batch shape (even with partial rejection)
  - `400` for invalid batch request shape
  - `401` unauthorized
  - `415` unsupported media type

Idempotency note:

- v1 does not guarantee server-side deduplication for repeated events with identical IDs.
- Clients SHOULD avoid retries that duplicate already accepted events unless they can tolerate duplicates.
