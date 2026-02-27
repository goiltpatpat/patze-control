import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  DEFAULT_POLL_INTERVAL_MS,
  randomPort,
  requestJson,
  sleep,
  spawnProcess,
  terminate,
  waitForHttpOk,
  writeFakeOpenClawCli,
  writeFixtureOpenClawHome,
} from './smoke-utils.mjs';

const TARGET_ALPHA_LABEL = 'Multi Target Alpha';
const TARGET_BETA_LABEL = 'Multi Target Beta';

function writeJobsFixture(targetDir, jobId, jobName) {
  const cronDir = path.join(targetDir, 'cron');
  const configDir = path.join(targetDir, 'config');
  mkdirSync(cronDir, { recursive: true });
  mkdirSync(path.join(cronDir, 'runs'), { recursive: true });
  mkdirSync(configDir, { recursive: true });
  const jobs = {
    version: 1,
    jobs: [
      {
        jobId,
        name: jobName,
        schedule: { kind: 'every', everyMs: 60_000 },
        execution: { style: 'main' },
        delivery: { mode: 'none' },
        enabled: true,
        createdAt: '2026-02-01T00:00:00.000Z',
      },
    ],
  };
  writeFileSync(path.join(cronDir, 'jobs.json'), JSON.stringify(jobs, null, 2), 'utf-8');
  writeFileSync(
    path.join(configDir, 'openclaw.json'),
    JSON.stringify({ channels: {} }, null, 2),
    'utf-8'
  );
}

async function waitForTargetJobs(baseUrl, targetIds) {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    let allReady = true;
    for (const id of targetIds) {
      const res = await requestJson(baseUrl, `/openclaw/targets/${encodeURIComponent(id)}/jobs`);
      const jobs = Array.isArray(res.data?.jobs) ? res.data.jobs : [];
      if (!res.ok || jobs.length === 0) {
        allReady = false;
        break;
      }
    }
    if (allReady) return;
    await sleep(700);
  }
  throw new Error('UI multi-target smoke failed: targets did not report jobs in time');
}

async function waitForSelectedCard(page, label) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const selectedCount = await page
      .locator('.target-card.target-card-selected .target-card-label', { hasText: label })
      .count();
    if (selectedCount > 0) return;
    await sleep(200);
  }
  throw new Error(`UI multi-target smoke failed: card not selected for ${label}`);
}

async function ensureTargetCardsVisible(page) {
  const cards = page.locator('.target-card');
  try {
    await cards.first().waitFor({ timeout: 8_000 });
    return;
  } catch {
    const selector = page.locator('select[aria-label="Active OpenClaw target"]').first();
    if ((await selector.count()) > 0) {
      await selector.selectOption({ label: TARGET_ALPHA_LABEL }).catch(() => {});
      await sleep(600);
    }
    await cards.first().waitFor({ timeout: 30_000 });
  }
}

async function selectTargetFromHeader(page, targetId) {
  const selector = page
    .locator('header.context-bar select[aria-label="Active OpenClaw target"]')
    .first();
  if ((await selector.count()) === 0) return;
  await selector.selectOption(targetId).catch(() => {});
  await sleep(500);
}

async function openOpenClawTab(page) {
  const deadline = Date.now() + 30_000;
  let lastDiagnostics = 'n/a';
  const connectButton = page.locator('header.context-bar button', { hasText: 'Connect' }).first();
  const openClawTab = page
    .locator('.tasks-view-toolbar .filter-tabs button', { hasText: 'OpenClaw' })
    .first();

  while (Date.now() < deadline) {
    if (!page.url().includes('#/tasks')) {
      await page.evaluate(() => {
        if (window.location.hash !== '#/tasks') {
          window.location.hash = '#/tasks';
        }
      });
      await sleep(250);
    }
    if ((await page.locator('.target-card').count()) > 0) return;
    if ((await page.getByRole('button', { name: '+ Target' }).count()) > 0) return;

    const connectCount = await connectButton.count();
    const connectEnabled =
      connectCount > 0 ? await connectButton.isEnabled().catch(() => false) : false;
    if (connectCount > 0 && connectEnabled) {
      await connectButton.click().catch(() => {});
    }
    lastDiagnostics = `connectCount=${String(connectCount)} connectEnabled=${String(connectEnabled)} url=${page.url()}`;

    if ((await openClawTab.count()) > 0) {
      try {
        await openClawTab.click({ timeout: 2_000 });
        await page.getByRole('button', { name: '+ Target' }).first().waitFor({ timeout: 2_000 });
        return;
      } catch {
        // keep polling
      }
    }
    await sleep(DEFAULT_POLL_INTERVAL_MS);
  }
  throw new Error(
    `UI multi-target smoke failed: cannot open OpenClaw tab in time (${lastDiagnostics})`
  );
}

async function run() {
  const tempRoot = path.join(
    os.homedir(),
    '.openclaw',
    `patze-e2e-multi-${Date.now().toString(36)}`
  );
  const settingsDir = path.join(tempRoot, 'settings');
  const openclawHome = path.join(tempRoot, 'openclaw-default');
  const fakeBinDir = path.join(tempRoot, 'fake-bin');
  const targetADir = path.join(tempRoot, 'target-a');
  const targetBDir = path.join(tempRoot, 'target-b');

  const apiPort = randomPort(19_700, 200);
  const uiPort = randomPort(15_120, 200);
  const apiBase = `http://127.0.0.1:${String(apiPort)}`;
  const uiBase = `http://127.0.0.1:${String(uiPort)}`;

  mkdirSync(tempRoot, { recursive: true });
  writeFixtureOpenClawHome(openclawHome);
  writeJobsFixture(targetADir, 'job_alpha', 'Smoke Multi Job Alpha');
  writeJobsFixture(targetBDir, 'job_beta', 'Smoke Multi Job Beta');
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

    const createA = await requestJson(apiBase, '/openclaw/targets', {
      method: 'POST',
      body: JSON.stringify({
        label: TARGET_ALPHA_LABEL,
        type: 'local',
        openclawDir: targetADir,
        pollIntervalMs: 1_000,
      }),
    });
    if (!createA.ok || typeof createA.data?.id !== 'string') {
      throw new Error(
        `UI multi-target smoke failed: cannot create target A (${String(createA.status)})`
      );
    }
    const createB = await requestJson(apiBase, '/openclaw/targets', {
      method: 'POST',
      body: JSON.stringify({
        label: TARGET_BETA_LABEL,
        type: 'remote',
        openclawDir: targetBDir,
        pollIntervalMs: 1_000,
      }),
    });
    if (!createB.ok || typeof createB.data?.id !== 'string') {
      throw new Error(
        `UI multi-target smoke failed: cannot create target B (${String(createB.status)})`
      );
    }

    await waitForTargetJobs(apiBase, [createA.data.id, createB.data.id]);

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
    const connectButton = page.locator('header.context-bar button', { hasText: 'Connect' }).first();
    if ((await connectButton.count()) > 0 && (await connectButton.isEnabled())) {
      await connectButton.click();
    }
    const disconnectButton = page
      .locator('header.context-bar button', { hasText: 'Disconnect' })
      .first();
    if ((await disconnectButton.count()) > 0) {
      await disconnectButton.waitFor({ timeout: 30_000 });
    }
    await selectTargetFromHeader(page, createA.data.id);
    await openOpenClawTab(page);
    await ensureTargetCardsVisible(page);

    await page
      .locator('.target-card .target-card-label', { hasText: TARGET_ALPHA_LABEL })
      .first()
      .click();
    await waitForSelectedCard(page, TARGET_ALPHA_LABEL);

    await page
      .locator('.target-card .target-card-label', { hasText: TARGET_BETA_LABEL })
      .first()
      .click();
    await waitForSelectedCard(page, TARGET_BETA_LABEL);
    await sleep(2_500);
    await waitForSelectedCard(page, TARGET_BETA_LABEL);

    process.stdout.write(
      `UI multi-target smoke passed: targets=${createA.data.id},${createB.data.id}\n`
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
