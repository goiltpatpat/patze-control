import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { BridgeLogger, RunDetector, SourceSnapshot } from '../types.js';
import { parseRunsPayload } from './parse-utils.js';

const execFileAsync = promisify(execFile);

export interface CliSourceConfig {
  openclawBin: string;
  openclawArgs: readonly string[];
}

export class OpenClawCliSource implements RunDetector {
  private readonly config: CliSourceConfig;

  private readonly logger: BridgeLogger;

  public constructor(config: CliSourceConfig, logger: BridgeLogger) {
    this.config = config;
    this.logger = logger;
  }

  public async collect(): Promise<SourceSnapshot> {
    try {
      const { stdout } = await execFileAsync(
        this.config.openclawBin,
        [...this.config.openclawArgs],
        {
          timeout: 4000,
          maxBuffer: 1024 * 1024,
        }
      );

      try {
        const payload: unknown = JSON.parse(stdout);
        return { activeRuns: parseRunsPayload(payload) };
      } catch {
        return { activeRuns: [] };
      }
    } catch (error) {
      this.logger.warn('cli_collect_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
      return { activeRuns: [] };
    }
  }
}
