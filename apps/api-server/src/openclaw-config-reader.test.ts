import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFullConfig } from './openclaw-config-reader.js';

function withTempOpenClawDir(config: unknown, run: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'patze-openclaw-config-'));
  try {
    writeFileSync(join(dir, 'openclaw.json'), JSON.stringify(config, null, 2), 'utf-8');
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('readFullConfig parses new OpenClaw schema', () => {
  withTempOpenClawDir(
    {
      agents: {
        list: [
          { id: 'main', model: 'moonshot/kimi-k2.5' },
          {
            id: 'worker',
            identity: { name: 'Worker', emoji: 'W' },
            model: { primary: 'openai/gpt-5', fallback: 'openai/gpt-5-mini' },
            enabled: false,
          },
        ],
      },
      models: {
        providers: {
          moonshot: {
            baseUrl: 'https://api.moonshot.ai/v1',
            models: [{ id: 'kimi-k2.5', name: 'Kimi K2.5' }],
          },
          openai: {
            apiKey: 'sk-test',
            models: [{ id: 'gpt-5', name: 'GPT-5' }],
          },
        },
      },
      channels: {
        discord: {
          bindings: ['main', { id: 'worker', model: 'openai/gpt-5' }, { id: '' }],
        },
      },
    },
    (dir) => {
      const config = readFullConfig(dir);
      assert.ok(config);
      assert.equal(config.agents.length, 2);
      assert.equal(config.agents[0]?.id, 'main');
      assert.equal(config.agents[0]?.model?.primary, 'moonshot/kimi-k2.5');
      assert.equal(config.agents[1]?.name, 'Worker');
      assert.equal(config.agents[1]?.enabled, false);

      assert.deepEqual(config.models.map((item) => item.id).sort(), [
        'moonshot/kimi-k2.5',
        'openai/gpt-5',
      ]);
      const moonshotModel = config.models.find((item) => item.id === 'moonshot/kimi-k2.5');
      assert.equal(moonshotModel?.baseUrl, 'https://api.moonshot.ai/v1');
      const openaiModel = config.models.find((item) => item.id === 'openai/gpt-5');
      assert.equal(openaiModel?.apiKey, 'sk-test');

      assert.equal(config.bindings.length, 2);
      assert.deepEqual(config.bindings.map((item) => item.agentId).sort(), ['main', 'worker']);
    }
  );
});

test('readFullConfig parses legacy schema fallback', () => {
  withTempOpenClawDir(
    {
      agents: {
        defaults: { model: { primary: 'openai/gpt-5' } },
        alpha: { name: 'Alpha', emoji: 'A', model: { primary: 'openai/gpt-5' }, enabled: true },
      },
      models: {
        default: { provider: 'openai', model: 'gpt-5', enabled: true },
      },
      channels: {
        telegram: { agents: ['alpha', ''] },
      },
    },
    (dir) => {
      const config = readFullConfig(dir);
      assert.ok(config);
      assert.equal(config.agents.length, 1);
      assert.equal(config.agents[0]?.id, 'alpha');
      assert.equal(config.models.length, 1);
      assert.equal(config.models[0]?.id, 'default');
      assert.equal(config.bindings.length, 1);
      assert.equal(config.bindings[0]?.agentId, 'alpha');
      assert.equal(config.defaults.model?.primary, 'openai/gpt-5');
    }
  );
});
