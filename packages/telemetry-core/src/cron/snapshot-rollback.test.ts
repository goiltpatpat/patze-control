import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { CronService } from './service.js';
import { TaskSnapshotStore } from './snapshot.js';

function createTempStoreDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'patze-cron-store-'));
}

test('snapshot store captures, lists, and loads snapshot data', () => {
  const storeDir = createTempStoreDir();
  const snapshots = new TaskSnapshotStore(storeDir);

  const first = snapshots.capture({ version: 1, tasks: [] }, 'manual', 'Initial empty state');
  const second = snapshots.capture({ version: 1, tasks: [] }, 'manual', 'Second state');

  const listed = snapshots.list(10, 0);
  assert.equal(listed.length, 2);
  assert.equal(listed[0]?.id, second.id);
  assert.equal(listed[1]?.id, first.id);

  const loaded = snapshots.getSnapshotData(first.id);
  assert.ok(loaded);
  assert.equal(loaded?.version, 1);
  assert.deepEqual(loaded?.tasks, []);
});

test('cron service rollback restores task state from snapshot', async () => {
  const storeDir = createTempStoreDir();
  const service = new CronService({
    storeDir,
    executor: async () => ({ ok: true }),
  });

  const created = await service.add({
    id: 'task_alpha',
    name: 'Alpha',
    description: 'before update',
    schedule: { kind: 'every', everyMs: 60_000 },
    action: { action: 'health_check' },
    timeoutMs: 30_000,
  });
  assert.equal(created.name, 'Alpha');

  const updated = await service.update('task_alpha', {
    name: 'Alpha Updated',
    description: 'after update',
  });
  assert.equal(updated?.name, 'Alpha Updated');

  const snapshots = service.listSnapshots(10, 0);
  const beforeUpdateSnapshot = snapshots.find((s) => s.source === 'update');
  assert.ok(beforeUpdateSnapshot);

  const restored = await service.rollback(beforeUpdateSnapshot!.id);
  assert.ok(restored);
  assert.equal(restored?.length, 1);
  assert.equal(restored?.[0]?.name, 'Alpha');
  assert.equal(restored?.[0]?.description, 'before update');
});

test('cron service rollback returns null for unknown snapshot id', async () => {
  const service = new CronService({
    storeDir: createTempStoreDir(),
    executor: async () => ({ ok: true }),
  });
  const restored = await service.rollback('missing_snapshot');
  assert.equal(restored, null);
});
