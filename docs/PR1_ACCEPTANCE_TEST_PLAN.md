# PR1 Acceptance Criteria and Test Plan

## Scope

PR1 covers:

- Telemetry envelope contract lock for `telemetry.v1`
- Batch ingest semantics definition
- `POST /ingest/batch` endpoint implementation

## Acceptance Criteria

- Envelope invariants are documented and locked in [docs/TELEMETRY_V1_SPEC.md](docs/TELEMETRY_V1_SPEC.md).
- JSON schema artifact exists at `docs/telemetry-envelope.telemetry.v1.schema.json`.
- `POST /ingest/batch` accepts `{ "events": unknown[] }` and processes non-atomically.
- Batch response is index-addressable and deterministic:
  - `accepted`: `{ index, event }[]`
  - `rejected`: `{ index, error }[]`
  - `acceptedCount`, `rejectedCount`
- Existing endpoints remain backward-compatible:
  - `/ingest`
  - `/snapshot`
  - `/events`

## Automated Tests

Run:

```bash
pnpm --filter @patze/telemetry-core test
```

Coverage in `packages/telemetry-core/src/ingestor.test.ts`:

- Rejects newline in `id`
- Rejects oversized `machineId`
- Rejects oversized payload

## Manual Verification

Start server:

```bash
pnpm dev:api-server
```

### 1) Valid mixed batch (expect partial success, HTTP 200)

```bash
curl -sS -X POST "http://127.0.0.1:8080/ingest/batch" \
  -H "Content-Type: application/json" \
  -d '{
    "events": [
      {
        "version":"telemetry.v1",
        "id":"evt_ok_1",
        "ts":"2026-02-21T00:00:00.000Z",
        "machineId":"machine_a",
        "severity":"info",
        "type":"machine.heartbeat",
        "payload":{"machineId":"machine_a","status":"online","resource":{"cpuPct":1,"memoryBytes":1,"memoryPct":1}},
        "trace":{"traceId":"trace_a"}
      },
      {
        "version":"telemetry.v1",
        "id":"evt_bad_1",
        "ts":"invalid-date",
        "machineId":"machine_a",
        "severity":"info",
        "type":"machine.heartbeat",
        "payload":{"machineId":"machine_a","status":"online","resource":{"cpuPct":1,"memoryBytes":1,"memoryPct":1}},
        "trace":{"traceId":"trace_a"}
      }
    ]
  }'
```

Expected:

- HTTP 200
- `acceptedCount = 1`
- `rejectedCount = 1`
- accepted index is `0`
- rejected index is `1`

### 2) Invalid request shape (expect HTTP 400)

```bash
curl -sS -X POST "http://127.0.0.1:8080/ingest/batch" \
  -H "Content-Type: application/json" \
  -d '{"foo":"bar"}'
```

Expected:

- HTTP 400
- `{"error":"invalid_batch_request"}`
