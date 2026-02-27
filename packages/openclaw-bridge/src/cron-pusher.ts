import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  OpenClawCronReader,
  type OpenClawCronJob,
  type OpenClawRunRecord,
} from '@patze/telemetry-core';
import type { BridgeLogger } from './types.js';

interface CronPusherOptions {
  readonly controlPlaneBaseUrl: string;
  readonly controlPlaneToken?: string;
  readonly machineId: string;
  readonly machineLabel: string;
  readonly bridgeVersion: string;
  readonly openclawHomeDir: string;
  readonly syncPath: string;
  readonly syncIntervalMs: number;
  readonly stateFilePath: string;
  readonly logger: BridgeLogger;
}

interface PersistedCronState {
  readonly version: 1;
  readonly jobsHash: string;
  readonly configHash?: string;
  readonly offsets: Record<string, number>;
}

interface ReadDeltaResult {
  readonly nextOffset: number;
  readonly lines: readonly string[];
}

interface CronSyncPayload {
  readonly machineId: string;
  readonly machineLabel: string;
  readonly bridgeVersion: string;
  readonly jobsHash: string;
  readonly jobs: readonly OpenClawCronJob[] | undefined;
  readonly configHash: string;
  readonly configRaw: string | null | undefined;
  readonly newRuns: Readonly<Record<string, readonly OpenClawRunRecord[]>>;
  readonly sentAt: string;
}

const FETCH_TIMEOUT_MS = 10_000;
export class CronPusher {
  private readonly options: CronPusherOptions;
  private readonly reader: OpenClawCronReader;
  private timer: ReturnType<typeof setInterval> | null = null;
  private jobsHash = '';
  private configHash = '';
  private readonly runOffsets = new Map<string, number>();
  private running = false;

  public constructor(options: CronPusherOptions) {
    this.options = options;
    this.reader = new OpenClawCronReader(options.openclawHomeDir);
    this.loadState();
  }

  public async start(options?: { readonly skipInitialSync?: boolean }): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    if (!options?.skipInitialSync) {
      await this.pushDelta();
    }
    this.timer = setInterval(() => {
      void this.pushDelta();
    }, this.options.syncIntervalMs);
  }

  public stop(): void {
    this.running = false;
    if (!this.timer) {
      return;
    }
    clearInterval(this.timer);
    this.timer = null;
  }

  public isRunning(): boolean {
    return this.running;
  }

  private buildSyncUrl(): string {
    const base = new URL(this.options.controlPlaneBaseUrl);
    base.pathname = this.options.syncPath;
    base.search = '';
    base.hash = '';
    return base.toString();
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      'X-Patze-Machine-Id': this.options.machineId,
      'X-Patze-Bridge-Version': this.options.bridgeVersion,
    };

    if (this.options.controlPlaneToken) {
      headers.Authorization = `Bearer ${this.options.controlPlaneToken}`;
    }

    return headers;
  }

  private loadState(): void {
    try {
      if (!fs.existsSync(this.options.stateFilePath)) {
        return;
      }
      const raw = fs.readFileSync(this.options.stateFilePath, 'utf-8');
      const parsed = JSON.parse(raw) as PersistedCronState;
      if (parsed.version !== 1) {
        return;
      }
      this.jobsHash = parsed.jobsHash;
      this.configHash = parsed.configHash ?? '';
      for (const [filename, offset] of Object.entries(parsed.offsets)) {
        if (Number.isFinite(offset) && offset >= 0) {
          this.runOffsets.set(filename, offset);
        }
      }
    } catch (error) {
      this.options.logger.warn('cron_state_load_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private saveState(): void {
    try {
      const dir = path.dirname(this.options.stateFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const offsets: Record<string, number> = {};
      for (const [filename, offset] of this.runOffsets) {
        offsets[filename] = offset;
      }
      const data: PersistedCronState = {
        version: 1,
        jobsHash: this.jobsHash,
        configHash: this.configHash,
        offsets,
      };
      const tmpPath = `${this.options.stateFilePath}.tmp`;
      fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
      fs.renameSync(tmpPath, this.options.stateFilePath);
    } catch (error) {
      this.options.logger.warn('cron_state_save_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private getJobsRaw(): string | null {
    const jobsPath = path.join(this.options.openclawHomeDir, 'cron', 'jobs.json');
    try {
      if (!fs.existsSync(jobsPath)) {
        return null;
      }
      return fs.readFileSync(jobsPath, 'utf-8');
    } catch {
      return null;
    }
  }

  private getConfigRaw(): string | null {
    const candidates = [
      path.join(this.options.openclawHomeDir, 'openclaw.json'),
      path.join(this.options.openclawHomeDir, 'config', 'openclaw.json'),
    ];
    for (const configPath of candidates) {
      try {
        if (!fs.existsSync(configPath)) {
          continue;
        }
        return fs.readFileSync(configPath, 'utf-8');
      } catch {
        /* try next candidate */
      }
    }
    return null;
  }

  private static hashContent(value: string | null): string {
    if (value === null) {
      return 'missing';
    }
    return crypto.createHash('sha256').update(value).digest('hex');
  }

  private readDelta(filePath: string, previousOffset: number): ReadDeltaResult {
    const stat = fs.statSync(filePath);
    const fileSize = stat.size;
    const safeOffset = previousOffset > fileSize ? 0 : previousOffset;
    if (fileSize <= safeOffset) {
      return { nextOffset: safeOffset, lines: [] };
    }

    const byteLength = fileSize - safeOffset;
    if (byteLength <= 0) {
      return { nextOffset: safeOffset, lines: [] };
    }

    const fd = fs.openSync(filePath, 'r');
    try {
      const buffer = Buffer.allocUnsafe(byteLength);
      const bytesRead = fs.readSync(fd, buffer, 0, byteLength, safeOffset);
      if (bytesRead <= 0) {
        return { nextOffset: safeOffset, lines: [] };
      }

      const chunk = buffer.subarray(0, bytesRead).toString('utf8');
      const lastNewlineIndex = chunk.lastIndexOf('\n');
      if (lastNewlineIndex === -1) {
        return { nextOffset: safeOffset, lines: [] };
      }

      const consumable = chunk.slice(0, lastNewlineIndex + 1);
      const lines = consumable.split('\n').filter((line) => line.length > 0);
      const consumedBytes = Buffer.byteLength(consumable, 'utf8');
      return {
        nextOffset: safeOffset + consumedBytes,
        lines,
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  private collectNewRuns(): {
    readonly runsByJobId: Readonly<Record<string, readonly OpenClawRunRecord[]>>;
    readonly nextOffsets: Readonly<Map<string, number>>;
  } {
    const runsDir = path.join(this.options.openclawHomeDir, 'cron', 'runs');
    const nextOffsets = new Map(this.runOffsets);
    const runsByJobId = new Map<string, OpenClawRunRecord[]>();

    if (!fs.existsSync(runsDir)) {
      return { runsByJobId: {}, nextOffsets };
    }

    const files = fs
      .readdirSync(runsDir)
      .filter((filename) => filename.endsWith('.jsonl'))
      .sort((a, b) => a.localeCompare(b));

    for (const filename of files) {
      const filePath = path.join(runsDir, filename);
      const previousOffset = nextOffsets.get(filename) ?? 0;
      let delta: ReadDeltaResult;
      try {
        delta = this.readDelta(filePath, previousOffset);
      } catch {
        continue;
      }
      nextOffsets.set(filename, delta.nextOffset);
      if (delta.lines.length === 0) {
        continue;
      }
      for (const line of delta.lines) {
        try {
          const parsed = JSON.parse(line) as OpenClawRunRecord;
          const jobId = parsed.jobId;
          if (typeof jobId !== 'string' || jobId.length === 0) {
            continue;
          }
          const bucket = runsByJobId.get(jobId) ?? [];
          bucket.push(parsed);
          runsByJobId.set(jobId, bucket);
        } catch {
          // skip malformed line
        }
      }
    }

    return {
      runsByJobId: Object.fromEntries(runsByJobId.entries()),
      nextOffsets,
    };
  }

  private static hasRuns(payload: Readonly<Record<string, readonly OpenClawRunRecord[]>>): boolean {
    return Object.values(payload).some((runs) => runs.length > 0);
  }

  private async postPayload(payload: CronSyncPayload): Promise<void> {
    const response = await fetch(this.buildSyncUrl(), {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`cron_sync_http_${String(response.status)}`);
    }
  }

  private async pushDelta(): Promise<void> {
    if (!this.running) {
      return;
    }

    try {
      const jobsRaw = this.getJobsRaw();
      const nextJobsHash = CronPusher.hashContent(jobsRaw);
      const jobsChanged = nextJobsHash !== this.jobsHash;
      const jobs = jobsChanged ? this.reader.readJobs() : undefined;
      const configRaw = this.getConfigRaw();
      const nextConfigHash = CronPusher.hashContent(configRaw);
      const configChanged = nextConfigHash !== this.configHash;
      const configPayload = configChanged ? configRaw : undefined;

      const { runsByJobId, nextOffsets } = this.collectNewRuns();
      const hasRunDelta = CronPusher.hasRuns(runsByJobId);
      if (!jobsChanged && !hasRunDelta && !configChanged) {
        return;
      }

      const payload: CronSyncPayload = {
        machineId: this.options.machineId,
        machineLabel: this.options.machineLabel,
        bridgeVersion: this.options.bridgeVersion,
        jobsHash: nextJobsHash,
        jobs,
        configHash: nextConfigHash,
        configRaw: configPayload,
        newRuns: runsByJobId,
        sentAt: new Date().toISOString(),
      };

      await this.postPayload(payload);
      this.jobsHash = nextJobsHash;
      this.configHash = nextConfigHash;
      this.runOffsets.clear();
      for (const [filename, offset] of nextOffsets) {
        this.runOffsets.set(filename, offset);
      }
      this.saveState();
      this.options.logger.info('cron_sync_pushed', {
        jobsChanged,
        configChanged,
        runsJobs: Object.keys(runsByJobId).length,
      });
    } catch (error) {
      this.options.logger.warn('cron_sync_failed', {
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
