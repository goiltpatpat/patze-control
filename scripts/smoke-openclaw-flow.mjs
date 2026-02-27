import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  randomPort,
  requestJson,
  sleep,
  spawnProcess,
  terminate,
  writeFakeOpenClawCli,
  writeFixtureOpenClawHome,
} from './smoke-utils.mjs';

const API_START_TIMEOUT_MS = 45_000;
const POLL_INTERVAL_MS = 300;

async function waitForApiReady(baseUrl) {
  const start = Date.now();
  while (Date.now() - start < API_START_TIMEOUT_MS) {
    try {
      const result = await requestJson(baseUrl, '/snapshot', {
        method: 'GET',
        signal: AbortSignal.timeout(1_500),
      });
      if (result.ok) return;
    } catch {
      // keep polling
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`API did not become ready within ${String(API_START_TIMEOUT_MS)}ms`);
}

async function main() {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'patze-smoke-'));
  const settingsDir = path.join(tempRoot, 'settings');
  const openclawHome = path.join(tempRoot, 'openclaw-home');
  const fakeBinDir = path.join(tempRoot, 'fake-bin');
  const port = randomPort(18_000, 2_000);
  const baseUrl = `http://127.0.0.1:${String(port)}`;

  writeFixtureOpenClawHome(openclawHome);
  writeFakeOpenClawCli(fakeBinDir);

  const child = spawnProcess(
    'pnpm',
    ['--filter', '@patze/api-server', 'exec', 'tsx', 'src/index.ts'],
    {
      HOST: '127.0.0.1',
      PORT: String(port),
      TELEMETRY_AUTH_MODE: 'none',
      PATZE_SETTINGS_DIR: settingsDir,
      OPENCLAW_HOME: openclawHome,
      OPENCLAW_BIN: '/bin/true',
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    }
  );

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += String(chunk);
  });
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });

  try {
    await waitForApiReady(baseUrl);

    const targetsRes = await requestJson(baseUrl, '/openclaw/targets');
    if (
      !targetsRes.ok ||
      !Array.isArray(targetsRes.data.targets) ||
      targetsRes.data.targets.length === 0
    ) {
      throw new Error('Smoke failed: /openclaw/targets did not return targets');
    }
    const localTargetEntry = targetsRes.data.targets.find(
      (entry) => entry?.target && entry.target.type === 'local'
    );
    const selectedTargetEntry = localTargetEntry ?? targetsRes.data.targets[0];
    const targetId = selectedTargetEntry?.target?.id;
    if (typeof targetId !== 'string' || targetId.length === 0) {
      throw new Error('Smoke failed: targetId missing from /openclaw/targets');
    }
    const selectedTargetDir = selectedTargetEntry?.target?.openclawDir;
    if (typeof selectedTargetDir === 'string' && selectedTargetDir.length > 0) {
      mkdirSync(selectedTargetDir, { recursive: true });
      writeFixtureOpenClawHome(selectedTargetDir);
    }

    const readinessRes = await requestJson(baseUrl, '/openclaw/readiness');
    if (!readinessRes.ok || typeof readinessRes.data.score !== 'number') {
      throw new Error('Smoke failed: /openclaw/readiness missing numeric score');
    }

    const params = { botToken: 'smoke-token', dmPolicy: 'allow' };
    const validateRes = await requestJson(baseUrl, '/recipes/add-telegram-bot/validate', {
      method: 'POST',
      body: JSON.stringify({ targetId, params }),
    });
    if (!validateRes.ok || validateRes.data.ok !== true) {
      throw new Error(`Smoke failed: recipe validate failed (${String(validateRes.status)})`);
    }

    const previewRes = await requestJson(baseUrl, '/recipes/add-telegram-bot/preview', {
      method: 'POST',
      body: JSON.stringify({ targetId, params }),
    });
    if (!previewRes.ok || previewRes.data.ok !== true) {
      throw new Error(`Smoke failed: recipe preview failed (${String(previewRes.status)})`);
    }

    const applyRes = await requestJson(baseUrl, '/recipes/add-telegram-bot/apply', {
      method: 'POST',
      body: JSON.stringify({ targetId, params }),
    });
    if (!applyRes.ok || applyRes.data.ok !== true || typeof applyRes.data.snapshotId !== 'string') {
      throw new Error(
        `Smoke failed: recipe apply failed (${String(applyRes.status)}) body=${JSON.stringify(applyRes.data)}`
      );
    }

    const rollbackRes = await requestJson(
      baseUrl,
      `/openclaw/targets/${encodeURIComponent(targetId)}/config-snapshots/${encodeURIComponent(applyRes.data.snapshotId)}/rollback`,
      {
        method: 'POST',
      }
    );
    if (!rollbackRes.ok || rollbackRes.data.ok !== true) {
      throw new Error(
        `Smoke failed: rollback failed (${String(rollbackRes.status)}) body=${JSON.stringify(rollbackRes.data)}`
      );
    }

    process.stdout.write(
      `Smoke openclaw flow passed: target=${targetId}, readiness=${String(readinessRes.data.score)}, snapshot=${applyRes.data.snapshotId}\n`
    );
  } finally {
    await terminate(child);
    rmSync(tempRoot, { recursive: true, force: true });
  }

  if (stderr.length > 0 && !stdout.includes('Server listening')) {
    process.stderr.write(stderr);
  }
}

main().catch((error) => {
  const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${msg}\n`);
  process.exitCode = 1;
});
