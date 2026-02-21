import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import type { DetectedRun, RunDetector, SourceSnapshot } from '../types.js';
import { parseRunRecord } from './parse-utils.js';

export interface FileSourceConfig {
  sessionDir: string;
}

export class OpenClawFileSource implements RunDetector {
  private readonly config: FileSourceConfig;

  public constructor(config: FileSourceConfig) {
    this.config = config;
  }

  public async collect(): Promise<SourceSnapshot> {
    let entries: readonly string[];
    try {
      entries = await readdir(this.config.sessionDir);
    } catch {
      return { activeRuns: [] };
    }

    const runs: DetectedRun[] = [];
    for (const entryName of entries) {
      if (!entryName.endsWith('.json')) {
        continue;
      }

      try {
        const content = await readFile(path.join(this.config.sessionDir, entryName), 'utf8');
        const payload: unknown = JSON.parse(content);
        const parsed = parseRunRecord(payload);
        if (parsed) {
          runs.push(parsed);
        }
      } catch {
        // Skip malformed files and continue.
      }
    }

    return { activeRuns: runs };
  }
}
