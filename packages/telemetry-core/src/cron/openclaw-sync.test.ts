import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { OpenClawCronSync } from './openclaw-sync.js';
import type { OpenClawCronJob } from './openclaw-reader.js';
import type { ScheduledTask } from './types.js';

function createTempOpenClawDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'patze-openclaw-sync-'));
}

function writeJobs(openclawDir: string, jobs: readonly OpenClawCronJob[]): void {
  const cronDir = path.join(openclawDir, 'cron');
  fs.mkdirSync(cronDir, { recursive: true });
  fs.writeFileSync(
    path.join(cronDir, 'jobs.json'),
    JSON.stringify({ version: 1, jobs }, null, 2),
    'utf-8'
  );
}

function sampleJob(overrides: Partial<OpenClawCronJob> = {}): OpenClawCronJob {
  return {
    jobId: 'job_1',
    name: 'Main Job',
    schedule: {
      kind: 'cron',
      expr: '*/5 * * * *',
      at: undefined,
      everyMs: undefined,
      anchorMs: undefined,
      tz: 'UTC',
      staggerMs: undefined,
    },
    execution: { style: 'main', agentId: undefined, sessionTag: undefined },
    payload: undefined,
    delivery: {
      mode: 'none',
      channel: undefined,
      to: undefined,
      bestEffort: undefined,
      webhookUrl: undefined,
      webhookMethod: undefined,
      channelId: undefined,
    },
    sessionTarget: undefined,
    wakeMode: undefined,
    deleteAfterRun: undefined,
    enabled: true,
    createdAt: '2026-02-20T00:00:00.000Z',
    updatedAt: undefined,
    lastRunAt: '2026-02-20T00:05:00.000Z',
    lastStatus: 'ok',
    nextRunAtMs: undefined,
    lastError: undefined,
    lastDurationMs: undefined,
    lastDelivered: undefined,
    consecutiveErrors: 0,
    ...overrides,
  };
}

test('openclaw sync reads jobs and marks available', () => {
  const openclawDir = createTempOpenClawDir();
  writeJobs(openclawDir, [sampleJob()]);

  const sync = new OpenClawCronSync({ openclawDir, pollIntervalMs: 5_000 });
  assert.equal(sync.available, true);
  sync.start();
  const jobs = sync.getJobs();
  sync.stop();

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.jobId, 'job_1');
});

test('openclaw sync maps webhook job to scheduled task', () => {
  const sync = new OpenClawCronSync({ openclawDir: createTempOpenClawDir() });
  const job = sampleJob({
    jobId: 'deliver_job',
    delivery: {
      mode: 'webhook',
      channel: 'slack',
      to: 'https://example.com/hook',
      bestEffort: true,
      webhookUrl: 'https://example.com/hook',
      webhookMethod: 'POST',
      channelId: undefined,
    },
    enabled: false,
    lastStatus: 'timeout',
    lastError: 'timed out',
    nextRunAtMs: Date.now() + 60_000,
    consecutiveErrors: 2,
  });

  const task = sync.toScheduledTask(job);
  assert.equal(task.id, 'oc:deliver_job');
  assert.equal(task.status, 'disabled');
  assert.equal(task.lastRunStatus, 'error');
  assert.equal(task.lastRunError, 'timed out');
  assert.ok(typeof task.nextRunAtMs === 'number');
  assert.equal(task.action.action, 'custom_webhook');
  assert.deepEqual(task.action.params, {
    url: 'https://example.com/hook',
    method: 'POST',
  });
});

test('openclaw sync maps runs into task records with oc prefix', () => {
  const sync = new OpenClawCronSync({ openclawDir: createTempOpenClawDir() });
  const records = sync.toRunRecords([
    {
      jobId: 'job_a',
      runId: 'run_1',
      startedAt: '2026-02-20T01:00:00.000Z',
      endedAt: '2026-02-20T01:00:02.000Z',
      status: 'timeout',
      error: 'Timed out',
      durationMs: 2000,
      sessionId: undefined,
    },
  ]);

  assert.equal(records.length, 1);
  assert.equal(records[0]?.taskId, 'oc:job_a');
  assert.equal(records[0]?.status, 'timeout');
  assert.equal(records[0]?.durationMs, 2000);
});

test('openclaw sync creates merged view', () => {
  const openclawDir = createTempOpenClawDir();
  writeJobs(openclawDir, [sampleJob()]);
  const sync = new OpenClawCronSync({ openclawDir });
  sync.start();

  const patzeTask: ScheduledTask = {
    id: 'task_1',
    name: 'Local Task',
    description: undefined,
    schedule: { kind: 'every', everyMs: 60_000 },
    action: { action: 'health_check' },
    status: 'enabled',
    createdAt: '2026-02-20T00:00:00.000Z',
    updatedAt: '2026-02-20T00:00:00.000Z',
    lastRunAt: undefined,
    lastRunStatus: undefined,
    lastRunError: undefined,
    nextRunAtMs: undefined,
    consecutiveErrors: 0,
    totalRuns: 0,
    timeoutMs: 60_000,
  };

  const view = sync.createMergedView([patzeTask]);
  sync.stop();
  assert.equal(view.patzeTasks.length, 1);
  assert.equal(view.openclawJobs.length, 1);
  assert.equal(view.openclawJobs[0]?.jobId, 'job_1');
  assert.ok(view.timestamp > 0);
});

test('openclaw sync status reports standby when jobs file missing', () => {
  const sync = new OpenClawCronSync({
    openclawDir: createTempOpenClawDir(),
    pollIntervalMs: 1_000,
  });
  sync.start();
  const status = sync.getStatus();
  sync.stop();
  assert.equal(status.running, true);
  assert.equal(status.available, false);
  assert.equal(status.jobsCount, 0);
});
