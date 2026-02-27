import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  randomPort,
  spawnProcess,
  terminate,
  waitForHttpOk,
  writeFakeOpenClawCli,
  writeFixtureOpenClawHome,
} from './smoke-utils.mjs';

async function run() {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'patze-ui-terminal-guard-'));
  const settingsDir = path.join(tempRoot, 'settings');
  const openclawHome = path.join(tempRoot, 'openclaw-home');
  const fakeBinDir = path.join(tempRoot, 'fake-bin');
  const apiPort = randomPort(19_300, 400);
  const uiPort = randomPort(15_800, 500);
  const apiBase = `http://127.0.0.1:${String(apiPort)}`;
  const uiBase = `http://127.0.0.1:${String(uiPort)}`;

  writeFixtureOpenClawHome(openclawHome);
  writeFakeOpenClawCli(fakeBinDir, 'ui-terminal-guard shim');

  const api = spawnProcess(
    'pnpm',
    ['--filter', '@patze/api-server', 'exec', 'tsx', 'src/index.ts'],
    {
      HOST: '127.0.0.1',
      PORT: String(apiPort),
      TELEMETRY_AUTH_MODE: 'none',
      PATZE_SETTINGS_DIR: settingsDir,
      OPENCLAW_HOME: openclawHome,
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

    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();

    await context.addInitScript(
      ({ baseUrl, selectedMachineId }) => {
        localStorage.setItem('patze_base_url', baseUrl);
        localStorage.setItem('patze_token', '');
        localStorage.setItem('patze_terminal_selected_machine', selectedMachineId);
      },
      {
        baseUrl: apiBase,
        selectedMachineId: 'remote_guard_degraded',
      }
    );

    await context.route('**/terminal/machines', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          machines: [
            {
              id: 'local',
              scope: 'local',
              label: 'Local (smoke)',
              status: 'connected',
              host: 'localhost',
            },
            {
              id: 'remote_guard_degraded',
              scope: 'remote_attachment',
              label: 'Guard Remote',
              status: 'degraded',
              host: '10.0.0.10',
            },
          ],
        }),
      });
    });

    const page = await context.newPage();
    await page.goto(`${uiBase}/#/terminal`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('text=Terminal', { timeout: 30_000 });
    const machineSelect = page.locator('select.fleet-policy-select').first();
    await machineSelect.waitFor({ state: 'visible', timeout: 30_000 });
    await machineSelect.selectOption({ label: 'Guard Remote (degraded)' });
    await page.waitForSelector(
      'text=Remote machine is degraded. Reconnect and wait for healthy status before install.',
      { timeout: 30_000 }
    );

    const actionButtons = [
      page.getByRole('button', { name: '1) Precheck' }),
      page.getByRole('button', { name: '2) Install' }),
      page.getByRole('button', { name: '3) Verify' }),
      page.getByRole('button', { name: '4) Register Target' }),
    ];
    for (const button of actionButtons) {
      const disabled = await button.isDisabled();
      if (!disabled) {
        throw new Error('Terminal guard smoke failed: install action button should be disabled');
      }
    }

    process.stdout.write(
      'UI terminal guard smoke passed: degraded machine blocks install actions\n'
    );
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
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
