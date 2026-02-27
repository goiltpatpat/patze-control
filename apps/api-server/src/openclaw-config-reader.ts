import fs from 'node:fs';
import path from 'node:path';
import type {
  OpenClawAgent,
  OpenClawModelProfile,
  OpenClawChannelBinding,
  OpenClawFullConfig,
  OpenClawDefaults,
} from '@patze/telemetry-core';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function resolveConfigPath(openclawDir: string): string | null {
  const base = path.resolve(openclawDir);
  const candidates = [path.join(base, 'openclaw.json'), path.join(base, 'config', 'openclaw.json')];
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      /* skip */
    }
  }
  return null;
}

function readRawConfig(openclawDir: string): Record<string, unknown> | null {
  const configPath = resolveConfigPath(openclawDir);
  if (!configPath) return null;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8').trim();
    if (raw.length === 0) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!isRecord(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function parseAgents(raw: Record<string, unknown>): OpenClawAgent[] {
  const agents: OpenClawAgent[] = [];
  const agentsRecord = raw.agents;
  if (!isRecord(agentsRecord)) return agents;

  // Newer OpenClaw schema: agents.list = [{ id, name, identity, model, enabled, ... }]
  const list = agentsRecord.list;
  if (Array.isArray(list)) {
    for (const entry of list) {
      if (!isRecord(entry) || typeof entry.id !== 'string' || entry.id.length === 0) continue;
      const modelValue = entry.model;
      const model =
        typeof modelValue === 'string'
          ? { primary: modelValue }
          : isRecord(modelValue)
            ? {
                primary: typeof modelValue.primary === 'string' ? modelValue.primary : undefined,
                fallback: typeof modelValue.fallback === 'string' ? modelValue.fallback : undefined,
              }
            : undefined;
      const identity = isRecord(entry.identity) ? entry.identity : null;
      const entryName = nonEmptyString(entry.name);
      const identityName = identity ? nonEmptyString(identity.name) : null;
      const entryEmoji = nonEmptyString(entry.emoji);
      const identityEmoji = identity ? nonEmptyString(identity.emoji) : null;
      const systemPrompt = nonEmptyString(entry.systemPrompt);
      agents.push({
        id: entry.id,
        name: entryName ?? identityName ?? entry.id,
        emoji: identityEmoji ?? entryEmoji ?? undefined,
        model,
        systemPrompt: systemPrompt ?? undefined,
        enabled: entry.enabled !== false,
      });
    }
    if (agents.length > 0) return agents;
  }

  for (const [id, value] of Object.entries(agentsRecord)) {
    if (id === 'defaults') continue;
    if (id === 'list') continue;
    if (!isRecord(value)) continue;
    agents.push({
      id,
      name: typeof value.name === 'string' ? value.name : id,
      emoji: typeof value.emoji === 'string' ? value.emoji : undefined,
      model: isRecord(value.model)
        ? {
            primary: typeof value.model.primary === 'string' ? value.model.primary : undefined,
            fallback: typeof value.model.fallback === 'string' ? value.model.fallback : undefined,
          }
        : undefined,
      systemPrompt: typeof value.systemPrompt === 'string' ? value.systemPrompt : undefined,
      enabled: value.enabled !== false,
    });
  }
  return agents;
}

function parseModels(raw: Record<string, unknown>): OpenClawModelProfile[] {
  const models: OpenClawModelProfile[] = [];

  // Newer OpenClaw schema: models.providers.<provider>.models = [{ id, name, ... }]
  const modelsRoot = raw.models;
  if (isRecord(modelsRoot) && isRecord(modelsRoot.providers)) {
    for (const [providerId, providerConfig] of Object.entries(modelsRoot.providers)) {
      if (!isRecord(providerConfig) || !Array.isArray(providerConfig.models)) continue;
      for (const modelEntry of providerConfig.models) {
        if (
          !isRecord(modelEntry) ||
          typeof modelEntry.id !== 'string' ||
          modelEntry.id.length === 0
        ) {
          continue;
        }
        models.push({
          id: `${providerId}/${modelEntry.id}`,
          name:
            typeof modelEntry.name === 'string'
              ? modelEntry.name
              : `${providerId}/${modelEntry.id}`,
          provider: providerId,
          model: modelEntry.id,
          apiKey: nonEmptyString(providerConfig.apiKey) ?? undefined,
          baseUrl: nonEmptyString(providerConfig.baseUrl) ?? undefined,
          enabled: modelEntry.enabled !== false,
        });
      }
    }
    if (models.length > 0) return models;
  }

  const modelsRecord =
    raw.models ?? (isRecord(raw.agents) ? (raw.agents as Record<string, unknown>).models : null);
  if (!isRecord(modelsRecord)) return models;

  for (const [id, value] of Object.entries(modelsRecord)) {
    if (!isRecord(value)) continue;
    models.push({
      id,
      name: typeof value.name === 'string' ? value.name : id,
      provider: typeof value.provider === 'string' ? value.provider : 'unknown',
      model: typeof value.model === 'string' ? value.model : id,
      apiKey: typeof value.apiKey === 'string' ? value.apiKey : undefined,
      baseUrl: typeof value.baseUrl === 'string' ? value.baseUrl : undefined,
      enabled: value.enabled !== false,
    });
  }
  return models;
}

function parseBindings(raw: Record<string, unknown>): OpenClawChannelBinding[] {
  const bindings: OpenClawChannelBinding[] = [];
  const channelsRecord = raw.channels;
  if (!isRecord(channelsRecord)) return bindings;

  for (const [channelId, channelValue] of Object.entries(channelsRecord)) {
    if (!isRecord(channelValue)) continue;
    const agents = channelValue.agents ?? channelValue.bindings;
    if (Array.isArray(agents)) {
      for (const entry of agents) {
        if (typeof entry === 'string') {
          const agentId = nonEmptyString(entry);
          if (!agentId) continue;
          bindings.push({ channelId, agentId });
        } else if (isRecord(entry)) {
          const fromAgentId = nonEmptyString(entry.agentId);
          const fromId = nonEmptyString(entry.id);
          const agentId = fromAgentId ?? fromId;
          if (!agentId) continue;
          bindings.push({
            channelId,
            agentId,
            modelOverride: nonEmptyString(entry.model) ?? undefined,
          });
        }
      }
    }
  }
  return bindings;
}

function parseDefaults(raw: Record<string, unknown>): OpenClawDefaults {
  const agentsRecord = raw.agents;
  if (!isRecord(agentsRecord)) return {};
  const defaults = agentsRecord.defaults;
  if (!isRecord(defaults)) return {};
  const model = defaults.model;
  if (!isRecord(model)) return {};
  return {
    model: {
      primary: typeof model.primary === 'string' ? model.primary : undefined,
      fallback: typeof model.fallback === 'string' ? model.fallback : undefined,
    },
  };
}

export function readFullConfig(openclawDir: string): OpenClawFullConfig | null {
  const raw = readRawConfig(openclawDir);
  if (!raw) return null;
  return {
    agents: parseAgents(raw),
    models: parseModels(raw),
    channels: isRecord(raw.channels) ? raw.channels : {},
    bindings: parseBindings(raw),
    defaults: parseDefaults(raw),
    raw,
  };
}

export function readAgents(openclawDir: string): readonly OpenClawAgent[] {
  const raw = readRawConfig(openclawDir);
  if (!raw) return [];
  return parseAgents(raw);
}

export function readModels(openclawDir: string): readonly OpenClawModelProfile[] {
  const raw = readRawConfig(openclawDir);
  if (!raw) return [];
  return parseModels(raw);
}

export function readBindings(openclawDir: string): readonly OpenClawChannelBinding[] {
  const raw = readRawConfig(openclawDir);
  if (!raw) return [];
  return parseBindings(raw);
}

export function getConfigPath(openclawDir: string): string | null {
  return resolveConfigPath(openclawDir);
}

export function readRawConfigString(openclawDir: string): string | null {
  const configPath = resolveConfigPath(openclawDir);
  if (!configPath) return null;
  try {
    return fs.readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
}
