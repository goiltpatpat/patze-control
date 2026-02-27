import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { OpenClawCommandQueue } from './openclaw-command-queue.js';

async function withTempOpenClaw(
  config: unknown,
  run: (context: { openclawDir: string; dataDir: string }) => Promise<void>
): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'patze-openclaw-queue-'));
  const openclawDir = join(root, 'openclaw');
  const dataDir = join(root, 'data');
  mkdirSync(openclawDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(openclawDir, 'openclaw.json'), JSON.stringify(config, null, 2), 'utf-8');
  try {
    await run({ openclawDir, dataDir });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('previewCommands returns simulated diff', async () => {
  await withTempOpenClaw(
    { channels: { discord: { enabled: false } } },
    async ({ openclawDir, dataDir }) => {
      const queue = new OpenClawCommandQueue(dataDir);
      const script =
        "const fs=require('node:fs');const p='openclaw.json';const c=JSON.parse(fs.readFileSync(p,'utf-8'));c.channels.discord.enabled=true;fs.writeFileSync(p,JSON.stringify(c,null,2));";
      const diff = await queue.previewCommands(openclawDir, [
        {
          command: process.execPath,
          args: ['-e', script],
          description: 'Enable discord channel',
        },
      ]);
      assert.equal(diff.simulated, true);
      assert.match(diff.after, /"enabled": true/);
      assert.equal(diff.commandCount, 1);
    }
  );
});

test('applyCommands rolls back when command fails', async () => {
  await withTempOpenClaw(
    { channels: { discord: { enabled: false } } },
    async ({ openclawDir, dataDir }) => {
      const queue = new OpenClawCommandQueue(dataDir);
      const before = readFileSync(join(openclawDir, 'openclaw.json'), 'utf-8');
      const mutateScript =
        "const fs=require('node:fs');const p='openclaw.json';const c=JSON.parse(fs.readFileSync(p,'utf-8'));c.channels.discord.enabled=true;fs.writeFileSync(p,JSON.stringify(c,null,2));";
      const result = await queue.applyCommands(
        'local',
        openclawDir,
        [
          {
            command: process.execPath,
            args: ['-e', mutateScript],
            description: 'Mutate config',
          },
          {
            command: process.execPath,
            args: ['-e', 'process.exit(2)'],
            description: 'Fail intentionally',
          },
        ],
        'test'
      );
      assert.equal(result.ok, false);
      assert.equal(typeof result.snapshotId, 'string');
      const after = readFileSync(join(openclawDir, 'openclaw.json'), 'utf-8');
      assert.equal(after, before);
    }
  );
});
