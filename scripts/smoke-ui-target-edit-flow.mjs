import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  randomPort,
  requestJson,
  sleep,
  spawnProcess,
  terminate,
  waitForHttpOk,
  writeFakeOpenClawCli,
  writeFixtureOpenClawHome,
} from './smoke-utils.mjs';

async function run() {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'patze-ui-target-edit-smoke-'));
  const settingsDir = path.join(tempRoot, 'settings');
  const openclawHome = path.join(tempRoot, 'openclaw-home');
  const fakeBinDir = path.join(tempRoot, 'fake-bin');
  const apiPort = randomPort(19_700, 300);
  const uiPort = randomPort(15_120, 300);
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
  const ui = spawnProcess(
    'pnpm',
    ['--filter', '@patze/desktop', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(uiPort)],
    {}
  );

  let browser = null;
  try {
    await waitForHttpOk(`${apiBase}/health`);
    await waitForHttpOk(`${uiBase}/`);

    const beforeTargets = await requestJson(apiBase, '/openclaw/targets');
    const beforeTargetCount = Array.isArray(beforeTargets.data?.targets)
      ? beforeTargets.data.targets.length
      : 0;
    if (beforeTargetCount === 0) {
      throw new Error('UI target-edit smoke failed: missing baseline target');
    }
    const seedLabel = `UI Smoke Seed ${Date.now().toString(36)}`;
    const createTarget = await requestJson(apiBase, '/openclaw/targets', {
      method: 'POST',
      body: JSON.stringify({
        label: seedLabel,
        type: 'local',
        origin: 'smoke',
        openclawDir: '~/.openclaw',
        pollIntervalMs: 5_000,
      }),
    });
    if (!createTarget.ok || typeof createTarget.data?.id !== 'string') {
      throw new Error(
        `UI target-edit smoke failed: cannot create smoke target (${String(createTarget.status)})`
      );
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

    await page.goto(`${uiBase}/#/tasks`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Scheduled Tasks', { timeout: 30_000 });
    await page.getByRole('button', { name: 'OpenClaw' }).click();
    await page.getByRole('button', { name: '+ Target' }).waitFor({ timeout: 30_000 });
    const showTestTargetsBtn = page.getByRole('button', { name: /show test targets/i }).first();
    if (await showTestTargetsBtn.isVisible().catch(() => false)) {
      await showTestTargetsBtn.click();
    }

    const targetCard = page
      .locator('.target-card', {
        has: page.locator('.target-card-label', { hasText: seedLabel }),
      })
      .first();
    await targetCard.waitFor({ timeout: 10_000 });
    await targetCard.locator('.target-card-actions button', { hasText: 'Edit' }).click();
    await page.waitForSelector('text=Edit OpenClaw Target', { timeout: 10_000 });

    const label = `UI Smoke Target ${Date.now().toString(36)}`;
    const openclawDir = '~/.openclaw';
    await page.locator('.dialog-field', { hasText: 'Label' }).locator('input').first().fill(label);
    await page
      .locator('.dialog-field', { hasText: 'Type' })
      .locator('select')
      .first()
      .selectOption('remote');
    await page
      .locator('.dialog-field', { hasText: 'OpenClaw Directory' })
      .locator('input')
      .first()
      .fill(openclawDir);
    await page
      .locator('.dialog-field', { hasText: 'Poll Interval (seconds)' })
      .locator('input')
      .first()
      .fill('45');
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await sleep(1_200);

    const afterTargets = await requestJson(apiBase, '/openclaw/targets');
    if (!afterTargets.ok) {
      throw new Error(
        `UI target-edit smoke failed: /openclaw/targets returned HTTP ${String(afterTargets.status)}`
      );
    }
    const edited = afterTargets.data?.targets?.find(
      (entry) => entry?.target?.label === label
    )?.target;
    if (!edited) {
      throw new Error('UI target-edit smoke failed: could not find updated target by label');
    }
    if (edited.type !== 'remote') {
      throw new Error(`UI target-edit smoke failed: expected type remote, got "${edited.type}"`);
    }
    if (edited.pollIntervalMs !== 45_000) {
      throw new Error(
        `UI target-edit smoke failed: expected pollIntervalMs 45000, got ${String(edited.pollIntervalMs)}`
      );
    }
    if (edited.origin !== 'smoke') {
      throw new Error(`UI target-edit smoke failed: expected origin smoke, got "${edited.origin}"`);
    }

    process.stdout.write(
      `UI target-edit smoke passed: label="${label}", origin="${edited.origin}", interval=${String(edited.pollIntervalMs)}\n`
    );
  } finally {
    if (browser) await browser.close().catch(() => {});
    await terminate(ui);
    await terminate(api);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${msg}\n`);
  process.exitCode = 1;
});
