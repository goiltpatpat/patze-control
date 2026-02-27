import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HttpSinkAdapter, type MachineEndpoint } from './transports.js';

function createEvent(id: string): Record<string, unknown> {
  return {
    version: 'telemetry.v1',
    id,
    ts: '2026-02-24T00:00:00.000Z',
    machineId: 'machine_test_1',
    severity: 'info',
    type: 'machine.heartbeat',
    payload: {
      machineId: 'machine_test_1',
      status: 'online',
    },
    trace: {
      traceId: `trace_${id}`,
    },
  };
}

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 3_000,
  intervalMs = 20
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Condition not met within ${String(timeoutMs)}ms`);
}

const endpoint: MachineEndpoint = {
  id: 'control-plane-test',
  label: 'Control Plane Test',
  transport: 'http',
  baseUrl: 'http://localhost:19700',
  auth: { mode: 'none' },
};

test('HttpSinkAdapter hydrates queue from spool file on startup', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'patze-transport-hydrate-'));
  const spoolPath = path.join(tmpDir, 'spool.json');
  await writeFile(
    spoolPath,
    JSON.stringify([createEvent('evt_hydrate_1'), createEvent('evt_hydrate_2')]),
    'utf8'
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
  try {
    const adapter = new HttpSinkAdapter({
      endpoint,
      maxRetries: 0,
      batchSize: 50,
      flushIntervalMs: 60_000,
      persistedQueueFilePath: spoolPath,
      persistDebounceMs: 1,
    });

    await waitFor(() => adapter.getStats().spool.hydratedCount === 2);
    const stats = adapter.getStats();
    assert.equal(stats.queueSize, 2);
    assert.equal(stats.spool.enabled, true);
    assert.equal(stats.spool.hydratedCount, 2);

    await adapter.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HttpSinkAdapter persists enqueued events to spool file', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'patze-transport-persist-'));
  const spoolPath = path.join(tmpDir, 'spool.json');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 500 })) as typeof fetch;
  try {
    const adapter = new HttpSinkAdapter({
      endpoint,
      maxRetries: 0,
      batchSize: 50,
      flushIntervalMs: 60_000,
      persistedQueueFilePath: spoolPath,
      persistDebounceMs: 1,
    });
    const result = adapter.ingest(createEvent('evt_persist_1'));
    assert.equal(result.ok, true);

    await waitFor(async () => {
      try {
        const raw = await readFile(spoolPath, 'utf8');
        const parsed = JSON.parse(raw) as unknown[];
        return parsed.length === 1;
      } catch {
        return false;
      }
    });

    const stats = adapter.getStats();
    assert.equal(stats.queueSize, 1);
    assert.equal(stats.spool.lastPersistError, null);
    assert.notEqual(stats.spool.lastPersistedAt, null);

    await adapter.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('HttpSinkAdapter updates spool after successful flush', async () => {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), 'patze-transport-flush-'));
  const spoolPath = path.join(tmpDir, 'spool.json');

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('{}', { status: 200 })) as typeof fetch;
  try {
    const adapter = new HttpSinkAdapter({
      endpoint,
      maxRetries: 0,
      batchSize: 1,
      flushIntervalMs: 60_000,
      persistedQueueFilePath: spoolPath,
      persistDebounceMs: 1,
    });
    const result = adapter.ingest(createEvent('evt_flush_1'));
    assert.equal(result.ok, true);

    await waitFor(() => adapter.getStats().queueSize === 0);
    await waitFor(async () => {
      try {
        const raw = await readFile(spoolPath, 'utf8');
        const parsed = JSON.parse(raw) as unknown[];
        return parsed.length === 0;
      } catch {
        return false;
      }
    });

    await adapter.close();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
