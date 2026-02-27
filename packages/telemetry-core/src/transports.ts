import type { AnyTelemetryEvent } from './events.js';
import type { BatchIngestResult, IngestFailure, IngestResult } from './ingestor.js';
import type { TelemetryNodeLike } from './telemetry-node.js';

interface NodePersistenceApis {
  readonly fs: typeof import('node:fs/promises');
  readonly path: typeof import('node:path');
}

let nodePersistenceApisPromise: Promise<NodePersistenceApis> | null = null;

async function getNodePersistenceApis(): Promise<NodePersistenceApis> {
  if (nodePersistenceApisPromise) {
    return nodePersistenceApisPromise;
  }
  nodePersistenceApisPromise = (async () => {
    const [fsPromises, nodePath] = await Promise.all([
      import('node:fs/promises'),
      import('node:path'),
    ]);
    return {
      fs: fsPromises,
      path: nodePath,
    };
  })();
  return nodePersistenceApisPromise as Promise<NodePersistenceApis>;
}

export type TelemetryEventListener = (event: Readonly<AnyTelemetryEvent>) => void;

export interface TelemetryEventSource {
  start(): void;
  stop(): void;
  onEvent(listener: TelemetryEventListener): () => void;
}

export interface TelemetryEventSink {
  ingest(event: unknown): IngestResult;
  ingestMany(events: readonly unknown[]): BatchIngestResult;
}

export type AuthConfig =
  | {
      mode: 'none';
    }
  | {
      mode: 'token';
      token?: string;
    };

export interface SshConfig {
  host: string;
  port: number;
  user: string;
  knownHostsPath: string;
  privateKeyPath: string;
}

export type MachineTransport = 'in_process' | 'sse' | 'http' | 'ssh_tunnel';

export interface MachineEndpoint {
  id: string;
  label: string;
  transport: MachineTransport;
  baseUrl?: string;
  ssh?: SshConfig;
  auth?: AuthConfig;
  headers?: Record<string, string>;
}

export class InProcessSourceAdapter implements TelemetryEventSource {
  private readonly node: TelemetryNodeLike;

  private readonly listeners = new Set<TelemetryEventListener>();

  private unsubscribeNode: (() => void) | null = null;

  public constructor(node: TelemetryNodeLike) {
    this.node = node;
  }

  public start(): void {
    if (this.unsubscribeNode) {
      return;
    }

    this.unsubscribeNode = this.node.subscribe((event) => {
      for (const listener of this.listeners) {
        listener(event);
      }
    });
  }

  public stop(): void {
    if (!this.unsubscribeNode) {
      return;
    }

    this.unsubscribeNode();
    this.unsubscribeNode = null;
  }

  public onEvent(listener: TelemetryEventListener): () => void {
    this.listeners.add(listener);

    return (): void => {
      this.listeners.delete(listener);
    };
  }
}

export class InProcessSinkAdapter implements TelemetryEventSink {
  private readonly node: TelemetryNodeLike;

  public constructor(node: TelemetryNodeLike) {
    this.node = node;
  }

  public ingest(event: unknown): IngestResult {
    return this.node.ingest(event);
  }

  public ingestMany(events: readonly unknown[]): BatchIngestResult {
    return this.node.ingestMany(events);
  }
}

export interface SseSourceAdapterOptions {
  endpoint: MachineEndpoint;
  eventsPath?: string;
}

const SSE_RECONNECT_BASE_MS = 1_000;
const SSE_RECONNECT_MAX_MS = 30_000;

function sseReconnectDelay(attempt: number): number {
  const jitter = Math.random() * 500;
  return Math.min(SSE_RECONNECT_BASE_MS * 2 ** attempt + jitter, SSE_RECONNECT_MAX_MS);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason as Error);
      return;
    }
    const timer = setTimeout(resolve, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal.reason as Error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export class SseSourceAdapter implements TelemetryEventSource {
  private readonly options: SseSourceAdapterOptions;

  private readonly listeners = new Set<TelemetryEventListener>();

  private abortController: AbortController | null = null;

  private running = false;

  public constructor(options: SseSourceAdapterOptions) {
    this.options = options;
  }

  private buildEventsUrl(): string {
    if (!this.options.endpoint.baseUrl) {
      throw new Error(`SSE endpoint '${this.options.endpoint.id}' is missing baseUrl.`);
    }

    const base = new URL(this.options.endpoint.baseUrl);
    const path = this.options.eventsPath ?? '/events';
    base.pathname = path;
    base.search = '';
    base.hash = '';
    return base.toString();
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      Accept: 'text/event-stream',
    };

    if (this.options.endpoint.auth?.mode === 'token' && this.options.endpoint.auth.token) {
      headers.Authorization = `Bearer ${this.options.endpoint.auth.token}`;
    }

    return headers;
  }

  private emit(event: Readonly<AnyTelemetryEvent>): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Prevent a failing listener from blocking others.
      }
    }
  }

  private tryParseAndEmit(payloadText: string): void {
    try {
      const parsed: unknown = JSON.parse(payloadText);
      this.emit(parsed as Readonly<AnyTelemetryEvent>);
    } catch {
      // Skip malformed SSE frames rather than crashing the stream.
    }
  }

  private async connectAndPump(signal: AbortSignal): Promise<void> {
    const response = await fetch(this.buildEventsUrl(), {
      method: 'GET',
      headers: this.buildHeaders(),
      signal,
    });

    if (!response.ok) {
      throw new Error(
        `SSE source responded with status ${String(response.status)} for ${this.options.endpoint.id}.`
      );
    }

    if (!response.body) {
      throw new Error(`SSE source ${this.options.endpoint.id} returned empty body.`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let currentDataLines: string[] = [];

    while (this.running) {
      const result = await reader.read();
      if (result.done) {
        break;
      }

      buffer += decoder.decode(result.value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';

      for (const rawLine of lines) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

        if (line.length === 0) {
          if (currentDataLines.length > 0) {
            const payloadText = currentDataLines.join('\n');
            currentDataLines = [];
            this.tryParseAndEmit(payloadText);
          }
          continue;
        }

        if (line.startsWith(':')) {
          continue;
        }

        if (line.startsWith('data:')) {
          currentDataLines.push(line.slice(5).trimStart());
        }
      }
    }

    if (currentDataLines.length > 0) {
      const payloadText = currentDataLines.join('\n');
      this.tryParseAndEmit(payloadText);
    }
  }

  private async connectWithRetry(signal: AbortSignal): Promise<void> {
    let attempt = 0;

    while (this.running && !signal.aborted) {
      try {
        await this.connectAndPump(signal);
        attempt = 0;
      } catch {
        if (!this.running || signal.aborted) {
          return;
        }
      }

      if (!this.running || signal.aborted) {
        return;
      }

      const delay = sseReconnectDelay(attempt);
      attempt += 1;

      try {
        await sleep(delay, signal);
      } catch {
        return;
      }
    }
  }

  public start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    void this.connectWithRetry(signal);
  }

  public stop(): void {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
  }

  public onEvent(listener: TelemetryEventListener): () => void {
    this.listeners.add(listener);

    return (): void => {
      this.listeners.delete(listener);
    };
  }
}

export interface HttpSinkAdapterOptions {
  endpoint: MachineEndpoint;
  batchSize?: number;
  flushIntervalMs?: number;
  maxRetries?: number;
  maxBackoffMs?: number;
  maxQueueSize?: number;
  circuitBreakerThreshold?: number;
  circuitBreakerCooldownMs?: number;
  persistedQueueFilePath?: string;
  persistDebounceMs?: number;
}

export interface HttpSinkAdapterStats {
  readonly queueSize: number;
  readonly maxQueueSize: number;
  readonly consecutiveFailures: number;
  readonly circuitOpenUntilMs: number;
  readonly spool: {
    readonly enabled: boolean;
    readonly filePath: string | null;
    readonly hydratedCount: number;
    readonly droppedOnHydrate: number;
    readonly lastPersistedAt: string | null;
    readonly lastPersistError: string | null;
  };
}

export class HttpSinkAdapter implements TelemetryEventSink {
  private readonly options: HttpSinkAdapterOptions;

  private readonly ingestUrl: string;

  private readonly ingestBatchUrl: string;

  private readonly batchSize: number;

  private readonly flushIntervalMs: number;

  private readonly maxRetries: number;

  private readonly maxBackoffMs: number;

  private readonly maxQueueSize: number;

  private readonly circuitBreakerThreshold: number;

  private readonly circuitBreakerCooldownMs: number;
  private readonly persistedQueueFilePath: string | null;
  private readonly persistDebounceMs: number;

  private readonly queue: Readonly<AnyTelemetryEvent>[] = [];

  private flushTimer: ReturnType<typeof setInterval> | null = null;

  private flushing = false;

  private consecutiveFailures = 0;

  private circuitOpenUntilMs = 0;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private persistInFlight: Promise<void> | null = null;
  private persistRequestedDuringFlight = false;
  private hydratedCount = 0;
  private droppedOnHydrate = 0;
  private lastPersistedAt: string | null = null;
  private lastPersistError: string | null = null;

  public constructor(options: HttpSinkAdapterOptions) {
    this.options = options;
    if (!this.options.endpoint.baseUrl) {
      throw new Error(`HTTP endpoint '${this.options.endpoint.id}' is missing baseUrl.`);
    }

    const base = new URL(this.options.endpoint.baseUrl);
    base.search = '';
    base.hash = '';

    const ingest = new URL(base.toString());
    ingest.pathname = '/ingest';
    this.ingestUrl = ingest.toString();

    const batch = new URL(base.toString());
    batch.pathname = '/ingest/batch';
    this.ingestBatchUrl = batch.toString();

    this.batchSize = Math.max(1, options.batchSize ?? 50);
    this.flushIntervalMs = Math.max(200, options.flushIntervalMs ?? 2_000);
    this.maxRetries = Math.max(0, options.maxRetries ?? 3);
    this.maxBackoffMs = Math.max(500, options.maxBackoffMs ?? 10_000);
    this.maxQueueSize = Math.max(this.batchSize, options.maxQueueSize ?? 10_000);
    this.circuitBreakerThreshold = Math.max(1, options.circuitBreakerThreshold ?? 5);
    this.circuitBreakerCooldownMs = Math.max(500, options.circuitBreakerCooldownMs ?? 15_000);
    this.persistedQueueFilePath = options.persistedQueueFilePath ?? null;
    this.persistDebounceMs = Math.max(50, options.persistDebounceMs ?? 250);

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);

    if (this.persistedQueueFilePath) {
      void this.hydrateQueueFromDisk();
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };
    if (this.options.endpoint.auth?.mode === 'token' && this.options.endpoint.auth.token) {
      headers.Authorization = `Bearer ${this.options.endpoint.auth.token}`;
    }
    if (this.options.endpoint.headers) {
      Object.assign(headers, this.options.endpoint.headers);
    }
    return headers;
  }

  private isEnvelope(value: unknown): value is Readonly<AnyTelemetryEvent> {
    if (typeof value !== 'object' || value === null) {
      return false;
    }
    const record = value as Record<string, unknown>;
    return (
      typeof record.version === 'string' &&
      typeof record.id === 'string' &&
      typeof record.ts === 'string' &&
      typeof record.machineId === 'string' &&
      typeof record.severity === 'string' &&
      typeof record.type === 'string' &&
      'payload' in record &&
      typeof record.trace === 'object' &&
      record.trace !== null
    );
  }

  private enqueue(event: Readonly<AnyTelemetryEvent>): IngestResult {
    if (this.queue.length >= this.maxQueueSize) {
      return {
        ok: false,
        error: {
          code: 'invalid_envelope',
          message: 'HttpSinkAdapter queue is full.',
        },
      };
    }

    this.queue.push(event);
    this.scheduleQueuePersist();
    if (this.queue.length >= this.batchSize) {
      void this.flush();
    }

    return {
      ok: true,
      event,
    };
  }

  private scheduleQueuePersist(): void {
    if (!this.persistedQueueFilePath) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persistQueueToDisk();
    }, this.persistDebounceMs);
  }

  private async hydrateQueueFromDisk(): Promise<void> {
    if (!this.persistedQueueFilePath) return;
    try {
      const node = await getNodePersistenceApis();
      const raw = await node.fs.readFile(this.persistedQueueFilePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return;
      }
      const valid = parsed.filter((item): item is Readonly<AnyTelemetryEvent> =>
        this.isEnvelope(item)
      );
      if (valid.length === 0) {
        return;
      }
      const limited = valid.slice(0, this.maxQueueSize);
      this.queue.push(...limited);
      this.hydratedCount = limited.length;
      this.droppedOnHydrate = Math.max(0, valid.length - limited.length);
    } catch {
      // no-op: missing/corrupt spool file should not block startup
    }
  }

  private async persistQueueToDisk(): Promise<void> {
    if (!this.persistedQueueFilePath) return;
    if (this.persistInFlight) {
      this.persistRequestedDuringFlight = true;
      await this.persistInFlight;
      this.persistRequestedDuringFlight = false;
    }

    const filePath = this.persistedQueueFilePath;
    const tmpPath = `${filePath}.tmp`;
    const snapshot = [...this.queue];
    this.persistInFlight = (async () => {
      try {
        const node = await getNodePersistenceApis();
        await node.fs.mkdir(node.path.dirname(filePath), { recursive: true });
        await node.fs.writeFile(tmpPath, JSON.stringify(snapshot), 'utf8');
        await node.fs.rename(tmpPath, filePath);
        this.lastPersistedAt = new Date().toISOString();
        this.lastPersistError = null;
      } catch (error) {
        this.lastPersistError = error instanceof Error ? error.message : String(error);
      }
    })();

    try {
      await this.persistInFlight;
    } finally {
      this.persistInFlight = null;
    }
    if (this.persistRequestedDuringFlight) {
      this.persistRequestedDuringFlight = false;
      await this.persistQueueToDisk();
    }
  }

  public ingest(event: unknown): IngestResult {
    if (!this.isEnvelope(event)) {
      return {
        ok: false,
        error: {
          code: 'invalid_envelope',
          message: 'HttpSinkAdapter expects telemetry envelope input.',
        },
      };
    }

    return this.enqueue(event);
  }

  private static readonly FETCH_TIMEOUT_MS = 10_000;

  private async postBatch(events: readonly Readonly<AnyTelemetryEvent>[]): Promise<Response> {
    return fetch(this.ingestBatchUrl, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(HttpSinkAdapter.FETCH_TIMEOUT_MS),
    });
  }

  private async postSingle(event: Readonly<AnyTelemetryEvent>): Promise<Response> {
    return fetch(this.ingestUrl, {
      method: 'POST',
      headers: this.buildHeaders(),
      body: JSON.stringify(event),
      signal: AbortSignal.timeout(HttpSinkAdapter.FETCH_TIMEOUT_MS),
    });
  }

  private isTransientStatus(status: number): boolean {
    return status >= 500 || status === 429;
  }

  private async postWithRetry(events: readonly Readonly<AnyTelemetryEvent>[]): Promise<boolean> {
    let attempt = 0;

    while (attempt <= this.maxRetries) {
      try {
        const response = await this.postBatch(events);
        if (response.ok) {
          return true;
        }

        // Fallback for servers that do not support /ingest/batch yet.
        if (response.status === 404 || response.status === 405) {
          for (const event of events) {
            const singleResponse = await this.postSingle(event);
            if (!singleResponse.ok) {
              if (!this.isTransientStatus(singleResponse.status)) {
                return false;
              }
              throw new Error(`single_ingest_${String(singleResponse.status)}`);
            }
          }
          return true;
        }

        if (!this.isTransientStatus(response.status)) {
          return false;
        }
      } catch {
        // network/transient error, continue to retry path
      }

      if (attempt === this.maxRetries) {
        return false;
      }

      const base = Math.min(this.maxBackoffMs, 500 * 2 ** attempt);
      const jitter = Math.floor(Math.random() * 250);
      await new Promise<void>((resolve) => {
        setTimeout(resolve, base + jitter);
      });
      attempt += 1;
    }

    return false;
  }

  public async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) {
      return;
    }

    if (Date.now() < this.circuitOpenUntilMs) {
      return;
    }

    this.flushing = true;
    try {
      const chunk = this.queue.splice(0, this.batchSize);
      const ok = await this.postWithRetry(chunk);
      if (!ok) {
        this.consecutiveFailures += 1;
        if (this.consecutiveFailures >= this.circuitBreakerThreshold) {
          this.circuitOpenUntilMs = Date.now() + this.circuitBreakerCooldownMs;
          this.consecutiveFailures = 0;
        }
        // Requeue at the front to preserve ordering when delivery fails.
        this.queue.unshift(...chunk);
        this.scheduleQueuePersist();
      } else {
        this.consecutiveFailures = 0;
        this.circuitOpenUntilMs = 0;
        this.scheduleQueuePersist();
      }
    } finally {
      this.flushing = false;
    }
  }

  public async close(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }

    // Best-effort flush until queue is empty or one flush fails.
    while (this.queue.length > 0) {
      const before = this.queue.length;
      await this.flush();
      if (this.queue.length === before) {
        break;
      }
    }
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persistQueueToDisk();
  }

  public ingestMany(events: readonly unknown[]): BatchIngestResult {
    const accepted: Readonly<AnyTelemetryEvent>[] = [];
    const rejected: IngestFailure[] = [];

    for (const event of events) {
      const result = this.ingest(event);
      if (result.ok) {
        accepted.push(result.event);
      } else {
        rejected.push(result);
      }
    }

    return {
      accepted,
      rejected,
    };
  }

  public getStats(): HttpSinkAdapterStats {
    return {
      queueSize: this.queue.length,
      maxQueueSize: this.maxQueueSize,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpenUntilMs: this.circuitOpenUntilMs,
      spool: {
        enabled: Boolean(this.persistedQueueFilePath),
        filePath: this.persistedQueueFilePath,
        hydratedCount: this.hydratedCount,
        droppedOnHydrate: this.droppedOnHydrate,
        lastPersistedAt: this.lastPersistedAt,
        lastPersistError: this.lastPersistError,
      },
    };
  }
}

export interface SshTunnelAdapterConfig {
  endpoint: MachineEndpoint;
  ssh: SshConfig;
}

export interface TunnelLifecycle {
  start(): void;
  stop(): void;
  isActive(): boolean;
}

export class SshTunnelAdapter implements TunnelLifecycle {
  private readonly config: SshTunnelAdapterConfig;

  private active = false;

  public constructor(config: SshTunnelAdapterConfig) {
    this.config = config;
    void this.config;
  }

  public start(): void {
    // Placeholder only. Real SSH tunnel lifecycle is intentionally not implemented in this phase.
    this.active = true;
  }

  public stop(): void {
    this.active = false;
  }

  public isActive(): boolean {
    return this.active;
  }
}
