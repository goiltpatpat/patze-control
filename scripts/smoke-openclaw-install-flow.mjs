import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  randomPort,
  requestJson,
  spawnProcess,
  terminate,
  waitForHttpOk,
  writeFakeOpenClawCli,
  writeFixtureOpenClawHome,
} from './smoke-utils.mjs';

async function run() {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'patze-install-smoke-'));
  const settingsDir = path.join(tempRoot, 'settings');
  const openclawHome = path.join(tempRoot, 'openclaw-home');
  const fakeBinDir = path.join(tempRoot, 'fake-bin');
  const apiPort = randomPort(19_980, 350);
  const apiBase = `http://127.0.0.1:${String(apiPort)}`;

  writeFixtureOpenClawHome(openclawHome);
  writeFakeOpenClawCli(fakeBinDir, 'install-smoke shim');

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

  try {
    await waitForHttpOk(`${apiBase}/health`);

    const invalidPath = await requestJson(apiBase, '/openclaw/install/precheck', {
      method: 'POST',
      body: JSON.stringify({ scope: 'local', installPath: '/tmp/bad\npath' }),
    });
    if (invalidPath.status !== 400 || invalidPath.data?.error !== 'invalid_install_path') {
      throw new Error(
        `Install smoke failed: invalid path not blocked (${String(invalidPath.status)} ${JSON.stringify(invalidPath.data)})`
      );
    }

    const invalidCmd = await requestJson(apiBase, '/openclaw/install/run', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'local',
        installPath: '/tmp/openclaw-install-smoke',
        installCommand: 'npm install -g openclaw && echo hacked',
      }),
    });
    if (invalidCmd.status !== 400 || invalidCmd.data?.error !== 'invalid_install_command') {
      throw new Error(
        `Install smoke failed: invalid command not blocked (${String(invalidCmd.status)} ${JSON.stringify(invalidCmd.data)})`
      );
    }

    const precheck = await requestJson(apiBase, '/openclaw/install/precheck', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'local',
        installPath: '/tmp/openclaw-install-smoke',
      }),
    });
    if (!precheck.ok || !Array.isArray(precheck.data?.checks)) {
      throw new Error(
        `Install smoke failed: precheck did not return checks (${String(precheck.status)})`
      );
    }

    const verify = await requestJson(apiBase, '/openclaw/install/verify', {
      method: 'POST',
      body: JSON.stringify({
        scope: 'local',
        installPath: '/tmp/openclaw-install-smoke',
      }),
    });
    if (!verify.ok || typeof verify.data?.ok !== 'boolean') {
      throw new Error(`Install smoke failed: verify response invalid (${String(verify.status)})`);
    }

    process.stdout.write(
      `Install smoke passed: invalid_payload_blocked=2, precheck_checks=${String(precheck.data.checks.length)}, verify_ok=${String(verify.data.ok)}\n`
    );
  } finally {
    await terminate(api);
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

run().catch((error) => {
  const msg = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${msg}\n`);
  process.exitCode = 1;
});
