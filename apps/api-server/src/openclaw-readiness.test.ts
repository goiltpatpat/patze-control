import assert from 'node:assert/strict';
import { test } from 'node:test';
import { computeReadinessScore, deriveReadinessRootCause } from './openclaw-readiness.js';

test('computeReadinessScore penalizes warn and error checks', () => {
  const score = computeReadinessScore([
    { id: 'bridge-connected', status: 'warn', detail: 'No bridge connections' },
    { id: 'targets-available', status: 'error', detail: 'No targets configured' },
    { id: 'sync-running', status: 'ok', detail: 'All running' },
  ]);
  assert.equal(score, 63);
});

test('deriveReadinessRootCause prioritizes errors over warnings', () => {
  const rootCause = deriveReadinessRootCause([
    { id: 'recent-runs', status: 'warn', detail: 'No runs in last 15 minutes' },
    { id: 'targets-available', status: 'error', detail: 'No targets configured' },
  ]);
  assert.deepEqual(rootCause, {
    severity: 'error',
    detail: 'No targets configured',
  });
});
