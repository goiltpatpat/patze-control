import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  randomPort,
  requestJson,
  spawnProcess,
  terminate,
  waitForHttpOk,
  writeFakeOpenClawCli,
  writeFixtureOpenClawHome,
} from './smoke-utils.mjs';

async function waitForRecipesReady(page) {
  await page.waitForURL(/#\/recipes/, { timeout: 60_000 });
  const recipeCard = page.locator('.machine-card', { hasText: 'Add Telegram Bot' }).first();
  await recipeCard.waitFor({ state: 'visible', timeout: 120_000 });
}

async function run() {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'patze-ui-smoke-'));
  const settingsDir = path.join(tempRoot, 'settings');
  const openclawHome = path.join(tempRoot, 'openclaw-home');
  const fakeBinDir = path.join(tempRoot, 'fake-bin');
  const apiPort = randomPort(19_700, 400);
  const uiPort = randomPort(15_120, 500);
  const apiBase = `http://127.0.0.1:${String(apiPort)}`;
  const uiBase = `http://127.0.0.1:${String(uiPort)}`;

  writeFixtureOpenClawHome(openclawHome);
  writeFakeOpenClawCli(fakeBinDir);

  const api = spawnProcess(
    'pnpm',
    ['--filter', '@patze/api-server', 'exec', 'tsx', 'src/index.ts'],
    {
      HOST: '127.0.0.1',
      PORT: String(apiPort),
      TELEMETRY_AUTH_MODE: 'none',
      PATZE_SETTINGS_DIR: settingsDir,
      OPENCLAW_HOME: openclawHome,
      OPENCLAW_BIN: '/bin/true',
      PATH: `${fakeBinDir}:${process.env.PATH ?? ''}`,
    }
  );

  let apiErr = '';
  api.stderr.on('data', (chunk) => {
    apiErr += String(chunk);
  });

  const ui = spawnProcess(
    'pnpm',
    ['--filter', '@patze/desktop', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(uiPort)],
    {}
  );
  let uiErr = '';
  ui.stderr.on('data', (chunk) => {
    uiErr += String(chunk);
  });

  let browser = null;
  try {
    await waitForHttpOk(`${apiBase}/health`);
    await waitForHttpOk(`${uiBase}/`);

    const targetsRes = await requestJson(apiBase, '/openclaw/targets');
    const localTargetEntry = Array.isArray(targetsRes.data?.targets)
      ? targetsRes.data.targets.find((entry) => entry?.target?.type === 'local')
      : null;
    const selectedTargetEntry = localTargetEntry ?? targetsRes.data?.targets?.[0];
    const targetIdFromBootstrap = selectedTargetEntry?.target?.id;
    if (typeof targetIdFromBootstrap !== 'string' || targetIdFromBootstrap.length === 0) {
      throw new Error('UI smoke failed: missing bootstrap target id');
    }
    const selectedTargetDir = selectedTargetEntry?.target?.openclawDir;
    if (typeof selectedTargetDir === 'string' && selectedTargetDir.length > 0) {
      mkdirSync(selectedTargetDir, { recursive: true });
      writeFixtureOpenClawHome(selectedTargetDir);
    }
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.addInitScript(
      ({ baseUrl }) => {
        localStorage.setItem('patze_base_url', baseUrl);
        localStorage.setItem('patze_token', '');
      },
      { baseUrl: apiBase }
    );
    const page = await context.newPage();

    await page.goto(`${uiBase}/#/recipes`, { waitUntil: 'domcontentloaded' });
    await waitForRecipesReady(page);
    await page.locator('.machine-card', { hasText: 'Add Telegram Bot' }).first().click();
    await page.waitForSelector('text=Add Telegram Bot', { timeout: 10_000 });
    await page.getByLabel(/Telegram Bot Token/).fill('ui-smoke-token');
    await page.getByLabel(/DM Policy/).selectOption('allow');
    await page.getByRole('button', { name: 'Validate' }).click();
    await page.getByRole('button', { name: 'Preview' }).click();
    const params = { botToken: 'ui-smoke-token', dmPolicy: 'allow' };
    const applyRes = await requestJson(apiBase, '/recipes/add-telegram-bot/apply', {
      method: 'POST',
      body: JSON.stringify({ targetId: targetIdFromBootstrap, params }),
    });
    if (
      !applyRes.ok ||
      applyRes.data?.ok !== true ||
      typeof applyRes.data?.snapshotId !== 'string'
    ) {
      throw new Error(
        `UI smoke failed: API apply failed (${String(applyRes.status)}) body=${JSON.stringify(applyRes.data)}`
      );
    }
    await page.goto(`${uiBase}/#/tasks`, { waitUntil: 'domcontentloaded' });
    await page.waitForURL(/#\/tasks/, { timeout: 15_000 });

    const targetId = targetIdFromBootstrap;
    const latestSnapshotId = applyRes.data.snapshotId;
    if (typeof latestSnapshotId !== 'string' || latestSnapshotId.length === 0) {
      throw new Error('UI smoke failed: snapshot list is empty');
    }
    const rollbackRes = await requestJson(
      apiBase,
      `/openclaw/targets/${encodeURIComponent(targetId)}/config-snapshots/${encodeURIComponent(latestSnapshotId)}/rollback`,
      { method: 'POST' }
    );
    if (!rollbackRes.ok || rollbackRes.data?.ok !== true) {
      throw new Error(`UI smoke failed: rollback endpoint failed (${String(rollbackRes.status)})`);
    }

    process.stdout.write(
      `UI smoke passed: route=#/tasks, target=${targetId}, rollback=${latestSnapshotId}\n`
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
    await terminate(ui);
    await terminate(api);
    rmSync(tempRoot, { recursive: true, force: true });
  }

  if (apiErr.includes('Error:') || uiErr.includes('Error:')) {
    // non-fatal logs are okay during dev boot, but preserve diagnostics when severe
    process.stderr.write(`${apiErr}${uiErr}`);
  }
}

run().catch((error) => {
  const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${msg}\n`);
  process.exitCode = 1;
});
