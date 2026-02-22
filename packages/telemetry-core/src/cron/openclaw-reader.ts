import fs from 'node:fs';
import path from 'node:path';

/**
 * OpenClaw native cron job — the on-disk format used by the OpenClaw Gateway.
 * ClawPal reads this same structure from `~/.openclaw/cron/jobs.json`.
 */
export interface OpenClawCronJob {
  readonly jobId: string;
  readonly name: string | undefined;
  readonly schedule: OpenClawSchedule;
  readonly execution: OpenClawExecution;
  readonly payload: OpenClawPayload | undefined;
  readonly delivery: OpenClawDelivery;
  readonly sessionTarget: 'main' | 'isolated' | undefined;
  readonly wakeMode: 'next-heartbeat' | 'now' | undefined;
  readonly deleteAfterRun: boolean | undefined;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string | undefined;
  readonly lastRunAt: string | undefined;
  readonly lastStatus: 'ok' | 'error' | 'timeout' | 'skipped' | undefined;
  readonly nextRunAtMs: number | undefined;
  readonly lastError: string | undefined;
  readonly lastDurationMs: number | undefined;
  readonly lastDelivered: boolean | undefined;
  readonly consecutiveErrors: number | undefined;
}

export interface OpenClawSchedule {
  readonly kind: 'at' | 'every' | 'cron';
  readonly at: string | undefined;
  readonly everyMs: number | undefined;
  readonly anchorMs: number | undefined;
  readonly expr: string | undefined;
  readonly tz: string | undefined;
  readonly staggerMs: number | undefined;
}

export interface OpenClawExecution {
  readonly style: 'main' | 'isolated';
  readonly agentId: string | undefined;
  readonly sessionTag: string | undefined;
}

export interface OpenClawPayload {
  readonly kind: 'systemEvent' | 'agentTurn';
  readonly text: string | undefined;
  readonly message: string | undefined;
  readonly model: string | undefined;
  readonly thinking: string | undefined;
  readonly timeoutSeconds: number | undefined;
}

export interface OpenClawDelivery {
  readonly mode: 'announce' | 'webhook' | 'none';
  readonly channel: string | undefined;
  readonly to: string | undefined;
  readonly bestEffort: boolean | undefined;
  readonly webhookUrl: string | undefined;
  readonly webhookMethod: string | undefined;
  readonly channelId: string | undefined;
}

export interface OpenClawRunRecord {
  readonly jobId: string;
  readonly runId: string;
  readonly startedAt: string;
  readonly endedAt: string | undefined;
  readonly status: 'ok' | 'error' | 'timeout' | 'running';
  readonly error: string | undefined;
  readonly durationMs: number | undefined;
  readonly sessionId: string | undefined;
}

export interface FileSystemReader {
  exists(filePath: string): boolean;
  readFile(filePath: string): string;
  readDir(dirPath: string): string[];
}

const localFs: FileSystemReader = {
  exists: (p) => fs.existsSync(p),
  readFile: (p) => fs.readFileSync(p, 'utf-8'),
  readDir: (p) => {
    try {
      return fs.readdirSync(p);
    } catch {
      return [];
    }
  },
};

/**
 * Reads OpenClaw's native cron files from disk, supporting the same
 * formats ClawPal's `list_cron_jobs` / `get_cron_runs` handle.
 *
 * File layout:
 *   ~/.openclaw/cron/jobs.json         — task definitions
 *   ~/.openclaw/cron/runs/{jobId}.jsonl — per-job run logs
 */
export class OpenClawCronReader {
  private readonly cronDir: string;
  private readonly fs: FileSystemReader;

  public constructor(openclawDir: string, fileSystem?: FileSystemReader) {
    this.cronDir = path.join(openclawDir, 'cron');
    this.fs = fileSystem ?? localFs;
  }

  public get basePath(): string {
    return this.cronDir;
  }

  public hasJobsFile(): boolean {
    return this.fs.exists(path.join(this.cronDir, 'jobs.json'));
  }

  /**
   * Parse jobs.json — tolerant of 3 formats:
   *  1. `{ "version": N, "jobs": [...] }` wrapper
   *  2. Plain JSON array
   *  3. Plain JSON object (jobId as keys)
   */
  public readJobs(): OpenClawCronJob[] {
    const jobsPath = path.join(this.cronDir, 'jobs.json');
    if (!this.fs.exists(jobsPath)) return [];

    try {
      const raw = this.fs.readFile(jobsPath);
      const parsed = JSON.parse(raw) as unknown;
      return this.parseJobs(parsed);
    } catch {
      return [];
    }
  }

  /**
   * Read run history for a specific job from its JSONL file.
   * Returns newest-first, capped at `limit` records.
   */
  public readRuns(jobId: string, limit = 50): OpenClawRunRecord[] {
    const runsPath = path.join(this.cronDir, 'runs', `${sanitizeFilename(jobId)}.jsonl`);
    if (!this.fs.exists(runsPath)) return [];

    try {
      const raw = this.fs.readFile(runsPath);
      const lines = raw.trim().split('\n').filter(Boolean);

      return lines
        .slice(-limit)
        .reverse()
        .map((line) => {
          try {
            return JSON.parse(line) as OpenClawRunRecord;
          } catch {
            return null;
          }
        })
        .filter((r): r is OpenClawRunRecord => r !== null);
    } catch {
      return [];
    }
  }

  /**
   * List all available job IDs that have run history.
   */
  public listRunJobIds(): string[] {
    const runsDir = path.join(this.cronDir, 'runs');
    if (!this.fs.exists(runsDir)) return [];

    return this.fs
      .readDir(runsDir)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => f.replace(/\.jsonl$/, ''));
  }

  private parseJobs(data: unknown): OpenClawCronJob[] {
    if (Array.isArray(data)) {
      return data.map((raw) => normalizeJob(raw)).filter((j): j is OpenClawCronJob => j !== null);
    }

    if (typeof data === 'object' && data !== null) {
      const obj = data as Record<string, unknown>;

      if (Array.isArray(obj.jobs)) {
        return obj.jobs
          .map((raw) => normalizeJob(raw))
          .filter((j): j is OpenClawCronJob => j !== null);
      }

      return Object.entries(obj)
        .filter(([key]) => key !== 'version')
        .map(([key, value]) => normalizeJob(value, key))
        .filter((j): j is OpenClawCronJob => j !== null);
    }

    return [];
  }
}

function normalizeJob(raw: unknown, fallbackId?: string): OpenClawCronJob | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;

  const jobId =
    (typeof obj.jobId === 'string' ? obj.jobId : null) ??
    (typeof obj.id === 'string' ? obj.id : null) ??
    fallbackId;

  if (!jobId) return null;

  const schedule = parseSchedule(obj.schedule);
  if (!schedule) return null;

  return {
    jobId,
    name: typeof obj.name === 'string' ? obj.name : undefined,
    schedule,
    execution: parseExecution(obj.execution),
    payload: parsePayload(obj.payload),
    delivery: parseDelivery(obj.delivery),
    sessionTarget: parseSessionTarget(obj.sessionTarget),
    wakeMode: parseWakeMode(obj.wakeMode),
    deleteAfterRun: typeof obj.deleteAfterRun === 'boolean' ? obj.deleteAfterRun : undefined,
    enabled: obj.enabled !== false,
    createdAt:
      toIsoDate(obj.createdAt) ?? toIsoDate(obj.createdAtMs) ?? new Date().toISOString(),
    updatedAt: toIsoDate(obj.updatedAt) ?? toIsoDate(obj.updatedAtMs),
    lastRunAt:
      toIsoDate(obj.lastRunAt) ??
      toIsoDate(obj.lastRunAtMs) ??
      toIsoDate(extractState(obj)?.lastRunAtMs),
    lastStatus: parseJobStatus(obj.lastStatus, extractState(obj)),
    nextRunAtMs: parseNumberOrUndefined(obj.nextRunAtMs) ?? parseNumberOrUndefined(extractState(obj)?.nextRunAtMs),
    lastError: parseStringOrUndefined(obj.lastError) ?? parseStringOrUndefined(extractState(obj)?.lastError),
    lastDurationMs:
      parseNumberOrUndefined(obj.lastDurationMs) ?? parseNumberOrUndefined(extractState(obj)?.lastDurationMs),
    lastDelivered:
      parseBooleanOrUndefined(obj.lastDelivered) ?? parseBooleanOrUndefined(extractState(obj)?.lastDelivered),
    consecutiveErrors: parseNumberOrUndefined(obj.consecutiveErrors) ?? parseNumberOrUndefined(extractState(obj)?.consecutiveErrors),
  };
}

function parseSchedule(raw: unknown): OpenClawSchedule | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind ?? obj.type;
  if (kind !== 'at' && kind !== 'every' && kind !== 'cron') return null;

  return {
    kind: kind as OpenClawSchedule['kind'],
    at: typeof obj.at === 'string' ? obj.at : undefined,
    everyMs:
      typeof obj.everyMs === 'number'
        ? obj.everyMs
        : typeof obj.intervalMs === 'number'
          ? obj.intervalMs
          : undefined,
    anchorMs: typeof obj.anchorMs === 'number' ? obj.anchorMs : undefined,
    expr:
      typeof obj.expr === 'string'
        ? obj.expr
        : typeof obj.expression === 'string'
          ? obj.expression
          : undefined,
    tz:
      typeof obj.tz === 'string'
        ? obj.tz
        : typeof obj.timezone === 'string'
          ? obj.timezone
          : undefined,
    staggerMs: typeof obj.staggerMs === 'number' ? obj.staggerMs : undefined,
  };
}

function parseExecution(raw: unknown): OpenClawExecution {
  if (typeof raw !== 'object' || raw === null) {
    return { style: 'main', agentId: undefined, sessionTag: undefined };
  }
  const obj = raw as Record<string, unknown>;
  return {
    style: obj.style === 'isolated' ? 'isolated' : 'main',
    agentId: typeof obj.agentId === 'string' ? obj.agentId : undefined,
    sessionTag: typeof obj.sessionTag === 'string' ? obj.sessionTag : undefined,
  };
}

function parsePayload(raw: unknown): OpenClawPayload | undefined {
  if (typeof raw !== 'object' || raw === null) {
    return undefined;
  }
  const obj = raw as Record<string, unknown>;
  const kind = obj.kind;
  if (kind !== 'systemEvent' && kind !== 'agentTurn') {
    return undefined;
  }
  return {
    kind,
    text: typeof obj.text === 'string' ? obj.text : undefined,
    message: typeof obj.message === 'string' ? obj.message : undefined,
    model: typeof obj.model === 'string' ? obj.model : undefined,
    thinking: typeof obj.thinking === 'string' ? obj.thinking : undefined,
    timeoutSeconds: typeof obj.timeoutSeconds === 'number' ? obj.timeoutSeconds : undefined,
  };
}

function parseDelivery(raw: unknown): OpenClawDelivery {
  if (typeof raw !== 'object' || raw === null) {
    return {
      mode: 'none',
      channel: undefined,
      to: undefined,
      bestEffort: undefined,
      webhookUrl: undefined,
      webhookMethod: undefined,
      channelId: undefined,
    };
  }
  const obj = raw as Record<string, unknown>;
  const mode = obj.mode === 'announce' ? 'announce' : obj.mode === 'webhook' ? 'webhook' : 'none';
  const to = typeof obj.to === 'string' ? obj.to : undefined;
  const channel = typeof obj.channel === 'string' ? obj.channel : undefined;
  const channelId = typeof obj.channelId === 'string' ? obj.channelId : channel;
  const webhookUrl =
    typeof obj.webhookUrl === 'string'
      ? obj.webhookUrl
      : mode === 'webhook' && to && /^https?:\/\//i.test(to)
        ? to
        : undefined;

  return {
    mode,
    channel,
    to,
    bestEffort: typeof obj.bestEffort === 'boolean' ? obj.bestEffort : undefined,
    webhookUrl,
    webhookMethod: typeof obj.webhookMethod === 'string' ? obj.webhookMethod : undefined,
    channelId,
  };
}

function parseSessionTarget(value: unknown): 'main' | 'isolated' | undefined {
  return value === 'main' || value === 'isolated' ? value : undefined;
}

function parseWakeMode(value: unknown): 'next-heartbeat' | 'now' | undefined {
  return value === 'next-heartbeat' || value === 'now' ? value : undefined;
}

function parseJobStatus(
  value: unknown,
  state: Record<string, unknown> | undefined
): 'ok' | 'error' | 'timeout' | 'skipped' | undefined {
  if (value === 'ok' || value === 'error' || value === 'timeout' || value === 'skipped') {
    return value;
  }
  const stateStatus = state?.lastStatus;
  if (
    stateStatus === 'ok' ||
    stateStatus === 'error' ||
    stateStatus === 'timeout' ||
    stateStatus === 'skipped'
  ) {
    return stateStatus;
  }
  return undefined;
}

function parseStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function parseBooleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function extractState(job: Record<string, unknown>): Record<string, unknown> | undefined {
  const state = job.state;
  return typeof state === 'object' && state !== null ? (state as Record<string, unknown>) : undefined;
}

function toIsoDate(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return undefined;
}

function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9_-]/g, '_');
}
