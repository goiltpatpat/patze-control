import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

export const DEFAULT_START_TIMEOUT_MS = 60_000;
export const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
export const DEFAULT_POLL_INTERVAL_MS = 350;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomPort(min, span) {
  return min + Math.floor(Math.random() * span);
}

export async function requestJson(
  baseUrl,
  pathname,
  init = {},
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS
) {
  const res = await fetch(`${baseUrl}${pathname}`, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(requestTimeoutMs),
  });
  const text = await res.text();
  let parsed;
  try {
    parsed = text.length > 0 ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text };
  }
  return { ok: res.ok, status: res.status, data: parsed };
}

export async function waitForHttpOk(
  url,
  startTimeoutMs = DEFAULT_START_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS
) {
  const start = Date.now();
  while (Date.now() - start < startTimeoutMs) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1_500) });
      if (res.ok) return;
    } catch {
      // keep polling
    }
    await sleep(pollIntervalMs);
  }
  throw new Error(`Timeout waiting for ${url}`);
}

export function writeFixtureOpenClawHome(openclawHome) {
  const configDir = path.join(openclawHome, 'config');
  const cronDir = path.join(openclawHome, 'cron');
  const runsDir = path.join(cronDir, 'runs');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(runsDir, { recursive: true });

  const config = {
    channels: {
      telegram: { enabled: false, dmPolicy: 'deny', token: '' },
    },
    models: { providers: {} },
    agents: { defaults: { model: { primary: '' } } },
  };
  writeFileSync(path.join(configDir, 'openclaw.json'), JSON.stringify(config, null, 2), 'utf-8');
  writeFileSync(path.join(cronDir, 'jobs.json'), JSON.stringify({ jobs: [] }, null, 2), 'utf-8');
}

export function writeFakeOpenClawCli(fakeBinDir, shimComment = 'ui-smoke shim') {
  mkdirSync(fakeBinDir, { recursive: true });
  const shimPath = path.join(fakeBinDir, 'openclaw');
  writeFileSync(shimPath, `#!/bin/sh\n# ${shimComment}\nexit 0\n`, 'utf-8');
  chmodSync(shimPath, 0o755);
  return shimPath;
}

export function spawnProcess(command, args, env) {
  return spawn(command, args, {
    cwd: process.cwd(),
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export async function terminate(child) {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await sleep(400);
  if (child.exitCode === null) child.kill('SIGKILL');
}
