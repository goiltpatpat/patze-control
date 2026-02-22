import assert from 'node:assert/strict';
import test from 'node:test';
import { OpenClawCronReader, type FileSystemReader } from './openclaw-reader.js';

function mockFs(files: Record<string, string>): FileSystemReader {
  return {
    exists: (filePath) =>
      Object.prototype.hasOwnProperty.call(files, filePath) ||
      Object.keys(files).some((p) => p.startsWith(`${filePath}/`)),
    readFile: (filePath) => {
      const data = files[filePath];
      if (data === undefined) {
        throw new Error(`File not found: ${filePath}`);
      }
      return data;
    },
    readDir: (dirPath) => {
      const prefix = `${dirPath}/`;
      const names = new Set<string>();
      for (const filePath of Object.keys(files)) {
        if (!filePath.startsWith(prefix)) continue;
        const rest = filePath.slice(prefix.length);
        if (rest.length === 0) continue;
        const firstSlash = rest.indexOf('/');
        names.add(firstSlash === -1 ? rest : rest.slice(0, firstSlash));
      }
      return [...names];
    },
  };
}

test('openclaw reader parses wrapped jobs format', () => {
  const baseDir = '/mock-openclaw';
  const fs = mockFs({
    [`${baseDir}/cron/jobs.json`]: JSON.stringify({
      version: 1,
      jobs: [
        {
          jobId: 'job_health',
          name: 'Health Check',
          schedule: { kind: 'cron', expr: '*/5 * * * *', timezone: 'UTC' },
          execution: { style: 'main' },
          delivery: { mode: 'none' },
          enabled: true,
          createdAt: '2026-02-20T00:00:00.000Z',
          lastStatus: 'ok',
        },
        {
          jobId: 'invalid_without_schedule',
        },
      ],
    }),
  });

  const reader = new OpenClawCronReader(baseDir, fs);
  const jobs = reader.readJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.jobId, 'job_health');
  assert.equal(jobs[0]?.schedule.kind, 'cron');
  assert.equal(jobs[0]?.schedule.tz, 'UTC');
});

test('openclaw reader parses object jobs format with fallback id', () => {
  const baseDir = '/mock-openclaw';
  const fs = mockFs({
    [`${baseDir}/cron/jobs.json`]: JSON.stringify({
      version: 1,
      nightly_report: {
        name: 'Nightly Report',
        schedule: { type: 'every', intervalMs: 60000 },
        execution: { style: 'isolated', agentId: 'agent_1' },
        delivery: { mode: 'announce', channelId: 'ops' },
        createdAt: '2026-02-20T00:00:00.000Z',
      },
    }),
  });

  const reader = new OpenClawCronReader(baseDir, fs);
  const jobs = reader.readJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.jobId, 'nightly_report');
  assert.equal(jobs[0]?.execution.style, 'isolated');
  assert.equal(jobs[0]?.schedule.everyMs, 60000);
  assert.equal(jobs[0]?.delivery.mode, 'announce');
});

test('openclaw reader reads runs newest-first with limit', () => {
  const baseDir = '/mock-openclaw';
  const fs = mockFs({
    [`${baseDir}/cron/runs/job_alpha.jsonl`]: [
      JSON.stringify({
        jobId: 'job_alpha',
        runId: 'run_1',
        startedAt: '2026-02-20T00:00:00.000Z',
        status: 'ok',
      }),
      'not-json-line',
      JSON.stringify({
        jobId: 'job_alpha',
        runId: 'run_2',
        startedAt: '2026-02-20T00:01:00.000Z',
        status: 'error',
        error: 'boom',
      }),
      JSON.stringify({
        jobId: 'job_alpha',
        runId: 'run_3',
        startedAt: '2026-02-20T00:02:00.000Z',
        status: 'timeout',
      }),
    ].join('\n'),
  });

  const reader = new OpenClawCronReader(baseDir, fs);
  const runs = reader.readRuns('job_alpha', 2);
  assert.equal(runs.length, 2);
  assert.equal(runs[0]?.runId, 'run_3');
  assert.equal(runs[1]?.runId, 'run_2');
});

test('openclaw reader lists run job ids from runs folder', () => {
  const baseDir = '/mock-openclaw';
  const fs = mockFs({
    [`${baseDir}/cron/runs/a.jsonl`]: '',
    [`${baseDir}/cron/runs/b.jsonl`]: '',
    [`${baseDir}/cron/runs/readme.txt`]: '',
  });

  const reader = new OpenClawCronReader(baseDir, fs);
  const ids = reader.listRunJobIds().sort();
  assert.deepEqual(ids, ['a', 'b']);
});
