import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

interface ParsedHostBlock {
  readonly patterns: readonly string[];
  readonly options: {
    hostname?: string | undefined;
    user?: string | undefined;
    port?: number | undefined;
    identityFile?: string | undefined;
  };
}

export interface ResolvedSshConfig {
  readonly isAlias: true;
  readonly alias: string;
  readonly hostname: string;
  readonly user?: string | undefined;
  readonly port?: number | undefined;
  readonly identityFile?: string | undefined;
}

function hasGlobPattern(value: string): boolean {
  return /[*?![\]]/.test(value);
}

function normalizeHostToken(token: string): string {
  return token.trim();
}

function expandHome(value: string): string {
  if (!value.startsWith('~/') && value !== '~') {
    return value;
  }
  return path.join(os.homedir(), value.slice(1));
}

function parseConfig(content: string): ParsedHostBlock[] {
  const blocks: ParsedHostBlock[] = [];
  const lines = content.split(/\r?\n/);

  let currentPatterns: string[] = [];
  let currentOptions: ParsedHostBlock['options'] = {};

  const flush = (): void => {
    if (currentPatterns.length === 0) {
      return;
    }
    blocks.push({
      patterns: [...currentPatterns],
      options: { ...currentOptions },
    });
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const firstSpace = trimmed.search(/\s+/);
    if (firstSpace <= 0) {
      continue;
    }

    const key = trimmed.slice(0, firstSpace).toLowerCase();
    const value = trimmed.slice(firstSpace).trim();
    if (!value) {
      continue;
    }

    if (key === 'host') {
      flush();
      currentPatterns = value
        .split(/\s+/)
        .map(normalizeHostToken)
        .filter((token) => token.length > 0);
      currentOptions = {};
      continue;
    }

    if (currentPatterns.length === 0) {
      continue;
    }

    switch (key) {
      case 'hostname':
        currentOptions.hostname = value;
        break;
      case 'user':
        currentOptions.user = value;
        break;
      case 'port': {
        const parsedPort = Number(value);
        if (Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535) {
          currentOptions.port = parsedPort;
        }
        break;
      }
      case 'identityfile':
        currentOptions.identityFile = expandHome(value);
        break;
      default:
        break;
    }
  }

  flush();
  return blocks;
}

async function readPrimarySshConfig(): Promise<string> {
  const configPath = path.join(os.homedir(), '.ssh', 'config');
  return readFile(configPath, 'utf8');
}

export async function listSshConfigAliases(): Promise<readonly string[]> {
  try {
    const content = await readPrimarySshConfig();
    const blocks = parseConfig(content);
    const aliases = new Set<string>();

    for (const block of blocks) {
      for (const pattern of block.patterns) {
        const normalized = normalizeHostToken(pattern);
        if (!normalized || hasGlobPattern(normalized) || normalized.startsWith('!')) {
          continue;
        }
        aliases.add(normalized);
      }
    }

    return Array.from(aliases).sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

export async function resolveSshConfig(
  host: string
): Promise<ResolvedSshConfig | { readonly isAlias: false }> {
  const query = host.trim();
  if (!query || hasGlobPattern(query)) {
    return { isAlias: false };
  }

  try {
    const content = await readPrimarySshConfig();
    const blocks = parseConfig(content);

    let merged: ParsedHostBlock['options'] = {};
    let matched = false;
    for (const block of blocks) {
      const exactMatch = block.patterns.some((pattern) => {
        const normalized = normalizeHostToken(pattern);
        return !hasGlobPattern(normalized) && !normalized.startsWith('!') && normalized === query;
      });
      if (!exactMatch) {
        continue;
      }
      matched = true;
      merged = { ...merged, ...block.options };
    }

    if (!matched) {
      return { isAlias: false };
    }

    return {
      isAlias: true,
      alias: query,
      hostname: merged.hostname ?? query,
      ...(merged.user ? { user: merged.user } : {}),
      ...(merged.port ? { port: merged.port } : {}),
      ...(merged.identityFile ? { identityFile: merged.identityFile } : {}),
    };
  } catch {
    return { isAlias: false };
  }
}
