import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventStore } from './event-store.js';
import { DefaultTelemetryIngestor, TELEMETRY_SCHEMA_VERSION } from './ingestor.js';

function validEnvelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    version: TELEMETRY_SCHEMA_VERSION,
    id: 'evt_test_1',
    ts: '2026-02-21T00:00:00.000Z',
    machineId: 'machine_test_1',
    severity: 'info',
    type: 'machine.heartbeat',
    payload: {
      machineId: 'machine_test_1',
      status: 'online',
      resource: {
        cpuPct: 1,
        memoryBytes: 1024,
        memoryPct: 1,
      },
    },
    trace: {
      traceId: 'trace_test_1',
    },
  };

  return { ...base, ...overrides };
}

test('ingestor rejects newline in event id', () => {
  const ingestor = new DefaultTelemetryIngestor(new InMemoryEventStore());
  const result = ingestor.ingest(validEnvelope({ id: 'evt\nbad' }));
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'invalid_envelope');
  }
});

test('ingestor rejects oversized machineId', () => {
  const ingestor = new DefaultTelemetryIngestor(new InMemoryEventStore());
  const longMachineId = 'm'.repeat(300);
  const result = ingestor.ingest(
    validEnvelope({
      machineId: longMachineId,
      payload: {
        machineId: longMachineId,
        status: 'online',
        resource: {
          cpuPct: 1,
          memoryBytes: 1024,
          memoryPct: 1,
        },
      },
    })
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'invalid_envelope');
  }
});

test('ingestor rejects oversized payload', () => {
  const ingestor = new DefaultTelemetryIngestor(new InMemoryEventStore());
  const largeBlob = 'x'.repeat(600 * 1024);
  const result = ingestor.ingest(
    validEnvelope({
      payload: {
        machineId: 'machine_test_1',
        status: 'online',
        resource: {
          cpuPct: 1,
          memoryBytes: 1024,
          memoryPct: 1,
        },
        blob: largeBlob,
      },
    })
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, 'invalid_envelope');
  }
});
