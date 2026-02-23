import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cors from '@fastify/cors';
import path from 'node:path';
import os from 'node:os';
import {
  TelemetryAggregator,
  TelemetryNode,
  CronService,
  OpenClawTargetStore,
  OpenClawSyncManager,
  toFrontendUnifiedSnapshot,
  type AnyTelemetryEvent,
  type AuthConfig,
  type MachineEndpoint,
  type OpenClawCronJob,
  type OpenClawRunRecord,
  type OpenClawSyncStatus,
  type OpenClawTarget,
  type OpenClawTargetInput,
  type OpenClawTargetPatch,
  type ScheduledTask,
  type TaskCreateInput,
  type TaskPatchInput,
  type TaskEvent,
} from '@patze/telemetry-core';
import { RemoteNodeAttachmentOrchestrator } from './remote-node-attachment-orchestrator.js';
import { BridgeSetupManager, type BridgeSetupInput } from './bridge-setup-manager.js';
import { SshTunnelRuntime } from './ssh-tunnel-runtime.js';
import { createTaskExecutor } from './task-executor.js';
import { listSshConfigAliases } from './ssh-config-parser.js';
import {
  readFullConfig,
  readAgents,
  readModels,
  readBindings,
  readRawConfigString,
} from './openclaw-config-reader.js';
import { OpenClawCommandQueue } from './openclaw-command-queue.js';
import { SftpSessionManager, type CustomSshConnection } from './sftp-session-manager.js';
import multipart from '@fastify/multipart';

import { execFile as execFileCb } from 'node:child_process';
import { promisify } from 'node:util';

const execFileNode = promisify(execFileCb);

const INGEST_BODY_LIMIT_BYTES = 1024 * 1024;
const CRON_SYNC_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
const APP_BODY_LIMIT_BYTES = Math.max(INGEST_BODY_LIMIT_BYTES, CRON_SYNC_BODY_LIMIT_BYTES);
const SSE_HEARTBEAT_MS = 15_000;
const SSE_MAX_PENDING_CHUNKS = 1_024;
const BRIDGE_CRON_SYNC_RATE_LIMIT_WINDOW_MS = 60_000;
const BRIDGE_CRON_SYNC_RATE_LIMIT_MAX_REQUESTS = Number(
  process.env.BRIDGE_CRON_SYNC_RATE_LIMIT_MAX ?? '60'
);

// ── OpenClaw CLI detection ──

interface CliStatus {
  readonly available: boolean;
  readonly version: string | null;
  readonly checkedAt: number;
}

let cachedCliStatus: CliStatus = { available: false, version: null, checkedAt: 0 };
const CLI_CHECK_TTL_MS = 60_000;

async function checkOpenClawCli(): Promise<CliStatus> {
  if (Date.now() - cachedCliStatus.checkedAt < CLI_CHECK_TTL_MS) return cachedCliStatus;
  try {
    const { stdout } = await execFileNode('openclaw', ['--version'], {
      timeout: 5_000,
      maxBuffer: 256 * 1024,
    });
    cachedCliStatus = {
      available: true,
      version: stdout.trim() || 'unknown',
      checkedAt: Date.now(),
    };
  } catch {
    cachedCliStatus = { available: false, version: null, checkedAt: Date.now() };
  }
  return cachedCliStatus;
}

void checkOpenClawCli();

interface HealthCheckItem {
  readonly id: string;
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'error';
  readonly message: string;
  readonly details: string | undefined;
}

interface OpenClawHealthCheck {
  readonly ok: boolean;
  readonly target: string;
  readonly checks: readonly HealthCheckItem[];
  readonly syncStatus: OpenClawSyncStatus;
  readonly cliAvailable: boolean;
  readonly cliVersion: string | null;
}

interface OpenClawChannelBoundAgent {
  readonly agentId: string;
  readonly modelOverride?: string;
}

interface OpenClawChannelSummary {
  readonly id: string;
  readonly name: string;
  readonly configured: boolean;
  readonly dmPolicy: 'pairing' | 'allowlist' | 'open' | 'disabled' | 'unknown';
  readonly groupPolicy: 'open' | 'allowlist' | 'disabled' | 'unknown';
  readonly allowFrom: readonly string[];
  readonly allowFromCount: number;
  readonly allowFromHasWildcard: boolean;
  readonly hasGroups: boolean;
  readonly connected: boolean;
  readonly runtimeState: 'connected' | 'disconnected' | 'unknown';
  readonly accountSummary: {
    readonly total: number;
    readonly enabled: number;
    readonly configured: number;
    readonly connected: number;
    readonly runtimeKnown: number;
  };
  readonly boundAgents: readonly OpenClawChannelBoundAgent[];
  readonly lastMessageAt?: string;
  readonly messageCount?: number;
}

interface BridgeConnectionInfo {
  readonly machineId: string;
  readonly machineLabel: string | undefined;
  readonly bridgeVersion: string | undefined;
  readonly sourceIp: string;
  readonly lastSeenAt: string;
}

interface BridgeCronSyncPayload {
  readonly machineId: string;
  readonly machineLabel: string | undefined;
  readonly bridgeVersion: string | undefined;
  readonly jobsHash: string;
  readonly jobs: readonly OpenClawCronJob[] | undefined;
  readonly newRuns: Readonly<Record<string, readonly OpenClawRunRecord[]>>;
  readonly sentAt: string | undefined;
}

type IngestRequest = FastifyRequest<{ Body: unknown }>;
type BatchIngestRequest = FastifyRequest<{ Body: unknown }>;
type RawResponse = FastifyReply['raw'];

const app = Fastify({
  logger: true,
  bodyLimit: APP_BODY_LIMIT_BYTES,
});

const ALLOWED_ORIGINS = [
  /^https?:\/\/localhost(:\d+)?$/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?$/,
  /^https?:\/\/\[::1\](:\d+)?$/,
  /^tauri:\/\//,
];

await app.register(cors, {
  origin: (origin, callback) => {
    if (!origin || ALLOWED_ORIGINS.some((pattern) => pattern.test(origin))) {
      callback(null, true);
    } else {
      callback(new Error('CORS: origin not allowed'), false);
    }
  },
});

const telemetryNode = new TelemetryNode();
const telemetryAggregator = new TelemetryAggregator();
telemetryAggregator.attachNode('local', telemetryNode);

const sshTunnelRuntime = new SshTunnelRuntime();
const orchestrator = new RemoteNodeAttachmentOrchestrator(sshTunnelRuntime, telemetryAggregator);
const bridgeConnections = new Map<string, BridgeConnectionInfo>();
const bridgeCronSyncRateBuckets = new Map<string, { windowStartMs: number; count: number }>();

function getRequestIp(request: FastifyRequest): string {
  const forwarded = request.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0]?.trim() ?? request.ip;
  }
  return request.ip;
}

function upsertBridgeConnection(
  machineId: string,
  sourceIp: string,
  options?: {
    machineLabel: string | undefined;
    bridgeVersion: string | undefined;
    lastSeenAt: string | undefined;
  }
): void {
  const existing = bridgeConnections.get(machineId);
  const next: BridgeConnectionInfo = {
    machineId,
    machineLabel: options?.machineLabel ?? existing?.machineLabel,
    bridgeVersion: options?.bridgeVersion ?? existing?.bridgeVersion,
    sourceIp,
    lastSeenAt: options?.lastSeenAt ?? new Date().toISOString(),
  };
  bridgeConnections.set(machineId, next);
}

function consumeBridgeCronSyncRateLimit(
  machineId: string,
  sourceIp: string
): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const key = `${machineId}:${sourceIp}`;
  const now = Date.now();
  const existing = bridgeCronSyncRateBuckets.get(key);

  if (!existing || now - existing.windowStartMs >= BRIDGE_CRON_SYNC_RATE_LIMIT_WINDOW_MS) {
    bridgeCronSyncRateBuckets.set(key, {
      windowStartMs: now,
      count: 1,
    });
    return { ok: true };
  }

  if (existing.count >= BRIDGE_CRON_SYNC_RATE_LIMIT_MAX_REQUESTS) {
    const elapsed = now - existing.windowStartMs;
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((BRIDGE_CRON_SYNC_RATE_LIMIT_WINDOW_MS - elapsed) / 1000)
    );
    return { ok: false, retryAfterSeconds };
  }

  existing.count += 1;
  return { ok: true };
}

const RATE_BUCKET_CLEANUP_INTERVAL_MS = 5 * 60_000;
const rateBucketCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, bucket] of bridgeCronSyncRateBuckets) {
    if (now - bucket.windowStartMs >= BRIDGE_CRON_SYNC_RATE_LIMIT_WINDOW_MS * 2) {
      bridgeCronSyncRateBuckets.delete(key);
    }
  }
}, RATE_BUCKET_CLEANUP_INTERVAL_MS);
rateBucketCleanupTimer.unref();

const BRIDGE_STALE_TTL_MS = 24 * 60 * 60_000;
const bridgeCleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [machineId, info] of bridgeConnections) {
    const lastSeen = new Date(info.lastSeenAt).getTime();
    if (Number.isNaN(lastSeen) || now - lastSeen > BRIDGE_STALE_TTL_MS) {
      bridgeConnections.delete(machineId);
    }
  }
}, RATE_BUCKET_CLEANUP_INTERVAL_MS);
bridgeCleanupTimer.unref();

const AUTH_SETTINGS_DIR =
  process.env.PATZE_SETTINGS_DIR ?? path.join(os.homedir(), '.patze-control');
const AUTH_SETTINGS_FILE = path.join(AUTH_SETTINGS_DIR, 'auth.json');

interface PersistedAuthSettings {
  mode: 'none' | 'token';
  token?: string;
}

function loadPersistedAuth(): PersistedAuthSettings | null {
  try {
    if (!fs.existsSync(AUTH_SETTINGS_FILE)) return null;
    const raw = fs.readFileSync(AUTH_SETTINGS_FILE, 'utf-8');
    const parsed = JSON.parse(raw) as PersistedAuthSettings;
    if (parsed.mode === 'token' || parsed.mode === 'none') return parsed;
    return null;
  } catch {
    return null;
  }
}

function savePersistedAuth(settings: PersistedAuthSettings): void {
  fs.mkdirSync(AUTH_SETTINGS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(AUTH_SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

function loadAuthConfig(): AuthConfig {
  const persisted = loadPersistedAuth();
  if (persisted) {
    return {
      mode: persisted.mode,
      ...(persisted.token ? { token: persisted.token } : {}),
    };
  }

  const rawMode = process.env.TELEMETRY_AUTH_MODE;
  if (rawMode === 'token') {
    const token = process.env.TELEMETRY_AUTH_TOKEN;
    return {
      mode: 'token',
      ...(token ? { token } : {}),
    };
  }

  return { mode: 'none' };
}

let authConfig = loadAuthConfig();

function getAuthToken(): string | null {
  return authConfig.mode === 'token' ? (authConfig.token ?? null) : null;
}

function authHasToken(): boolean {
  const t = getAuthToken();
  return t !== null && t.length > 0;
}

if (authConfig.mode === 'token' && !authHasToken()) {
  throw new Error('TELEMETRY_AUTH_TOKEN is required when TELEMETRY_AUTH_MODE=token.');
}

function parseBearerToken(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header) {
    return null;
  }

  const spaceIndex = header.indexOf(' ');
  if (spaceIndex === -1) {
    return null;
  }

  const scheme = header.slice(0, spaceIndex);
  const token = header.slice(spaceIndex + 1);
  if (scheme !== 'Bearer' || token.length === 0) {
    return null;
  }

  return token;
}

const HMAC_KEY = randomBytes(32);

function constantTimeEquals(a: string, b: string): boolean {
  const digestA = createHmac('sha256', HMAC_KEY).update(a).digest();
  const digestB = createHmac('sha256', HMAC_KEY).update(b).digest();
  return timingSafeEqual(digestA, digestB);
}

function isAuthorized(request: FastifyRequest): boolean {
  if (authConfig.mode === 'none') {
    return true;
  }

  const requestToken = parseBearerToken(request);
  const serverToken = getAuthToken();
  if (requestToken === null || serverToken === null) {
    return false;
  }

  return constantTimeEquals(requestToken, serverToken);
}

function parsePositiveInt(raw: string | undefined, fallback: number, max: number): number {
  if (!raw) return fallback;
  const value = parseInt(raw, 10);
  if (!Number.isFinite(value) || Number.isNaN(value) || value < 0) return fallback;
  return Math.min(value, max);
}

function isJsonContentType(request: FastifyRequest): boolean {
  const contentType = request.headers['content-type'];
  if (!contentType) {
    return false;
  }

  const normalized = contentType.toLowerCase();
  return normalized.startsWith('application/json');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const BLOCKED_DIR_PREFIXES = [
  '/etc',
  '/var',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/sbin',
  '/bin',
  '/usr/sbin',
  '/usr/bin',
  '/lib',
  '/tmp',
];

function isOpenClawDirSafe(resolvedDir: string): boolean {
  if (resolvedDir === '/' || resolvedDir === os.homedir()) return false;
  for (const prefix of BLOCKED_DIR_PREFIXES) {
    if (resolvedDir === prefix || resolvedDir.startsWith(prefix + path.sep)) return false;
  }
  const homeDir = os.homedir();
  const safePrefixes = [
    path.join(homeDir, '.openclaw'),
    path.join(homeDir, '.patze-control'),
    path.join(homeDir, 'openclaw'),
  ];
  const isUnderHome = resolvedDir.startsWith(homeDir + path.sep);
  if (!isUnderHome) return false;
  const isUnderSshDir =
    resolvedDir.startsWith(path.join(homeDir, '.ssh') + path.sep) ||
    resolvedDir === path.join(homeDir, '.ssh');
  if (isUnderSshDir) return false;
  const isUnderGnupg =
    resolvedDir.startsWith(path.join(homeDir, '.gnupg') + path.sep) ||
    resolvedDir === path.join(homeDir, '.gnupg');
  if (isUnderGnupg) return false;
  const isUnderConfig =
    resolvedDir.startsWith(path.join(homeDir, '.config') + path.sep) ||
    resolvedDir === path.join(homeDir, '.config');
  if (isUnderConfig) return false;
  return safePrefixes.some((p) => resolvedDir === p || resolvedDir.startsWith(p + path.sep));
}

function parseBatchBody(body: unknown): readonly unknown[] | null {
  if (!isRecord(body)) {
    return null;
  }
  const events = body.events;
  if (!Array.isArray(events)) {
    return null;
  }
  return events;
}

function getContentLengthBytes(request: FastifyRequest): number | null {
  const raw = request.headers['content-length'];
  if (!raw) {
    return null;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

function isBodySizeWithinLimit(request: FastifyRequest, limitBytes: number): boolean {
  const contentLength = getContentLengthBytes(request);
  if (contentLength === null) {
    return true;
  }
  return contentLength <= limitBytes;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, '_');
}

const SAFE_ENTITY_ID_RE = /^[a-zA-Z0-9_-]+$/;
function isValidEntityId(id: string): boolean {
  return SAFE_ENTITY_ID_RE.test(id) && id.length > 0 && id.length <= 128;
}

function sanitizeRunFilename(jobId: string): string {
  return jobId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function toReadonlyRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return isRecord(value) ? value : null;
}

function readHeaderString(request: FastifyRequest, headerName: string): string | undefined {
  const value = request.headers[headerName];
  if (typeof value === 'string' && value.trim().length > 0) {
    return value.trim();
  }
  return undefined;
}

function writeSseEventChunk(event: Readonly<AnyTelemetryEvent>): string {
  return writeSseNamedEventChunk('telemetry', event, event.id);
}

function writeSseNamedEventChunk(
  eventType: string,
  payload: Readonly<unknown>,
  id?: string
): string {
  const idLine = id ? `id: ${id}\n` : '';
  return `${idLine}event: ${eventType}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function writeSseCommentChunk(comment: string): string {
  return `: ${comment}\n\n`;
}

function createSseWriter(response: RawResponse): {
  enqueue: (chunk: string) => void;
  close: () => void;
} {
  return createBoundedSseWriter(response, {
    maxPendingChunks: SSE_MAX_PENDING_CHUNKS,
    onOverflow: () => {
      response.destroy();
    },
  });
}

function createBoundedSseWriter(
  response: RawResponse,
  options: {
    maxPendingChunks: number;
    onOverflow: () => void;
  }
): {
  enqueue: (chunk: string) => void;
  close: () => void;
} {
  let isClosed = false;
  let isBackpressured = false;
  const pending: string[] = [];

  const flushPending = (): void => {
    if (isClosed || !isBackpressured) {
      return;
    }

    isBackpressured = false;
    while (pending.length > 0) {
      const next = pending.shift();
      if (!next) {
        continue;
      }

      const accepted = response.write(next);
      if (!accepted) {
        isBackpressured = true;
        return;
      }
    }
  };

  const onDrain = (): void => {
    flushPending();
  };

  response.on('drain', onDrain);

  const enqueue = (chunk: string): void => {
    if (isClosed) {
      return;
    }

    if (isBackpressured) {
      if (pending.length >= options.maxPendingChunks) {
        options.onOverflow();
        return;
      }
      pending.push(chunk);
      return;
    }

    const accepted = response.write(chunk);
    if (!accepted) {
      isBackpressured = true;
    }
  };

  const close = (): void => {
    if (isClosed) {
      return;
    }

    isClosed = true;
    pending.length = 0;
    response.off('drain', onDrain);
  };

  return { enqueue, close };
}

app.post('/ingest', async (request: IngestRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  if (!isBodySizeWithinLimit(request, INGEST_BODY_LIMIT_BYTES)) {
    return reply.code(413).send({ error: 'payload_too_large' });
  }

  if (!isJsonContentType(request)) {
    return reply.code(415).send({ error: 'unsupported_media_type' });
  }

  const machineIdHeader = readHeaderString(request, 'x-patze-machine-id');
  if (machineIdHeader) {
    upsertBridgeConnection(machineIdHeader, getRequestIp(request), {
      machineLabel: readHeaderString(request, 'x-patze-machine-label'),
      bridgeVersion: readHeaderString(request, 'x-patze-bridge-version'),
      lastSeenAt: undefined,
    });
  }

  const result = telemetryNode.ingest(request.body);

  if (result.ok) {
    return reply.code(200).send(result);
  }

  return reply.code(400).send(result);
});

app.post('/ingest/batch', async (request: BatchIngestRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  if (!isBodySizeWithinLimit(request, INGEST_BODY_LIMIT_BYTES)) {
    return reply.code(413).send({ error: 'payload_too_large' });
  }

  if (!isJsonContentType(request)) {
    return reply.code(415).send({ error: 'unsupported_media_type' });
  }

  const machineIdHeader = readHeaderString(request, 'x-patze-machine-id');
  if (machineIdHeader) {
    upsertBridgeConnection(machineIdHeader, getRequestIp(request), {
      machineLabel: readHeaderString(request, 'x-patze-machine-label'),
      bridgeVersion: readHeaderString(request, 'x-patze-bridge-version'),
      lastSeenAt: undefined,
    });
  }

  const events = parseBatchBody(request.body);
  if (!events) {
    return reply.code(400).send({ error: 'invalid_batch_request' });
  }

  const accepted: Array<{ index: number; event: Readonly<AnyTelemetryEvent> }> = [];
  const rejected: Array<{ index: number; error: { code: string; message: string } }> = [];

  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const result = telemetryNode.ingest(event);
    if (result.ok) {
      accepted.push({ index, event: result.event });
      continue;
    }
    rejected.push({
      index,
      error: {
        code: result.error.code,
        message: result.error.message,
      },
    });
  }

  return reply.code(200).send({
    accepted,
    rejected,
    acceptedCount: accepted.length,
    rejectedCount: rejected.length,
  });
});

app.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
  const cli = await checkOpenClawCli();
  return reply.code(200).send({
    ok: true,
    authMode: authConfig.mode,
    authRequired: authConfig.mode === 'token',
    openclawCliAvailable: cli.available,
    openclawCliVersion: cli.version,
  });
});

app.get('/snapshot', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const unified = telemetryAggregator.getUnifiedSnapshot();
  const frontendSnapshot = toFrontendUnifiedSnapshot(unified);
  // TODO: align snapshot/event resume via Last-Event-ID when server-side replay is added.
  return reply.code(200).send(frontendSnapshot);
});

app.get('/events', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  reply.hijack();

  const response = reply.raw;
  const origin = request.headers.origin;
  if (origin && ALLOWED_ORIGINS.some((pattern) => pattern.test(origin))) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();

  const sse = createSseWriter(response);
  sse.enqueue(writeSseCommentChunk('connected'));

  const unsubscribe = telemetryAggregator.subscribeEvents((event: Readonly<AnyTelemetryEvent>) => {
    sse.enqueue(writeSseEventChunk(event));
  });

  const heartbeat = setInterval(() => {
    sse.enqueue(writeSseCommentChunk('heartbeat'));
  }, SSE_HEARTBEAT_MS);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    unsubscribe();
    sse.close();

    if (!response.writableEnded && !response.destroyed) {
      response.end();
    }

    request.raw.off('close', cleanup);
    response.off('close', cleanup);
    response.off('error', cleanup);
  };

  request.raw.on('close', cleanup);
  response.on('close', cleanup);
  response.on('error', cleanup);
});

type AttachRequest = FastifyRequest<{ Body: unknown }>;
type DetachRequest = FastifyRequest<{ Body: unknown }>;

interface AttachRequestBody {
  host: string;
  port: number;
  sshUser: string;
  remoteBaseUrl: string;
  label?: string;
  authToken?: string;
  sshKeyPath?: string;
}

function parseAttachBody(body: unknown): AttachRequestBody | null {
  if (!isRecord(body)) return null;
  if (typeof body.host !== 'string' || !body.host) return null;
  if (typeof body.sshUser !== 'string' || !body.sshUser) return null;
  const port = typeof body.port === 'number' ? body.port : 22;
  if (port < 1 || port > 65535) return null;
  const remoteBaseUrl =
    typeof body.remoteBaseUrl === 'string' ? body.remoteBaseUrl : 'http://127.0.0.1:9700';
  return {
    host: body.host,
    port,
    sshUser: body.sshUser,
    remoteBaseUrl,
    ...(typeof body.label === 'string' ? { label: body.label } : {}),
    ...(typeof body.authToken === 'string' ? { authToken: body.authToken } : {}),
    ...(typeof body.sshKeyPath === 'string' ? { sshKeyPath: body.sshKeyPath } : {}),
  };
}

function isPathUnderSshDir(keyPath: string): boolean {
  const homeDir = process.env.HOME ?? os.homedir();
  const resolved = path.resolve(keyPath.startsWith('~') ? keyPath.replace('~', homeDir) : keyPath);
  const allowedDir = path.resolve(homeDir, '.ssh');
  return resolved.startsWith(allowedDir + path.sep) || resolved === allowedDir;
}

function attachBodyToEndpoint(body: AttachRequestBody): MachineEndpoint {
  const endpointId = `remote_${body.host}_${body.port}_${body.sshUser}`;
  const label = body.label ?? `${body.sshUser}@${body.host}`;
  const auth: AuthConfig = body.authToken
    ? { mode: 'token', token: body.authToken }
    : { mode: 'none' };

  const homeDir = process.env.HOME ?? os.homedir();
  const defaultSshDir = path.join(homeDir, '.ssh');
  let privateKeyPath = path.join(defaultSshDir, 'id_rsa');
  let knownHostsPath = path.join(defaultSshDir, 'known_hosts');

  if (body.sshKeyPath) {
    if (!isPathUnderSshDir(body.sshKeyPath)) {
      throw new Error('SSH key path must be under ~/.ssh/');
    }
    const resolved = body.sshKeyPath.startsWith('~')
      ? body.sshKeyPath.replace('~', homeDir)
      : body.sshKeyPath;
    privateKeyPath = resolved;
    knownHostsPath = path.join(path.dirname(resolved), 'known_hosts');
  }

  return {
    id: endpointId,
    label,
    transport: 'ssh_tunnel',
    baseUrl: body.remoteBaseUrl,
    ssh: {
      host: body.host,
      port: body.port,
      user: body.sshUser,
      knownHostsPath,
      privateKeyPath,
    },
    auth,
  };
}

app.post('/remote/attach', async (request: AttachRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const body = parseAttachBody(request.body);
  if (!body) {
    return reply
      .code(400)
      .send({ error: 'invalid_attach_body', message: 'host and sshUser are required.' });
  }

  const endpoint = attachBodyToEndpoint(body);

  try {
    const info = await orchestrator.attachEndpoint(endpoint);
    return reply.code(200).send({ ...info, attachmentId: info.endpointId });
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    app.log.error({ err: error }, 'attach_failed');
    const safeMsg = msg.includes('/') ? 'SSH connection or tunnel setup failed.' : msg;
    return reply.code(500).send({ error: 'attach_failed', message: safeMsg });
  }
});

app.post('/remote/detach', async (request: DetachRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_detach_body' });
  }

  const rawId = request.body.attachmentId ?? request.body.endpointId;
  if (typeof rawId !== 'string' || !rawId) {
    return reply.code(400).send({ error: 'attachmentId or endpointId is required' });
  }

  try {
    await orchestrator.detachEndpoint(rawId, { closeTunnel: true });
    return reply.code(200).send({ ok: true });
  } catch (error) {
    app.log.error({ err: error }, 'detach_failed');
    return reply.code(500).send({ error: 'detach_failed', message: 'Failed to detach endpoint.' });
  }
});

app.get('/remote/attachments', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const attachments = orchestrator.listAttachments().map((a) => ({
    id: a.endpointId,
    host: a.tunnel.remoteHost,
    port: a.tunnel.remotePort,
    sshUser: a.sshUser,
    status: 'connected',
  }));

  return reply.code(200).send(attachments);
});

app.get('/tunnels', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  return reply.code(200).send({ tunnels: sshTunnelRuntime.listTunnels() });
});

app.get('/bridge/connections', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const connections = [...bridgeConnections.values()].sort((a, b) =>
    b.lastSeenAt.localeCompare(a.lastSeenAt)
  );
  return reply.code(200).send({ connections });
});

app.get('/ssh/config-hosts', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const aliases = await listSshConfigAliases();
  return reply.code(200).send({ aliases });
});

app.post('/bridge/preflight', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const body = request.body as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  const sshHost = typeof body.sshHost === 'string' ? body.sshHost.trim() : '';
  const sshPort = typeof body.sshPort === 'number' ? body.sshPort : 22;
  const sshUser = typeof body.sshUser === 'string' ? body.sshUser.trim() : 'root';
  const sshKeyPath = typeof body.sshKeyPath === 'string' ? body.sshKeyPath.trim() : '~/.ssh/id_rsa';
  const sshModeRaw = typeof body.sshMode === 'string' ? body.sshMode.trim() : '';
  const sshMode = sshModeRaw === 'alias' || sshModeRaw === 'explicit' ? sshModeRaw : undefined;

  if (!sshHost) {
    return reply.code(400).send({ error: 'missing_ssh_host' });
  }
  if (sshModeRaw && !sshMode) {
    return reply
      .code(400)
      .send({ error: 'invalid_ssh_mode', message: 'sshMode must be "alias" or "explicit".' });
  }
  if (sshPort < 1 || sshPort > 65535) {
    return reply
      .code(400)
      .send({ error: 'invalid_ssh_port', message: 'Port must be between 1 and 65535.' });
  }

  try {
    const result = await bridgeSetupManager.preflight({
      label: sshHost,
      sshHost,
      sshPort,
      sshUser,
      sshKeyPath,
      sshMode,
      authToken: '',
      remotePort: 19700,
    });
    return reply.code(200).send(result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    app.log.warn({ err }, 'bridge_preflight_failed');
    const safeMsg = msg.includes('/') && !msg.includes('~/.ssh') ? 'SSH pre-flight failed.' : msg;
    return reply.code(422).send({ ok: false, error: 'preflight_failed', message: safeMsg });
  }
});

// ── Managed Bridge Setup (from UI) ───────────────────────────────────

app.post('/bridge/setup', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const body = request.body as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    return reply.code(400).send({ error: 'invalid_body' });
  }

  const label = typeof body.label === 'string' ? body.label.trim() : '';
  const sshHost = typeof body.sshHost === 'string' ? body.sshHost.trim() : '';
  const sshPort = typeof body.sshPort === 'number' ? body.sshPort : 22;
  const sshUser = typeof body.sshUser === 'string' ? body.sshUser.trim() : 'root';
  const sshKeyPath = typeof body.sshKeyPath === 'string' ? body.sshKeyPath.trim() : '~/.ssh/id_rsa';
  const sshModeRaw = typeof body.sshMode === 'string' ? body.sshMode.trim() : '';
  const sshMode = sshModeRaw === 'alias' || sshModeRaw === 'explicit' ? sshModeRaw : undefined;
  const authToken = typeof body.authToken === 'string' ? body.authToken.trim() : '';
  const remotePort = typeof body.remotePort === 'number' ? body.remotePort : 19700;
  const expiresIn = typeof body.expiresIn === 'string' ? body.expiresIn.trim() : undefined;
  const openclawHome = typeof body.openclawHome === 'string' ? body.openclawHome.trim() : undefined;

  if (!sshHost) {
    return reply.code(400).send({ error: 'missing_ssh_host' });
  }
  if (sshModeRaw && !sshMode) {
    return reply
      .code(400)
      .send({ error: 'invalid_ssh_mode', message: 'sshMode must be "alias" or "explicit".' });
  }
  if (sshPort < 1 || sshPort > 65535) {
    return reply
      .code(400)
      .send({ error: 'invalid_ssh_port', message: 'Port must be between 1 and 65535.' });
  }
  if (remotePort < 1 || remotePort > 65535) {
    return reply
      .code(400)
      .send({ error: 'invalid_remote_port', message: 'Port must be between 1 and 65535.' });
  }

  const input: BridgeSetupInput = {
    label: label || sshHost,
    sshHost,
    sshPort,
    sshUser,
    sshKeyPath,
    sshMode,
    authToken,
    remotePort,
    expiresIn,
    openclawHome,
  };

  try {
    const state = await bridgeSetupManager.setup(input);
    return reply.code(200).send(state);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    app.log.error({ err }, 'bridge_setup_failed');
    const safeMsg = msg.includes('/') && !msg.includes('~/.ssh') ? 'Bridge setup failed.' : msg;
    return reply.code(500).send({ error: 'setup_failed', message: safeMsg });
  }
});

app.get('/bridge/managed', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  return reply.code(200).send({ bridges: bridgeSetupManager.list() });
});

app.get('/bridge/managed/:id', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const { id } = request.params as { id: string };
  const state = bridgeSetupManager.get(id);
  if (!state) {
    return reply.code(404).send({ error: 'not_found' });
  }
  return reply.code(200).send(state);
});

app.post('/bridge/managed/:id/disconnect', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const { id } = request.params as { id: string };
  const ok = bridgeSetupManager.disconnect(id);
  if (!ok) {
    return reply.code(404).send({ error: 'not_found' });
  }
  return reply.code(200).send({ ok: true });
});

app.delete('/bridge/managed/:id', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const { id } = request.params as { id: string };
  const ok = bridgeSetupManager.remove(id);
  if (!ok) {
    return reply.code(404).send({ error: 'not_found' });
  }
  return reply.code(200).send({ ok: true });
});

app.post(
  '/bridge/managed/:id/sudo-password',
  async (request: FastifyRequest, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const { id } = request.params as { id: string };
    const body = request.body as Record<string, unknown> | null;
    const password = body && typeof body.password === 'string' ? body.password : '';
    if (!password) {
      return reply.code(400).send({ error: 'password is required' });
    }
    try {
      const state = await bridgeSetupManager.retryInstallWithSudoPassword(id, password);
      if (!state) return reply.code(404).send({ error: 'not_found' });
      return reply.code(200).send(state);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: 'install_failed', message: msg });
    }
  }
);

app.post('/bridge/managed/:id/skip-sudo', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const { id } = request.params as { id: string };
  try {
    const state = await bridgeSetupManager.retryInstallUserMode(id);
    if (!state) return reply.code(404).send({ error: 'not_found' });
    return reply.code(200).send(state);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return reply.code(500).send({ error: 'install_failed', message: msg });
  }
});

app.post('/openclaw/bridge/cron-sync', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  if (!isBodySizeWithinLimit(request, CRON_SYNC_BODY_LIMIT_BYTES)) {
    return reply.code(413).send({ error: 'payload_too_large' });
  }

  if (!isJsonContentType(request)) {
    return reply.code(415).send({ error: 'unsupported_media_type' });
  }

  const payload = parseBridgeCronSyncPayload(request.body);
  if (!payload) {
    return reply.code(400).send({ error: 'invalid_cron_sync_payload' });
  }

  const sourceIp = getRequestIp(request);
  const rateLimit = consumeBridgeCronSyncRateLimit(payload.machineId, sourceIp);
  if (!rateLimit.ok) {
    reply.header('Retry-After', String(rateLimit.retryAfterSeconds));
    return reply.code(429).send({
      error: 'rate_limited',
      retryAfterSeconds: rateLimit.retryAfterSeconds,
    });
  }

  const target = ensureBridgeProxyTarget(payload.machineId, payload.machineLabel);
  if (payload.jobs) {
    writeBridgeJobsFile(target.openclawDir, payload.jobs);
  }
  if (hasRunDelta(payload.newRuns)) {
    appendBridgeRuns(target.openclawDir, payload.newRuns);
  }

  upsertBridgeConnection(payload.machineId, sourceIp, {
    machineLabel: payload.machineLabel,
    bridgeVersion: payload.bridgeVersion,
    lastSeenAt: payload.sentAt ?? new Date().toISOString(),
  });

  app.log.info(
    {
      machineId: payload.machineId,
      machineLabel: payload.machineLabel,
      bridgeVersion: payload.bridgeVersion,
      sourceIp,
      jobsChanged: payload.jobs !== undefined,
      runDeltaJobs: Object.keys(payload.newRuns).length,
    },
    'Bridge cron sync received'
  );

  return reply.code(200).send({
    ok: true,
    targetId: target.id,
    jobsApplied: payload.jobs !== undefined,
    runDeltaJobs: Object.keys(payload.newRuns).length,
  });
});

const HEARTBEAT_TIMEOUT_MS = Number(process.env.HEARTBEAT_TIMEOUT_MS ?? '120000');
const HEARTBEAT_CHECK_INTERVAL_MS = 60_000;

const lastHeartbeatByMachine = new Map<string, number>();

telemetryAggregator.subscribeEvents((event: Readonly<AnyTelemetryEvent>) => {
  if (event.type === 'machine.heartbeat') {
    lastHeartbeatByMachine.set(event.machineId, Date.now());
  } else if (event.type === 'machine.registered') {
    lastHeartbeatByMachine.set(event.machineId, Date.now());
  }
});

const heartbeatChecker = setInterval(() => {
  const now = Date.now();
  for (const [machineId, lastSeen] of lastHeartbeatByMachine) {
    if (now - lastSeen > HEARTBEAT_TIMEOUT_MS) {
      const offlineEvent = {
        version: 'telemetry.v1',
        id: `synth_offline_${machineId}_${now.toString(36)}`,
        ts: new Date().toISOString(),
        machineId,
        severity: 'warn',
        type: 'machine.heartbeat',
        payload: {
          machineId,
          status: 'offline',
          resource: { cpuPct: 0, memoryBytes: 0, memoryPct: 0 },
        },
        trace: { traceId: `trace_synth_${now.toString(36)}` },
      };
      telemetryNode.ingest(offlineEvent);
      lastHeartbeatByMachine.delete(machineId);
      app.log.warn(
        `Machine ${machineId} marked offline — no heartbeat for ${HEARTBEAT_TIMEOUT_MS}ms`
      );
    }
  }
}, HEARTBEAT_CHECK_INTERVAL_MS);

function exists(targetPath: string): boolean {
  try {
    return fs.existsSync(targetPath);
  } catch {
    return false;
  }
}

function readableDir(targetPath: string): boolean {
  try {
    fs.readdirSync(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function buildOpenClawHealth(
  targetPath: string,
  syncStatus: OpenClawSyncStatus
): Promise<OpenClawHealthCheck> {
  const cli = await checkOpenClawCli();
  const cronDir = path.join(targetPath, 'cron');
  const checks: HealthCheckItem[] = [];

  const addCheck = (check: HealthCheckItem): void => {
    checks.push(check);
  };

  if (!exists(targetPath)) {
    addCheck({
      id: 'openclaw-home',
      name: 'OpenClaw home',
      status: 'error',
      message: `OpenClaw directory not found: ${targetPath}`,
      details: 'Set OPENCLAW_HOME to a valid OpenClaw installation path.',
    });
  } else {
    addCheck({
      id: 'openclaw-home',
      name: 'OpenClaw home',
      status: 'ok',
      message: `${targetPath} is accessible`,
      details: undefined,
    });
  }

  if (!exists(cronDir)) {
    addCheck({
      id: 'openclaw-cron-dir',
      name: 'cron directory',
      status: 'error',
      message: `Missing cron folder: ${cronDir}`,
      details: 'OpenClaw jobs may not be available yet.',
    });
  } else if (!readableDir(cronDir)) {
    addCheck({
      id: 'openclaw-cron-dir',
      name: 'cron directory',
      status: 'error',
      message: `Cannot read cron folder: ${cronDir}`,
      details: 'Ensure read permission for the API server user.',
    });
  } else {
    addCheck({
      id: 'openclaw-cron-dir',
      name: 'cron directory',
      status: 'ok',
      message: 'cron folder is readable',
      details: undefined,
    });
  }

  const jobsFile = path.join(cronDir, 'jobs.json');
  if (!exists(cronDir) || !exists(jobsFile)) {
    addCheck({
      id: 'openclaw-jobs',
      name: 'jobs.json',
      status: syncStatus.available ? 'warn' : 'error',
      message: 'jobs.json not found',
      details: 'Sync will stay in standby until OpenClaw creates jobs.json.',
    });
  } else {
    addCheck({
      id: 'openclaw-jobs',
      name: 'jobs.json',
      status: 'ok',
      message: 'jobs.json found',
      details: undefined,
    });
  }

  const runsDir = path.join(cronDir, 'runs');
  if (exists(runsDir) && readableDir(runsDir)) {
    addCheck({
      id: 'openclaw-runs',
      name: 'runs folder',
      status: 'ok',
      message: 'runs folder is readable',
      details: undefined,
    });
  } else {
    addCheck({
      id: 'openclaw-runs',
      name: 'runs folder',
      status: 'warn',
      message: 'runs folder is missing or unreadable',
      details: 'Run history may be empty until jobs execute.',
    });
  }

  if (syncStatus.consecutiveFailures > 0) {
    addCheck({
      id: 'openclaw-sync-failures',
      name: 'sync health',
      status: syncStatus.consecutiveFailures >= 3 ? 'error' : 'warn',
      message: `${syncStatus.consecutiveFailures} consecutive sync failure(s)`,
      details: syncStatus.lastError,
    });
  } else if (syncStatus.stale) {
    addCheck({
      id: 'openclaw-sync-stale',
      name: 'sync health',
      status: 'warn',
      message: 'sync data is stale',
      details: `Last successful sync at ${syncStatus.lastSuccessfulSyncAt ?? 'unknown'}`,
    });
  } else if (syncStatus.running) {
    addCheck({
      id: 'openclaw-sync-health',
      name: 'sync health',
      status: 'ok',
      message: `Sync running every ${Math.round(syncStatus.pollIntervalMs / 1000)}s`,
      details: undefined,
    });
  } else {
    addCheck({
      id: 'openclaw-sync-health',
      name: 'sync health',
      status: 'warn',
      message: 'Sync not running',
      details: 'Check API service lifecycle.',
    });
  }

  if (!cli.available) {
    checks.push({
      id: 'openclaw-cli',
      name: 'OpenClaw CLI',
      status: 'error',
      message: 'openclaw command not found in PATH',
      details: 'Install the OpenClaw CLI to enable config management and command execution.',
    });
  } else {
    checks.push({
      id: 'openclaw-cli',
      name: 'OpenClaw CLI',
      status: 'ok',
      message: `openclaw ${cli.version ?? 'unknown'}`,
      details: undefined,
    });
  }

  const ok = checks.every((check) => check.status === 'ok');
  return {
    ok,
    target: path.resolve(targetPath),
    checks,
    syncStatus,
    cliAvailable: cli.available,
    cliVersion: cli.version,
  };
}

const OPENCLAW_CHANNEL_DEFS: ReadonlyArray<{ readonly id: string; readonly name: string }> = [
  { id: 'whatsapp', name: 'WhatsApp' },
  { id: 'telegram', name: 'Telegram' },
  { id: 'slack', name: 'Slack' },
  { id: 'discord', name: 'Discord' },
  { id: 'signal', name: 'Signal' },
  { id: 'imessage', name: 'iMessage' },
  { id: 'teams', name: 'Teams' },
];

function toBoolean(value: unknown): boolean {
  return value === true;
}

function toStringOrUndefined(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toNumberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function isChannelConfigured(config: Readonly<Record<string, unknown>>): boolean {
  const keys = Object.keys(config);
  if (keys.length === 0) return false;
  if (toBoolean(config.enabled) || toBoolean(config.configured)) return true;
  return keys.some(
    (key) => !key.toLowerCase().includes('secret') && !key.toLowerCase().includes('token')
  );
}

function parseDmPolicy(
  config: Readonly<Record<string, unknown>>
): 'pairing' | 'allowlist' | 'open' | 'disabled' | 'unknown' {
  const dmPolicy = config.dmPolicy;
  if (
    dmPolicy === 'pairing' ||
    dmPolicy === 'allowlist' ||
    dmPolicy === 'open' ||
    dmPolicy === 'disabled'
  ) {
    return dmPolicy;
  }
  const dm = toReadonlyRecord(config.dm);
  const dmPolicyAlias = dm?.policy;
  if (
    dmPolicyAlias === 'pairing' ||
    dmPolicyAlias === 'allowlist' ||
    dmPolicyAlias === 'open' ||
    dmPolicyAlias === 'disabled'
  ) {
    return dmPolicyAlias;
  }
  return 'unknown';
}

function parseGroupPolicy(
  config: Readonly<Record<string, unknown>>
): 'open' | 'allowlist' | 'disabled' | 'unknown' {
  const groupPolicy = config.groupPolicy;
  if (groupPolicy === 'open' || groupPolicy === 'allowlist' || groupPolicy === 'disabled') {
    return groupPolicy;
  }
  return 'unknown';
}

function parseAllowFrom(config: Readonly<Record<string, unknown>>): string[] {
  const allowFromRaw = config.allowFrom;
  if (!Array.isArray(allowFromRaw)) {
    const dm = toReadonlyRecord(config.dm);
    const dmAllowFromRaw = dm?.allowFrom;
    if (!Array.isArray(dmAllowFromRaw)) {
      return [];
    }
    return dmAllowFromRaw.map((value) => String(value).trim()).filter((value) => value.length > 0);
  }
  return allowFromRaw.map((value) => String(value).trim()).filter((value) => value.length > 0);
}

function parseRuntimeState(
  config: Readonly<Record<string, unknown>>
): 'connected' | 'disconnected' | 'unknown' {
  if (config.connected === true) return 'connected';
  if (config.connected === false) return 'disconnected';
  if (config.status === 'connected') return 'connected';
  if (config.status === 'disconnected') return 'disconnected';
  if (config.running === false) return 'disconnected';
  return 'unknown';
}

function hasGroupsConfigured(config: Readonly<Record<string, unknown>>): boolean {
  if (toBoolean(config.hasGroups) || toBoolean(config.groupsEnabled)) {
    return true;
  }
  const groups = config.groups;
  if (isRecord(groups) && Object.keys(groups).length > 0) {
    return true;
  }
  return false;
}

function resolveOpenClawConfigCandidates(openclawHome: string): readonly string[] {
  const base = path.resolve(openclawHome);
  return [path.join(base, 'openclaw.json'), path.join(base, 'config', 'openclaw.json')];
}

function readOpenClawChannels(openclawHome: string): {
  configPath?: string;
  configStatus: 'found' | 'missing' | 'empty' | 'invalid';
  configCandidates: readonly string[];
  channels: readonly OpenClawChannelSummary[];
} {
  const configCandidates = resolveOpenClawConfigCandidates(openclawHome);
  const configPath = configCandidates.find((candidate) => exists(candidate));
  if (!configPath) {
    return {
      configStatus: 'missing',
      configCandidates,
      channels: OPENCLAW_CHANNEL_DEFS.map((channel) => ({
        id: channel.id,
        name: channel.name,
        configured: false,
        dmPolicy: 'unknown',
        groupPolicy: 'unknown',
        allowFrom: [],
        allowFromCount: 0,
        allowFromHasWildcard: false,
        hasGroups: false,
        connected: false,
        runtimeState: 'unknown',
        accountSummary: {
          total: 0,
          enabled: 0,
          configured: 0,
          connected: 0,
          runtimeKnown: 0,
        },
        boundAgents: [],
      })),
    };
  }

  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    if (raw.trim().length === 0) {
      return {
        configPath,
        configStatus: 'empty',
        configCandidates,
        channels: OPENCLAW_CHANNEL_DEFS.map((channel) => ({
          id: channel.id,
          name: channel.name,
          configured: false,
          dmPolicy: 'unknown',
          groupPolicy: 'unknown',
          allowFrom: [],
          allowFromCount: 0,
          allowFromHasWildcard: false,
          hasGroups: false,
          connected: false,
          runtimeState: 'unknown',
          accountSummary: {
            total: 0,
            enabled: 0,
            configured: 0,
            connected: 0,
            runtimeKnown: 0,
          },
          boundAgents: [],
        })),
      };
    }
    const parsed = JSON.parse(raw);
    const parsedRecord = toReadonlyRecord(parsed) ?? {};
    const channelsRecord = toReadonlyRecord(parsedRecord.channels) ?? {};
    const sessionsRecord = toReadonlyRecord(parsedRecord.sessions) ?? {};

    const channels = OPENCLAW_CHANNEL_DEFS.map((channel): OpenClawChannelSummary => {
      const channelConfig = toReadonlyRecord(channelsRecord[channel.id]) ?? {};
      const sessionStats = toReadonlyRecord(sessionsRecord[channel.id]) ?? {};
      const channelAllowFrom = parseAllowFrom(channelConfig);
      const accountConfigs = toReadonlyRecord(channelConfig.accounts) ?? {};
      const accountEntries = Object.values(accountConfigs)
        .map((value) => toReadonlyRecord(value))
        .filter((value): value is Readonly<Record<string, unknown>> => value !== null);

      let accountEnabled = 0;
      let accountConfigured = 0;
      let accountConnected = 0;
      let accountRuntimeKnown = 0;
      const allowFromSet = new Set(channelAllowFrom);
      for (const accountConfig of accountEntries) {
        if (accountConfig.enabled !== false) {
          accountEnabled += 1;
        }
        if (isChannelConfigured(accountConfig)) {
          accountConfigured += 1;
        }
        const runtimeState = parseRuntimeState(accountConfig);
        if (runtimeState !== 'unknown') {
          accountRuntimeKnown += 1;
        }
        if (runtimeState === 'connected') {
          accountConnected += 1;
        }
        for (const entry of parseAllowFrom(accountConfig)) {
          allowFromSet.add(entry);
        }
      }

      const resolvedAllowFrom = [...allowFromSet];
      const channelRuntimeState = parseRuntimeState(channelConfig);
      const connected =
        channelRuntimeState === 'connected' ||
        (channelRuntimeState === 'unknown' && accountConnected > 0);
      const lastMessageAt = toStringOrUndefined(sessionStats.lastMessageAt);
      const messageCount = toNumberOrUndefined(sessionStats.messageCount);

      const boundAgents: OpenClawChannelBoundAgent[] = [];
      const agentsList = channelConfig.agents ?? channelConfig.bindings;
      if (Array.isArray(agentsList)) {
        for (const entry of agentsList) {
          if (typeof entry === 'string') {
            boundAgents.push({ agentId: entry });
          } else if (isRecord(entry)) {
            const aid =
              typeof entry.agentId === 'string'
                ? entry.agentId
                : typeof entry.id === 'string'
                  ? entry.id
                  : '';
            if (aid) {
              boundAgents.push({
                agentId: aid,
                ...(typeof entry.model === 'string' ? { modelOverride: entry.model } : {}),
              });
            }
          }
        }
      }

      return {
        id: channel.id,
        name: channel.name,
        configured: isChannelConfigured(channelConfig),
        dmPolicy: parseDmPolicy(channelConfig),
        groupPolicy: parseGroupPolicy(channelConfig),
        allowFrom: resolvedAllowFrom,
        allowFromCount: resolvedAllowFrom.length,
        allowFromHasWildcard: resolvedAllowFrom.some((value) => value === '*'),
        hasGroups: hasGroupsConfigured(channelConfig),
        connected,
        runtimeState: channelRuntimeState,
        accountSummary: {
          total: accountEntries.length,
          enabled: accountEnabled,
          configured: accountConfigured,
          connected: accountConnected,
          runtimeKnown: accountRuntimeKnown,
        },
        boundAgents,
        ...(lastMessageAt ? { lastMessageAt } : {}),
        ...(messageCount !== undefined ? { messageCount } : {}),
      };
    });

    return { configPath, configStatus: 'found', configCandidates, channels };
  } catch {
    return {
      configPath,
      configStatus: 'invalid',
      configCandidates,
      channels: OPENCLAW_CHANNEL_DEFS.map((channel) => ({
        id: channel.id,
        name: channel.name,
        configured: false,
        dmPolicy: 'unknown',
        groupPolicy: 'unknown',
        allowFrom: [],
        allowFromCount: 0,
        allowFromHasWildcard: false,
        hasGroups: false,
        connected: false,
        runtimeState: 'unknown',
        accountSummary: {
          total: 0,
          enabled: 0,
          configured: 0,
          connected: 0,
          runtimeKnown: 0,
        },
        boundAgents: [],
      })),
    };
  }
}

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
  const errorMessage = error instanceof Error ? error.message : String(error);
  void reply.code(statusCode).send({
    error: statusCode >= 500 ? 'internal_server_error' : 'request_error',
    message: statusCode >= 500 ? 'An unexpected error occurred.' : errorMessage,
  });
});

// ── Auth Settings API ────────────────────────────────────────────────

app.get('/settings/auth', (request, reply) => {
  if (!isAuthorized(request)) {
    void reply.code(401).send({ error: 'unauthorized' });
    return;
  }
  void reply.send({
    mode: authConfig.mode,
    hasToken: authHasToken(),
  });
});

app.post('/settings/auth', async (request, reply) => {
  if (!isAuthorized(request)) {
    void reply.code(401).send({ error: 'unauthorized' });
    return;
  }

  const body = request.body as Record<string, unknown> | null;
  if (!body || typeof body !== 'object') {
    void reply.code(400).send({ error: 'invalid_body' });
    return;
  }

  const mode = body.mode;
  if (mode !== 'none' && mode !== 'token') {
    void reply.code(400).send({ error: 'invalid_mode', message: 'mode must be "none" or "token"' });
    return;
  }

  if (mode === 'token') {
    const token = body.token;
    if (typeof token !== 'string' || token.trim().length < 16) {
      void reply
        .code(400)
        .send({ error: 'token_too_short', message: 'Token must be at least 16 characters.' });
      return;
    }
    const settings: PersistedAuthSettings = { mode: 'token', token: token.trim() };
    savePersistedAuth(settings);
    authConfig = { mode: 'token', token: token.trim() };
    app.log.info('Auth mode updated to "token" (persisted).');
  } else {
    const confirm = body.confirm;
    if (confirm !== 'DISABLE_AUTH') {
      void reply.code(400).send({
        error: 'confirmation_required',
        message: 'Set confirm: "DISABLE_AUTH" to disable authentication.',
      });
      return;
    }
    const settings: PersistedAuthSettings = { mode: 'none' };
    savePersistedAuth(settings);
    authConfig = { mode: 'none' };
    app.log.warn('Auth mode disabled via API (persisted).');
  }

  void reply.send({
    mode: authConfig.mode,
    hasToken: authHasToken(),
  });
});

app.setNotFoundHandler((_request, reply) => {
  void reply.code(404).send({ error: 'not_found', message: 'Route not found.' });
});

const port = Number(process.env.PORT ?? '9700');
const host = process.env.HOST ?? '127.0.0.1';

const installScriptPath = path.join(
  path.dirname(new URL(import.meta.url).pathname),
  '..',
  '..',
  '..',
  'scripts',
  'install-bridge.sh'
);
const bridgeSetupManager = new BridgeSetupManager({
  localPort: port,
  installScriptPath,
});
const sftpSessionManager = new SftpSessionManager(bridgeSetupManager);
await app.register(multipart, { limits: { fileSize: 100 * 1024 * 1024 } });

if (authConfig.mode === 'none') {
  app.log.warn('Auth mode is "none" — all endpoints are publicly accessible.');
}

// ── Scheduled Tasks (Cron) ──────────────────────────────────────────

const cronStoreDir =
  process.env.CRON_STORE_DIR ?? path.join(os.homedir(), '.patze-control', 'cron');
const taskExecutor = createTaskExecutor({ orchestrator, telemetryAggregator, app });

const taskEventListeners = new Set<(event: TaskEvent) => void>();
const openclawSyncStatusListeners = new Set<(status: OpenClawSyncStatus) => void>();

type GenericSseEvent = { kind: string; payload: Readonly<unknown> };
const genericSseListeners = new Set<(event: GenericSseEvent) => void>();

function broadcastSse(event: GenericSseEvent): void {
  for (const listener of genericSseListeners) {
    try {
      listener(event);
    } catch {
      /* ok */
    }
  }
}

const cronService = new CronService({
  storeDir: cronStoreDir,
  executor: taskExecutor,
  onTaskEvent: (event) => {
    for (const listener of taskEventListeners) {
      try {
        listener(event);
      } catch {
        /* ok */
      }
    }
  },
});

void cronService.start();

// ── OpenClaw Multi-Target Sync ──────────────────────────────────────

const openclawDir =
  process.env.OPENCLAW_HOME ??
  process.env.CLAWPAL_OPENCLAW_DIR ??
  path.join(os.homedir(), '.openclaw');

const openclawTargetStore = new OpenClawTargetStore(cronStoreDir);

if (openclawTargetStore.list().length === 0) {
  openclawTargetStore.add({
    label: 'Local',
    type: 'local',
    openclawDir,
    pollIntervalMs: 30_000,
    enabled: true,
  });
  app.log.info({ dir: openclawDir }, 'Auto-created default local OpenClaw target');
}

const openclawSyncManager = new OpenClawSyncManager(openclawTargetStore, {
  onStatus: (targetId, status) => {
    for (const listener of openclawSyncStatusListeners) {
      try {
        listener(status);
      } catch {
        /* ok */
      }
    }
    for (const listener of targetStatusListeners) {
      try {
        listener(targetId, status);
      } catch {
        /* ok */
      }
    }
  },
});
const targetStatusListeners = new Set<(targetId: string, status: OpenClawSyncStatus) => void>();

openclawSyncManager.startAll();
app.log.info({ targets: openclawTargetStore.list().length }, 'OpenClaw sync manager started');

const commandQueue = new OpenClawCommandQueue(cronStoreDir);

const openclawSync = (() => {
  const defaultTarget = openclawTargetStore.list()[0];
  if (!defaultTarget) return null;
  return {
    getStatus: () =>
      openclawSyncManager.getStatus(defaultTarget.id) ?? {
        running: false,
        available: false,
        pollIntervalMs: 30_000,
        jobsCount: 0,
        lastAttemptAt: undefined,
        lastSuccessfulSyncAt: undefined,
        consecutiveFailures: 0,
        lastError: undefined,
        stale: false,
      },
    getJobs: () => openclawSyncManager.getJobs(defaultTarget.id),
    getRunHistory: (jobId: string, limit?: number) =>
      openclawSyncManager.getRunHistory(defaultTarget.id, jobId, limit),
    createMergedView: (tasks: readonly ScheduledTask[]) =>
      openclawSyncManager.createMergedView(defaultTarget.id, tasks),
    get available() {
      return this.getStatus().available;
    },
    stop: () => openclawSyncManager.stopTarget(defaultTarget.id),
  };
})();

const bridgeCronProxyRootDir = path.join(cronStoreDir, 'remote-openclaw');

function parseOpenClawRunRecord(value: unknown): OpenClawRunRecord | null {
  const record = toReadonlyRecord(value);
  if (!record) {
    return null;
  }
  if (typeof record.jobId !== 'string' || record.jobId.length === 0) {
    return null;
  }
  if (typeof record.runId !== 'string' || record.runId.length === 0) {
    return null;
  }
  if (typeof record.startedAt !== 'string' || record.startedAt.length === 0) {
    return null;
  }
  const status = record.status;
  if (status !== 'ok' && status !== 'error' && status !== 'timeout' && status !== 'running') {
    return null;
  }
  return {
    jobId: record.jobId,
    runId: record.runId,
    startedAt: record.startedAt,
    endedAt: typeof record.endedAt === 'string' ? record.endedAt : undefined,
    status,
    error: typeof record.error === 'string' ? record.error : undefined,
    durationMs: typeof record.durationMs === 'number' ? record.durationMs : undefined,
    sessionId: typeof record.sessionId === 'string' ? record.sessionId : undefined,
  };
}

function parseBridgeCronSyncPayload(body: unknown): BridgeCronSyncPayload | null {
  const record = toReadonlyRecord(body);
  if (!record) {
    return null;
  }
  if (typeof record.machineId !== 'string' || record.machineId.length === 0) {
    return null;
  }
  if (typeof record.jobsHash !== 'string' || record.jobsHash.length === 0) {
    return null;
  }
  if (!isRecord(record.newRuns)) {
    return null;
  }

  let jobs: readonly OpenClawCronJob[] | undefined;
  if (record.jobs !== undefined) {
    if (!Array.isArray(record.jobs)) {
      return null;
    }
    jobs = record.jobs as readonly OpenClawCronJob[];
  }

  const newRuns: Record<string, readonly OpenClawRunRecord[]> = {};
  for (const [jobId, value] of Object.entries(record.newRuns)) {
    if (!Array.isArray(value)) {
      return null;
    }
    const runs: OpenClawRunRecord[] = [];
    for (const candidate of value) {
      const parsed = parseOpenClawRunRecord(candidate);
      if (parsed) {
        runs.push(parsed);
      }
    }
    newRuns[jobId] = runs;
  }

  return {
    machineId: record.machineId,
    machineLabel: typeof record.machineLabel === 'string' ? record.machineLabel : undefined,
    bridgeVersion: typeof record.bridgeVersion === 'string' ? record.bridgeVersion : undefined,
    jobsHash: record.jobsHash,
    jobs,
    newRuns,
    sentAt: typeof record.sentAt === 'string' ? record.sentAt : undefined,
  };
}

function hasRunDelta(newRuns: Readonly<Record<string, readonly OpenClawRunRecord[]>>): boolean {
  return Object.values(newRuns).some((runs) => runs.length > 0);
}

function ensureBridgeProxyTarget(machineId: string, machineLabel?: string): OpenClawTarget {
  const safeMachineId = sanitizePathSegment(machineId);
  const targetOpenClawDir = path.join(bridgeCronProxyRootDir, safeMachineId);
  const existing = openclawTargetStore
    .list()
    .find((target) => target.type === 'remote' && target.openclawDir === targetOpenClawDir);
  if (existing) {
    if (existing.enabled && !openclawSyncManager.isRunning(existing.id)) {
      openclawSyncManager.startTarget(existing);
    }
    return existing;
  }

  const created = openclawTargetStore.add({
    label:
      machineLabel && machineLabel.length > 0 ? `Bridge ${machineLabel}` : `Bridge ${machineId}`,
    type: 'remote',
    openclawDir: targetOpenClawDir,
    pollIntervalMs: 30_000,
    enabled: true,
  });
  openclawSyncManager.startTarget(created);
  app.log.info({ machineId, targetId: created.id }, 'Auto-created bridge OpenClaw target');
  return created;
}

function appendBridgeRuns(
  openclawDirPath: string,
  newRuns: Readonly<Record<string, readonly OpenClawRunRecord[]>>
): void {
  const runsDir = path.join(openclawDirPath, 'cron', 'runs');
  if (!fs.existsSync(runsDir)) {
    fs.mkdirSync(runsDir, { recursive: true });
  }

  for (const [jobId, runs] of Object.entries(newRuns)) {
    if (runs.length === 0) {
      continue;
    }
    const fileName = `${sanitizeRunFilename(jobId)}.jsonl`;
    const filePath = path.join(runsDir, fileName);
    const content = runs.map((run) => JSON.stringify(run)).join('\n');
    fs.appendFileSync(filePath, `${content}\n`, 'utf-8');
  }
}

function writeBridgeJobsFile(openclawDirPath: string, jobs: readonly OpenClawCronJob[]): void {
  const cronDir = path.join(openclawDirPath, 'cron');
  if (!fs.existsSync(cronDir)) {
    fs.mkdirSync(cronDir, { recursive: true });
  }
  const jobsPath = path.join(cronDir, 'jobs.json');
  const tmpPath = `${jobsPath}.tmp`;
  fs.writeFileSync(tmpPath, JSON.stringify({ version: 1, jobs }, null, 2), 'utf-8');
  fs.renameSync(tmpPath, jobsPath);
}

app.get('/tasks', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  return reply.code(200).send(cronService.list());
});

app.post('/tasks', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_body' });
  }
  const body = request.body;
  if (typeof body.name !== 'string' || body.name.length === 0) {
    return reply.code(400).send({ error: 'name is required' });
  }
  if (!isRecord(body.schedule) || typeof body.schedule.kind !== 'string') {
    return reply.code(400).send({ error: 'schedule with kind is required' });
  }
  if (!isRecord(body.action) || typeof body.action.action !== 'string') {
    return reply.code(400).send({ error: 'action with action field is required' });
  }
  const validKinds = ['at', 'every', 'cron'];
  if (!validKinds.includes(body.schedule.kind)) {
    return reply
      .code(400)
      .send({ error: `schedule.kind must be one of: ${validKinds.join(', ')}` });
  }
  try {
    const input = body as unknown as TaskCreateInput;
    const task = await cronService.add(input);
    return reply.code(201).send(task);
  } catch (err) {
    return reply.code(400).send({ error: err instanceof Error ? err.message : 'invalid_input' });
  }
});

app.patch(
  '/tasks/:taskId',
  async (request: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!isRecord(request.body)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const patch = request.body as unknown as TaskPatchInput;
    const result = await cronService.update(request.params.taskId, patch);
    if (!result) {
      return reply.code(404).send({ error: 'task_not_found' });
    }
    return reply.code(200).send(result);
  }
);

app.delete(
  '/tasks/:taskId',
  async (request: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const removed = await cronService.remove(request.params.taskId);
    if (!removed) {
      return reply.code(404).send({ error: 'task_not_found' });
    }
    return reply.code(200).send({ ok: true });
  }
);

app.post(
  '/tasks/:taskId/run',
  async (request: FastifyRequest<{ Params: { taskId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    try {
      const record = await cronService.runNow(request.params.taskId);
      return reply.code(200).send(record);
    } catch (err) {
      return reply.code(404).send({ error: err instanceof Error ? err.message : 'run_failed' });
    }
  }
);

app.get(
  '/tasks/history',
  async (request: FastifyRequest<{ Querystring: { taskId?: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const taskId = (request.query as Record<string, string | undefined>).taskId;
    return reply.code(200).send(cronService.getRunHistory(taskId));
  }
);

// ── Task Snapshots ──────────────────────────────────────────────────

app.get('/tasks/snapshots', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const query = request.query as Record<string, string | undefined>;
  const limit = parsePositiveInt(query.limit, 20, 200);
  const offset = parsePositiveInt(query.offset, 0, 10_000);
  return reply.code(200).send(cronService.listSnapshots(limit, offset));
});

app.post(
  '/tasks/rollback/:snapshotId',
  async (request: FastifyRequest<{ Params: { snapshotId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const result = await cronService.rollback(request.params.snapshotId);
    if (!result) {
      return reply.code(404).send({ error: 'snapshot_not_found' });
    }
    return reply.code(200).send({ ok: true, tasks: result });
  }
);

// ── Task SSE Stream ─────────────────────────────────────────────────

app.get('/tasks/events', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  reply.hijack();
  const response = reply.raw;
  const origin = request.headers.origin;
  if (origin && ALLOWED_ORIGINS.some((pattern) => pattern.test(origin))) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  response.flushHeaders();

  const sse = createSseWriter(response);
  sse.enqueue(writeSseCommentChunk('task-stream-connected'));

  const listener = (event: TaskEvent): void => {
    const chunk = writeSseNamedEventChunk('task', event);
    sse.enqueue(chunk);
  };
  taskEventListeners.add(listener);

  const syncListener = (status: OpenClawSyncStatus): void => {
    const chunk = writeSseNamedEventChunk('openclaw-sync', status);
    sse.enqueue(chunk);
  };
  openclawSyncStatusListeners.add(syncListener);

  const genericListener = (event: GenericSseEvent): void => {
    const chunk = writeSseNamedEventChunk(event.kind, event.payload);
    sse.enqueue(chunk);
  };
  genericSseListeners.add(genericListener);

  const heartbeat = setInterval(() => {
    sse.enqueue(writeSseCommentChunk('heartbeat'));
  }, SSE_HEARTBEAT_MS);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    taskEventListeners.delete(listener);
    openclawSyncStatusListeners.delete(syncListener);
    genericSseListeners.delete(genericListener);
    sse.close();
    if (!response.writableEnded && !response.destroyed) {
      response.end();
    }
    request.raw.off('close', cleanup);
    response.off('close', cleanup);
    response.off('error', cleanup);
  };

  request.raw.on('close', cleanup);
  response.on('close', cleanup);
  response.on('error', cleanup);
});

// ── OpenClaw Target CRUD Routes ─────────────────────────────────────

app.get('/openclaw/targets', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  return reply.code(200).send({
    targets: openclawSyncManager.getAllStatuses(),
  });
});

app.get(
  '/openclaw/channels',
  async (request: FastifyRequest<{ Querystring: { targetId?: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }

    const targetId = request.query.targetId;
    let resolvedTargetId: string | undefined;
    let targetOpenClawDir = openclawDir;

    if (targetId) {
      const target = openclawTargetStore.get(targetId);
      if (!target) {
        return reply.code(404).send({ error: 'target_not_found' });
      }
      resolvedTargetId = target.id;
      targetOpenClawDir = target.openclawDir;
    }

    const safeOpenClawDir = path.resolve(
      targetOpenClawDir.startsWith('~')
        ? targetOpenClawDir.replace('~', os.homedir())
        : targetOpenClawDir
    );
    const channelData = readOpenClawChannels(safeOpenClawDir);

    return reply.code(200).send({
      targetId: resolvedTargetId,
      ...(channelData.configPath ? { configPath: channelData.configPath } : {}),
      configStatus: channelData.configStatus,
      configCandidates: channelData.configCandidates,
      channels: channelData.channels,
    });
  }
);

app.post('/openclaw/targets', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_body' });
  }
  const body = request.body;
  if (typeof body.label !== 'string' || body.label.length === 0) {
    return reply.code(400).send({ error: 'label is required' });
  }
  if (typeof body.openclawDir !== 'string' || body.openclawDir.length === 0) {
    return reply.code(400).send({ error: 'openclawDir is required' });
  }
  const resolvedDir = path.resolve(
    body.openclawDir.startsWith('~')
      ? body.openclawDir.replace(/^~/, os.homedir())
      : body.openclawDir
  );
  if (!isOpenClawDirSafe(resolvedDir)) {
    return reply.code(400).send({
      error: 'invalid_openclaw_dir',
      message: 'Directory is not allowed for security reasons.',
    });
  }
  const input: OpenClawTargetInput = {
    label: body.label,
    type: body.type === 'remote' ? 'remote' : 'local',
    openclawDir: body.openclawDir,
    pollIntervalMs: typeof body.pollIntervalMs === 'number' ? body.pollIntervalMs : 30_000,
    enabled: body.enabled !== false,
  };
  const target = openclawTargetStore.add(input);
  if (target.enabled) {
    openclawSyncManager.startTarget(target);
  }
  app.log.info({ targetId: target.id, label: target.label }, 'OpenClaw target added');
  return reply.code(201).send(target);
});

app.patch(
  '/openclaw/targets/:targetId',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    if (!isRecord(request.body)) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const patch = request.body as unknown as OpenClawTargetPatch;
    if (typeof patch.openclawDir === 'string') {
      const resolvedDir = path.resolve(
        patch.openclawDir.startsWith('~')
          ? patch.openclawDir.replace(/^~/, os.homedir())
          : patch.openclawDir
      );
      if (!isOpenClawDirSafe(resolvedDir)) {
        return reply.code(400).send({
          error: 'invalid_openclaw_dir',
          message: 'Directory is not allowed for security reasons.',
        });
      }
    }
    const updated = openclawTargetStore.update(request.params.targetId, patch);
    if (!updated) {
      return reply.code(404).send({ error: 'target_not_found' });
    }
    openclawSyncManager.restartTarget(updated);
    return reply.code(200).send(updated);
  }
);

app.delete(
  '/openclaw/targets/:targetId',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    openclawSyncManager.stopTarget(request.params.targetId);
    const removed = openclawTargetStore.remove(request.params.targetId);
    if (!removed) {
      return reply.code(404).send({ error: 'target_not_found' });
    }
    app.log.info({ targetId: request.params.targetId }, 'OpenClaw target removed');
    return reply.code(200).send({ ok: true });
  }
);

// ── OpenClaw Per-Target Routes ──────────────────────────────────────

app.get(
  '/openclaw/targets/:targetId/jobs',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const status = openclawSyncManager.getStatus(request.params.targetId);
    if (!status) {
      return reply.code(404).send({ error: 'target_not_found' });
    }
    const jobs = status.available ? openclawSyncManager.getJobs(request.params.targetId) : [];
    return reply.code(200).send({ available: status.available, jobs, syncStatus: status });
  }
);

app.get(
  '/openclaw/targets/:targetId/runs/:jobId',
  async (
    request: FastifyRequest<{ Params: { targetId: string; jobId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const status = openclawSyncManager.getStatus(request.params.targetId);
    if (!status) {
      return reply.code(404).send({ error: 'target_not_found' });
    }
    if (!status.available) {
      return reply.code(200).send({ available: false, runs: [], syncStatus: status });
    }
    const query = request.query as Record<string, string | undefined>;
    const limit = parsePositiveInt(query.limit, 50, 500);
    const runs = openclawSyncManager.getRunHistory(
      request.params.targetId,
      request.params.jobId,
      limit
    );
    return reply.code(200).send({ available: true, runs, syncStatus: status });
  }
);

app.get(
  '/openclaw/targets/:targetId/health',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) {
      return reply.code(404).send({ error: 'target_not_found' });
    }
    const status = openclawSyncManager.getStatus(target.id) ?? {
      running: false,
      available: false,
      pollIntervalMs: target.pollIntervalMs,
      jobsCount: 0,
      lastAttemptAt: undefined,
      lastSuccessfulSyncAt: undefined,
      consecutiveFailures: 0,
      lastError: undefined,
      stale: false,
    };
    return reply.code(200).send(await buildOpenClawHealth(target.openclawDir, status));
  }
);

// ── OpenClaw Legacy Routes (backward compatible, default target) ────

app.get('/openclaw/cron/jobs', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const status = openclawSync?.getStatus() ?? {
    running: false,
    available: false,
    pollIntervalMs: 30_000,
    jobsCount: 0,
    lastAttemptAt: undefined,
    lastSuccessfulSyncAt: undefined,
    consecutiveFailures: 0,
    lastError: undefined,
    stale: false,
  };
  const jobs = status.available && openclawSync ? openclawSync.getJobs() : [];
  return reply.code(200).send({ available: status.available, jobs, syncStatus: status });
});

app.get('/openclaw/health', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const status = openclawSync?.getStatus() ?? {
    running: false,
    available: false,
    pollIntervalMs: 30_000,
    jobsCount: 0,
    lastAttemptAt: undefined,
    lastSuccessfulSyncAt: undefined,
    consecutiveFailures: 0,
    lastError: undefined,
    stale: false,
  };
  return reply.code(200).send(await buildOpenClawHealth(openclawDir, status));
});

app.get(
  '/openclaw/cron/runs/:jobId',
  async (request: FastifyRequest<{ Params: { jobId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const status = openclawSync?.getStatus() ?? {
      running: false,
      available: false,
      pollIntervalMs: 30_000,
      jobsCount: 0,
      lastAttemptAt: undefined,
      lastSuccessfulSyncAt: undefined,
      consecutiveFailures: 0,
      lastError: undefined,
      stale: false,
    };
    if (!status.available || !openclawSync) {
      return reply.code(200).send({ available: false, runs: [], syncStatus: status });
    }
    const query = request.query as Record<string, string | undefined>;
    const limit = parsePositiveInt(query.limit, 50, 500);
    const runs = openclawSync.getRunHistory(request.params.jobId, limit);
    return reply.code(200).send({ available: true, runs, syncStatus: status });
  }
);

app.get('/openclaw/cron/merged', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  const view = openclawSync?.createMergedView(cronService.list());
  const syncStatus = openclawSync?.getStatus() ?? {
    running: false,
    available: false,
    pollIntervalMs: 30_000,
    jobsCount: 0,
    lastAttemptAt: undefined,
    lastSuccessfulSyncAt: undefined,
    consecutiveFailures: 0,
    lastError: undefined,
    stale: false,
  };
  return reply.code(200).send({
    ...(view ?? { patzeTasks: cronService.list(), openclawJobs: [], timestamp: Date.now() }),
    syncStatus,
  });
});

// ── Workspace Browser ───────────────────────────────────────────────

const WORKSPACE_ROOTS: readonly string[] = [openclawDir, path.join(os.homedir(), '.patze-control')];

const WORKSPACE_MAX_FILE_SIZE_BYTES = 512 * 1024;
const WORKSPACE_MAX_DEPTH = 10;
const WORKSPACE_HIDDEN_PATTERNS = ['.git', 'node_modules', '__pycache__', '.DS_Store'];
const WORKSPACE_SEARCH_TIMEOUT_MS = 5_000;
const WORKSPACE_SEARCH_DEFAULT_LIMIT = 20;
const WORKSPACE_SEARCH_MAX_LIMIT = 100;
const WORKSPACE_SEARCH_CONTEXT_MAX_CHARS = 200;
const WORKSPACE_SEARCH_CACHE_MAX_ENTRIES = 200;
const MEMORY_FILE_ALLOWLIST: ReadonlySet<string> = new Set([
  'MEMORY.md',
  'SOUL.md',
  'TASKS.md',
  'CHANGELOG.md',
  'CONTEXT.md',
  'README.md',
]);
const WORKSPACE_SEARCH_BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.svg',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.wasm',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.db',
  '.sqlite',
  '.sqlite3',
  '.bin',
  '.exe',
  '.dll',
  '.so',
]);

const workspaceSearchCache = new Map<string, { mtimeMs: number; content: string }>();

function isPathWithinRoots(targetPath: string, roots: readonly string[]): boolean {
  const resolved = path.resolve(targetPath);
  return roots.some((root) => {
    const resolvedRoot = path.resolve(root);
    return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
  });
}

function getWorkspaceRoots(): readonly string[] {
  const roots = new Set<string>();
  for (const root of WORKSPACE_ROOTS) {
    if (exists(root)) {
      roots.add(path.resolve(root));
    }
  }
  for (const target of openclawTargetStore.list()) {
    if (exists(target.openclawDir)) {
      roots.add(path.resolve(target.openclawDir));
    }
  }
  return Array.from(roots);
}

function truncateContext(text: string): string {
  if (text.length <= WORKSPACE_SEARCH_CONTEXT_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, WORKSPACE_SEARCH_CONTEXT_MAX_CHARS)}…`;
}

function readSearchContent(filePath: string, mtimeMs: number): string | null {
  const cached = workspaceSearchCache.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) {
    workspaceSearchCache.delete(filePath);
    workspaceSearchCache.set(filePath, cached);
    return cached.content;
  }
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    workspaceSearchCache.set(filePath, { mtimeMs, content });
    if (workspaceSearchCache.size > WORKSPACE_SEARCH_CACHE_MAX_ENTRIES) {
      const oldest = workspaceSearchCache.keys().next().value;
      if (oldest) {
        workspaceSearchCache.delete(oldest);
      }
    }
    return content;
  } catch {
    return null;
  }
}

interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt?: string;
}

function listDirectory(dirPath: string, depth: number): readonly WorkspaceEntry[] {
  if (depth > WORKSPACE_MAX_DEPTH) return [];
  try {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    return entries
      .filter((e) => !WORKSPACE_HIDDEN_PATTERNS.includes(e.name))
      .map((entry): WorkspaceEntry | null => {
        const fullPath = path.join(dirPath, entry.name);
        try {
          if (entry.isDirectory()) {
            return { name: entry.name, path: fullPath, type: 'directory' };
          }
          if (entry.isFile()) {
            const stat = fs.statSync(fullPath);
            return {
              name: entry.name,
              path: fullPath,
              type: 'file',
              size: stat.size,
              modifiedAt: stat.mtime.toISOString(),
            };
          }
          return null;
        } catch {
          return null;
        }
      })
      .filter((e): e is WorkspaceEntry => e !== null)
      .sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
  } catch {
    return [];
  }
}

app.get('/workspace/roots', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const roots: Array<{
    path: string;
    label: string;
    type: 'openclaw' | 'config';
    targetId?: string;
    targetType?: string;
  }> = [];

  const targets = openclawTargetStore.list();
  for (const target of targets) {
    if (target.type === 'local' && exists(target.openclawDir)) {
      roots.push({
        path: target.openclawDir,
        label: `OpenClaw \u2014 ${target.label}`,
        type: 'openclaw',
        targetId: target.id,
        targetType: target.type,
      });
    } else if (target.type === 'remote') {
      roots.push({
        path: target.openclawDir,
        label: `OpenClaw \u2014 ${target.label} (remote)`,
        type: 'openclaw',
        targetId: target.id,
        targetType: target.type,
      });
    }
  }

  const patzeDir = path.join(os.homedir(), '.patze-control');
  if (exists(patzeDir)) {
    roots.push({ path: patzeDir, label: 'Patze Control', type: 'config' });
  }

  const seenPaths = new Set(roots.map((r) => path.resolve(r.path)));
  for (const wp of WORKSPACE_ROOTS) {
    if (!seenPaths.has(path.resolve(wp)) && exists(wp)) {
      roots.push({ path: wp, label: path.basename(wp), type: 'config' });
    }
  }

  return reply.code(200).send({ roots });
});

app.get(
  '/workspace/tree',
  async (request: FastifyRequest<{ Querystring: { path?: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const dirPath = (request.query as Record<string, string | undefined>).path;
    if (!dirPath) {
      return reply.code(400).send({ error: 'path query parameter is required' });
    }
    const resolved = path.resolve(dirPath);
    const workspaceRoots = getWorkspaceRoots();
    if (!isPathWithinRoots(resolved, workspaceRoots)) {
      return reply.code(403).send({ error: 'path_outside_workspace' });
    }
    const entries = listDirectory(resolved, 0);
    return reply.code(200).send({ path: resolved, entries });
  }
);

app.get(
  '/workspace/file',
  async (request: FastifyRequest<{ Querystring: { path?: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const filePath = (request.query as Record<string, string | undefined>).path;
    if (!filePath) {
      return reply.code(400).send({ error: 'path query parameter is required' });
    }
    const resolved = path.resolve(filePath);
    const workspaceRoots = getWorkspaceRoots();
    if (!isPathWithinRoots(resolved, workspaceRoots)) {
      return reply.code(403).send({ error: 'path_outside_workspace' });
    }
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isFile()) {
        return reply.code(400).send({ error: 'not_a_file' });
      }
      if (stat.size > WORKSPACE_MAX_FILE_SIZE_BYTES) {
        return reply.code(413).send({
          error: 'file_too_large',
          message: `File exceeds ${WORKSPACE_MAX_FILE_SIZE_BYTES} bytes limit.`,
        });
      }
      const content = fs.readFileSync(resolved, 'utf-8');
      const ext = path.extname(resolved).slice(1).toLowerCase();
      return reply.code(200).send({
        path: resolved,
        name: path.basename(resolved),
        extension: ext,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        content,
      });
    } catch {
      return reply.code(404).send({ error: 'file_not_found' });
    }
  }
);

app.put('/workspace/file', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_body' });
  }
  const body = request.body;
  if (typeof body.path !== 'string' || typeof body.content !== 'string') {
    return reply.code(400).send({ error: 'path and content are required' });
  }
  const resolved = path.resolve(body.path);
  const workspaceRoots = getWorkspaceRoots();
  if (!isPathWithinRoots(resolved, workspaceRoots)) {
    return reply.code(403).send({ error: 'path_outside_workspace' });
  }
  try {
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(resolved, body.content, 'utf-8');
    const stat = fs.statSync(resolved);
    return reply.code(200).send({
      ok: true,
      path: resolved,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  } catch (err) {
    return reply.code(500).send({
      error: 'write_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

app.get('/workspace/memory-files', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const agents: Array<{
    agentId: string;
    targetId: string;
    targetType: 'local' | 'remote';
    targetLabel: string;
    workspacePath: string;
    files: Array<{ name: string; path: string; size: number; modifiedAt: string }>;
  }> = [];

  for (const target of openclawTargetStore.list()) {
    if (!exists(target.openclawDir) || !readableDir(target.openclawDir)) {
      continue;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(target.openclawDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith('workspace')) {
        continue;
      }
      const workspacePath = path.join(target.openclawDir, entry.name);
      const files: Array<{ name: string; path: string; size: number; modifiedAt: string }> = [];
      for (const fileName of MEMORY_FILE_ALLOWLIST) {
        const filePath = path.join(workspacePath, fileName);
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile()) {
            continue;
          }
          files.push({
            name: fileName,
            path: filePath,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          });
        } catch {
          // Skip missing files.
        }
      }
      if (files.length === 0) {
        continue;
      }
      files.sort((a, b) => a.name.localeCompare(b.name));
      agents.push({
        agentId: entry.name,
        targetId: target.id,
        targetType: target.type,
        targetLabel: target.label,
        workspacePath,
        files,
      });
    }
  }

  agents.sort((a, b) => a.agentId.localeCompare(b.agentId));
  return reply.code(200).send({ agents });
});

app.put('/workspace/memory-file', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_body' });
  }
  const body = request.body;
  if (typeof body.path !== 'string' || typeof body.content !== 'string') {
    return reply.code(400).send({ error: 'path and content are required' });
  }
  const resolved = path.resolve(body.path);
  const workspaceRoots = getWorkspaceRoots();
  if (!isPathWithinRoots(resolved, workspaceRoots)) {
    return reply.code(403).send({ error: 'path_outside_workspace' });
  }
  const fileName = path.basename(resolved);
  if (!MEMORY_FILE_ALLOWLIST.has(fileName)) {
    return reply.code(403).send({ error: 'memory_file_not_allowed' });
  }
  try {
    fs.writeFileSync(resolved, body.content, 'utf-8');
    const stat = fs.statSync(resolved);
    return reply.code(200).send({
      ok: true,
      path: resolved,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
    });
  } catch (err) {
    return reply.code(500).send({
      error: 'write_failed',
      message: err instanceof Error ? err.message : 'Unknown error',
    });
  }
});

app.get(
  '/workspace/search',
  async (
    request: FastifyRequest<{ Querystring: { q?: string; maxResults?: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const q = (request.query.q ?? '').trim();
    if (q.length < 3) {
      return reply
        .code(400)
        .send({ error: 'query_too_short', message: 'Minimum query length is 3.' });
    }
    const maxResults = parsePositiveInt(
      request.query.maxResults,
      WORKSPACE_SEARCH_DEFAULT_LIMIT,
      WORKSPACE_SEARCH_MAX_LIMIT
    );
    const queryLower = q.toLowerCase();
    const roots = getWorkspaceRoots().filter(readableDir);
    const deadlineMs = Date.now() + WORKSPACE_SEARCH_TIMEOUT_MS;
    const results: Array<{
      path: string;
      name: string;
      lineNumber: number;
      line: string;
      contextBefore: string;
      contextAfter: string;
    }> = [];
    let timedOut = false;

    const pushFileMatches = (filePath: string): void => {
      let stat: fs.Stats;
      try {
        stat = fs.statSync(filePath);
      } catch {
        return;
      }
      if (!stat.isFile() || stat.size > WORKSPACE_MAX_FILE_SIZE_BYTES) {
        return;
      }
      const ext = path.extname(filePath).toLowerCase();
      if (WORKSPACE_SEARCH_BINARY_EXTENSIONS.has(ext)) {
        return;
      }
      const content = readSearchContent(filePath, stat.mtimeMs);
      if (!content) {
        return;
      }
      if (!content.toLowerCase().includes(queryLower)) {
        return;
      }
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (!lines[i]!.toLowerCase().includes(queryLower)) {
          continue;
        }
        results.push({
          path: filePath,
          name: path.basename(filePath),
          lineNumber: i + 1,
          line: truncateContext(lines[i]!),
          contextBefore: i > 0 ? truncateContext(lines[i - 1]!) : '',
          contextAfter: i + 1 < lines.length ? truncateContext(lines[i + 1]!) : '',
        });
        if (results.length >= maxResults) {
          return;
        }
      }
    };

    for (const root of roots) {
      const queue: string[] = [root];
      while (queue.length > 0 && results.length < maxResults) {
        if (Date.now() > deadlineMs) {
          timedOut = true;
          break;
        }
        const current = queue.shift();
        if (!current) {
          continue;
        }
        let entries: fs.Dirent[];
        try {
          entries = fs.readdirSync(current, { withFileTypes: true });
        } catch {
          continue;
        }
        for (const entry of entries) {
          if (WORKSPACE_HIDDEN_PATTERNS.includes(entry.name)) {
            continue;
          }
          const fullPath = path.join(current, entry.name);
          if (entry.isDirectory()) {
            queue.push(fullPath);
            continue;
          }
          if (entry.isFile()) {
            pushFileMatches(fullPath);
          }
          if (results.length >= maxResults) {
            break;
          }
        }
      }
      if (timedOut || results.length >= maxResults) {
        break;
      }
    }

    return reply.code(200).send({
      query: q,
      maxResults,
      timedOut,
      results,
    });
  }
);

// ── Safe Terminal ───────────────────────────────────────────────────

const TERMINAL_ALLOWED_COMMANDS: ReadonlySet<string> = new Set([
  'uptime',
  'whoami',
  'hostname',
  'date',
  'df',
  'free',
  'uname',
  'ps',
  'top',
  'cat',
  'ls',
  'head',
  'tail',
  'wc',
  'du',
  'openclaw',
  'pm2',
  'systemctl',
  'journalctl',
  'ping',
  'dig',
  'nslookup',
  'ss',
  'ip',
  'git',
]);

const TERMINAL_BLOCKED_COMMANDS: ReadonlySet<string> = new Set([
  'rm',
  'rmdir',
  'mv',
  'cp',
  'chmod',
  'chown',
  'chgrp',
  'kill',
  'killall',
  'pkill',
  'shutdown',
  'reboot',
  'halt',
  'env',
  'export',
  'set',
  'unset',
  'source',
  'curl',
  'wget',
  'nc',
  'ncat',
  'socat',
  'node',
  'python',
  'python3',
  'ruby',
  'perl',
  'php',
  'bash',
  'sh',
  'zsh',
  'fish',
  'csh',
  'su',
  'sudo',
  'passwd',
  'useradd',
  'userdel',
  'apt',
  'yum',
  'dnf',
  'pacman',
  'snap',
  'dd',
  'mkfs',
  'mount',
  'umount',
  'fdisk',
]);

const TERMINAL_MAX_OUTPUT_BYTES = 64 * 1024;
const TERMINAL_TIMEOUT_MS = 15_000;

const SENSITIVE_PATH_PREFIXES: readonly string[] = [
  '/etc/shadow',
  '/etc/passwd',
  '/etc/sudoers',
  '/root/',
  '/proc/self/',
];

const SENSITIVE_PATH_PATTERNS: readonly RegExp[] = [
  /\.ssh\//,
  /\.env/,
  /id_rsa/,
  /id_ed25519/,
  /authorized_keys/,
  /known_hosts/,
  /credentials/,
  /\.pem$/,
  /\.key$/,
  /private.*key/i,
  /secret/i,
  /token/i,
  /auth\.json/,
  /patze-control\/auth/,
];

const FILE_READING_COMMANDS: ReadonlySet<string> = new Set(['cat', 'head', 'tail']);

const SYSTEMCTL_SAFE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'is-active',
  'is-enabled',
  'is-failed',
  'list-units',
  'list-unit-files',
  'show',
]);

const GIT_SAFE_SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'log',
  'diff',
  'branch',
  'remote',
  'show',
  'tag',
  'stash',
  'rev-parse',
  'describe',
  'shortlog',
]);

function parseCommandBase(command: string): string | null {
  const trimmed = command.trim();
  if (trimmed.length === 0) return null;
  const parts = trimmed.split(/\s+/);
  const base = parts[0];
  if (!base) return null;
  if (base.includes('/')) {
    return null;
  }
  return base;
}

function containsSensitivePath(args: string): boolean {
  for (const prefix of SENSITIVE_PATH_PREFIXES) {
    if (args.includes(prefix)) return true;
  }
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(args)) return true;
  }
  return false;
}

function isCommandAllowed(command: string): { ok: true } | { ok: false; reason: string } {
  const base = parseCommandBase(command);
  if (!base) return { ok: false, reason: 'Invalid command (empty or contains path separators)' };
  if (TERMINAL_BLOCKED_COMMANDS.has(base)) {
    return { ok: false, reason: `Command "${base}" is blocked for security` };
  }
  if (!TERMINAL_ALLOWED_COMMANDS.has(base)) {
    return { ok: false, reason: `Command "${base}" is not in the allowlist` };
  }
  if (
    command.includes('|') ||
    command.includes(';') ||
    command.includes('&&') ||
    command.includes('`') ||
    command.includes('$(')
  ) {
    return { ok: false, reason: 'Pipes, chaining, and subshells are not allowed' };
  }

  const argsStr = command.trim().slice(base.length);

  if (FILE_READING_COMMANDS.has(base) && containsSensitivePath(argsStr)) {
    return { ok: false, reason: `Reading sensitive files is not allowed` };
  }

  if (base === 'systemctl') {
    const parts = command.trim().split(/\s+/);
    const sub = parts[1];
    if (!sub || !SYSTEMCTL_SAFE_SUBCOMMANDS.has(sub)) {
      return { ok: false, reason: `systemctl subcommand "${sub ?? ''}" is not allowed` };
    }
  }

  if (base === 'git') {
    const parts = command.trim().split(/\s+/);
    const sub = parts[1];
    if (!sub || !GIT_SAFE_SUBCOMMANDS.has(sub)) {
      return {
        ok: false,
        reason: `git subcommand "${sub ?? ''}" is not allowed (read-only ops only)`,
      };
    }
  }

  return { ok: true };
}

app.post('/terminal/exec', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  if (!isRecord(request.body)) {
    return reply.code(400).send({ error: 'invalid_body' });
  }
  const command = typeof request.body.command === 'string' ? request.body.command.trim() : '';
  if (command.length === 0) {
    return reply.code(400).send({ error: 'command is required' });
  }

  const check = isCommandAllowed(command);
  if (!check.ok) {
    return reply.code(403).send({ error: 'command_blocked', message: check.reason });
  }

  const { execFile } = await import('node:child_process');
  const parts = command.split(/\s+/);
  const bin = parts[0]!;
  const args = parts.slice(1);

  return new Promise<void>((resolve) => {
    const child = execFile(
      bin,
      args,
      {
        timeout: TERMINAL_TIMEOUT_MS,
        maxBuffer: TERMINAL_MAX_OUTPUT_BYTES,
        env: { ...process.env, TERM: 'dumb', LANG: 'en_US.UTF-8' },
      },
      (error, stdout, stderr) => {
        const exitCode = error && 'code' in error ? ((error as { code?: number }).code ?? 1) : 0;
        void reply.code(200).send({
          command,
          exitCode,
          stdout: typeof stdout === 'string' ? stdout.slice(0, TERMINAL_MAX_OUTPUT_BYTES) : '',
          stderr: typeof stderr === 'string' ? stderr.slice(0, TERMINAL_MAX_OUTPUT_BYTES) : '',
          truncated:
            (typeof stdout === 'string' && stdout.length > TERMINAL_MAX_OUTPUT_BYTES) ||
            (typeof stderr === 'string' && stderr.length > TERMINAL_MAX_OUTPUT_BYTES),
        });
        resolve();
      }
    );
    child.on('error', (err) => {
      void reply.code(200).send({
        command,
        exitCode: 127,
        stdout: '',
        stderr: err.message,
        truncated: false,
      });
      resolve();
    });
  });
});

app.get('/terminal/allowlist', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }
  return reply.code(200).send({
    allowed: [...TERMINAL_ALLOWED_COMMANDS].sort(),
    blocked: [...TERMINAL_BLOCKED_COMMANDS].sort(),
  });
});

// ── Config Reader + Command Queue Endpoints ──────────────────────────

app.get(
  '/openclaw/targets/:targetId/config',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    const config = readFullConfig(target.openclawDir);
    if (!config) return reply.code(200).send({ available: false, config: null });
    return reply.code(200).send({ available: true, config });
  }
);

app.get(
  '/openclaw/targets/:targetId/agents',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    return reply.code(200).send({ agents: readAgents(target.openclawDir) });
  }
);

app.get(
  '/openclaw/targets/:targetId/models',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    return reply.code(200).send({ models: readModels(target.openclawDir) });
  }
);

app.get(
  '/openclaw/targets/:targetId/bindings',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    return reply.code(200).send({ bindings: readBindings(target.openclawDir) });
  }
);

app.get(
  '/openclaw/targets/:targetId/config-raw',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    const raw = readRawConfigString(target.openclawDir);
    return reply.code(200).send({ raw: raw ?? null });
  }
);

// ── Command Queue ──

app.post('/openclaw/queue', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
  if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

  const targetId = typeof request.body.targetId === 'string' ? request.body.targetId : '';
  if (!targetId) return reply.code(400).send({ error: 'targetId is required' });

  const target = openclawTargetStore.get(targetId);
  if (!target) return reply.code(404).send({ error: 'target_not_found' });

  const ALLOWED_COMMANDS = new Set(['openclaw']);
  const commands = Array.isArray(request.body.commands) ? request.body.commands : [];
  const parsed: { command: string; args: readonly string[]; description: string }[] = [];
  for (const cmd of commands) {
    if (!isRecord(cmd)) continue;
    const command = typeof cmd.command === 'string' ? cmd.command : 'openclaw';
    if (!ALLOWED_COMMANDS.has(command)) {
      return reply.code(400).send({ error: `Disallowed command: ${command}` });
    }
    const args = Array.isArray(cmd.args)
      ? cmd.args.filter((a: unknown): a is string => typeof a === 'string')
      : [];
    parsed.push({
      command,
      args,
      description: typeof cmd.description === 'string' ? cmd.description : '',
    });
  }
  if (parsed.length === 0) return reply.code(400).send({ error: 'No valid commands' });

  const state = commandQueue.queue(targetId, target.openclawDir, parsed);
  return reply.code(200).send(state);
});

app.get(
  '/openclaw/queue/:targetId',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    return reply.code(200).send(commandQueue.getState(request.params.targetId));
  }
);

app.post(
  '/openclaw/queue/:targetId/preview',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const diff = await commandQueue.preview(request.params.targetId);
    if (!diff) return reply.code(200).send({ available: false, diff: null });
    return reply.code(200).send({ available: true, diff });
  }
);

app.post(
  '/openclaw/queue/:targetId/apply',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const source =
      isRecord(request.body) && typeof request.body.source === 'string'
        ? request.body.source
        : 'manual';
    const result = await commandQueue.apply(request.params.targetId, source);
    if (!result.ok) return reply.code(422).send(result);
    broadcastSse({ kind: 'config-changed', payload: { targetId: request.params.targetId } });
    return reply.code(200).send(result);
  }
);

app.delete(
  '/openclaw/queue/:targetId',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    commandQueue.discard(request.params.targetId);
    return reply.code(200).send({ ok: true });
  }
);

// ── Agent CRUD (queue CLI commands) ──

app.post(
  '/openclaw/targets/:targetId/agents',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

    const agentId = typeof request.body.id === 'string' ? request.body.id.trim() : '';
    if (!agentId || !/^[a-zA-Z0-9_-]+$/.test(agentId)) {
      return reply.code(400).send({ error: 'Invalid agent id (alphanumeric, _, -)' });
    }

    const cmds: { command: string; args: string[]; description: string }[] = [];
    cmds.push({
      command: 'openclaw',
      args: ['agents', 'add', agentId, '--non-interactive'],
      description: `Create agent "${agentId}"`,
    });

    const name = typeof request.body.name === 'string' ? request.body.name : '';
    if (name) {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `agents.${agentId}.name`, name],
        description: `Set agent "${agentId}" name to "${name}"`,
      });
    }
    const emoji = typeof request.body.emoji === 'string' ? request.body.emoji : '';
    if (emoji) {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `agents.${agentId}.emoji`, emoji],
        description: `Set agent "${agentId}" emoji`,
      });
    }
    const systemPrompt =
      typeof request.body.systemPrompt === 'string' ? request.body.systemPrompt : '';
    if (systemPrompt) {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `agents.${agentId}.systemPrompt`, systemPrompt],
        description: `Set agent "${agentId}" system prompt`,
      });
    }
    const modelPrimary =
      isRecord(request.body.model) && typeof request.body.model.primary === 'string'
        ? request.body.model.primary
        : '';
    if (modelPrimary) {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `agents.${agentId}.model.primary`, modelPrimary],
        description: `Set agent "${agentId}" primary model`,
      });
    }
    if (request.body.enabled === false) {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `agents.${agentId}.enabled`, 'false'],
        description: `Disable agent "${agentId}"`,
      });
    }

    const state = commandQueue.queue(request.params.targetId, target.openclawDir, cmds);
    return reply.code(200).send({ queued: true, state });
  }
);

app.patch(
  '/openclaw/targets/:targetId/agents/:agentId',
  async (
    request: FastifyRequest<{ Params: { targetId: string; agentId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

    const agentId = request.params.agentId;
    if (!isValidEntityId(agentId)) return reply.code(400).send({ error: 'Invalid agent id' });
    const cmds: { command: string; args: string[]; description: string }[] = [];
    const fieldMap: Record<string, string> = {};

    if (typeof request.body.name === 'string') fieldMap.name = request.body.name;
    if (typeof request.body.emoji === 'string') fieldMap.emoji = request.body.emoji;
    if (typeof request.body.systemPrompt === 'string')
      fieldMap.systemPrompt = request.body.systemPrompt;
    if (typeof request.body.enabled === 'boolean') fieldMap.enabled = String(request.body.enabled);

    for (const [field, value] of Object.entries(fieldMap)) {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `agents.${agentId}.${field}`, value],
        description: `Update agent "${agentId}" ${field}`,
      });
    }

    if (isRecord(request.body.model)) {
      if (typeof request.body.model.primary === 'string') {
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `agents.${agentId}.model.primary`, request.body.model.primary],
          description: `Update agent "${agentId}" primary model`,
        });
      }
      if (typeof request.body.model.fallback === 'string') {
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `agents.${agentId}.model.fallback`, request.body.model.fallback],
          description: `Update agent "${agentId}" fallback model`,
        });
      }
    }

    if (cmds.length === 0) return reply.code(400).send({ error: 'No changes' });

    const state = commandQueue.queue(request.params.targetId, target.openclawDir, cmds);
    return reply.code(200).send({ queued: true, state });
  }
);

app.delete(
  '/openclaw/targets/:targetId/agents/:agentId',
  async (
    request: FastifyRequest<{ Params: { targetId: string; agentId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!isValidEntityId(request.params.agentId))
      return reply.code(400).send({ error: 'Invalid agent id' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });

    const state = commandQueue.queue(request.params.targetId, target.openclawDir, [
      {
        command: 'openclaw',
        args: ['agents', 'remove', request.params.agentId],
        description: `Remove agent "${request.params.agentId}"`,
      },
    ]);
    return reply.code(200).send({ queued: true, state });
  }
);

// ── Model Profiles CRUD ──

app.post(
  '/openclaw/targets/:targetId/models',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

    const modelId = typeof request.body.id === 'string' ? request.body.id.trim() : '';
    if (!modelId || !/^[a-zA-Z0-9_-]+$/.test(modelId)) {
      return reply.code(400).send({ error: 'Invalid model id' });
    }

    const cmds: { command: string; args: string[]; description: string }[] = [];
    const fields: Record<string, string> = {};
    if (typeof request.body.name === 'string') fields.name = request.body.name;
    if (typeof request.body.provider === 'string') fields.provider = request.body.provider;
    if (typeof request.body.model === 'string') fields.model = request.body.model;
    if (typeof request.body.apiKey === 'string') fields.apiKey = request.body.apiKey;
    if (typeof request.body.baseUrl === 'string') fields.baseUrl = request.body.baseUrl;
    if (typeof request.body.enabled === 'boolean') fields.enabled = String(request.body.enabled);

    for (const [field, value] of Object.entries(fields)) {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `models.${modelId}.${field}`, value],
        description: `Set model "${modelId}" ${field}`,
      });
    }

    if (cmds.length === 0) return reply.code(400).send({ error: 'No fields provided' });

    const state = commandQueue.queue(request.params.targetId, target.openclawDir, cmds);
    return reply.code(200).send({ queued: true, state });
  }
);

app.patch(
  '/openclaw/targets/:targetId/models/:modelId',
  async (
    request: FastifyRequest<{ Params: { targetId: string; modelId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

    const modelId = request.params.modelId;
    if (!isValidEntityId(modelId)) return reply.code(400).send({ error: 'Invalid model id' });
    const cmds: { command: string; args: string[]; description: string }[] = [];
    const fields: Record<string, string> = {};
    if (typeof request.body.name === 'string') fields.name = request.body.name;
    if (typeof request.body.provider === 'string') fields.provider = request.body.provider;
    if (typeof request.body.model === 'string') fields.model = request.body.model;
    if (typeof request.body.apiKey === 'string') fields.apiKey = request.body.apiKey;
    if (typeof request.body.baseUrl === 'string') fields.baseUrl = request.body.baseUrl;
    if (typeof request.body.enabled === 'boolean') fields.enabled = String(request.body.enabled);

    for (const [field, value] of Object.entries(fields)) {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `models.${modelId}.${field}`, value],
        description: `Update model "${modelId}" ${field}`,
      });
    }

    if (cmds.length === 0) return reply.code(400).send({ error: 'No changes' });

    const state = commandQueue.queue(request.params.targetId, target.openclawDir, cmds);
    return reply.code(200).send({ queued: true, state });
  }
);

app.delete(
  '/openclaw/targets/:targetId/models/:modelId',
  async (
    request: FastifyRequest<{ Params: { targetId: string; modelId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    if (!isValidEntityId(request.params.modelId))
      return reply.code(400).send({ error: 'Invalid model id' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });

    const state = commandQueue.queue(request.params.targetId, target.openclawDir, [
      {
        command: 'openclaw',
        args: ['config', 'unset', `models.${request.params.modelId}`],
        description: `Remove model "${request.params.modelId}"`,
      },
    ]);
    return reply.code(200).send({ queued: true, state });
  }
);

// ── Channel Config CRUD ──

app.patch(
  '/openclaw/targets/:targetId/channels/:channelId',
  async (
    request: FastifyRequest<{ Params: { targetId: string; channelId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

    const channelId = request.params.channelId;
    if (!isValidEntityId(channelId)) return reply.code(400).send({ error: 'Invalid channel id' });
    const cmds: { command: string; args: string[]; description: string }[] = [];

    if (typeof request.body.enabled === 'boolean') {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `channels.${channelId}.enabled`, String(request.body.enabled)],
        description: `${request.body.enabled ? 'Enable' : 'Disable'} channel "${channelId}"`,
      });
    }
    if (typeof request.body.dmPolicy === 'string') {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `channels.${channelId}.dmPolicy`, request.body.dmPolicy],
        description: `Set channel "${channelId}" DM policy`,
      });
    }
    if (typeof request.body.groupPolicy === 'string') {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `channels.${channelId}.groupPolicy`, request.body.groupPolicy],
        description: `Set channel "${channelId}" group policy`,
      });
    }
    if (typeof request.body.modelOverride === 'string') {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `channels.${channelId}.model`, request.body.modelOverride],
        description: `Set channel "${channelId}" model override`,
      });
    }

    if (cmds.length === 0) return reply.code(400).send({ error: 'No changes' });

    const state = commandQueue.queue(request.params.targetId, target.openclawDir, cmds);
    return reply.code(200).send({ queued: true, state });
  }
);

app.post(
  '/openclaw/targets/:targetId/channels/:channelId/bind',
  async (
    request: FastifyRequest<{ Params: { targetId: string; channelId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

    const agentId = typeof request.body.agentId === 'string' ? request.body.agentId : '';
    if (!agentId) return reply.code(400).send({ error: 'agentId is required' });
    if (!isValidEntityId(agentId)) return reply.code(400).send({ error: 'Invalid agent id' });

    const channelId = request.params.channelId;
    if (!isValidEntityId(channelId)) return reply.code(400).send({ error: 'Invalid channel id' });
    const cmds: { command: string; args: string[]; description: string }[] = [
      {
        command: 'openclaw',
        args: ['config', 'set', `channels.${channelId}.agents.+`, agentId],
        description: `Bind agent "${agentId}" to channel "${channelId}"`,
      },
    ];

    const modelOverride =
      typeof request.body.modelOverride === 'string' ? request.body.modelOverride : '';
    if (modelOverride) {
      cmds.push({
        command: 'openclaw',
        args: ['config', 'set', `channels.${channelId}.model`, modelOverride],
        description: `Set model override for binding on "${channelId}"`,
      });
    }

    const state = commandQueue.queue(request.params.targetId, target.openclawDir, cmds);
    return reply.code(200).send({ queued: true, state });
  }
);

app.post(
  '/openclaw/targets/:targetId/channels/:channelId/unbind',
  async (
    request: FastifyRequest<{ Params: { targetId: string; channelId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

    const agentId = typeof request.body.agentId === 'string' ? request.body.agentId : '';
    if (!agentId) return reply.code(400).send({ error: 'agentId is required' });
    if (!isValidEntityId(agentId)) return reply.code(400).send({ error: 'Invalid agent id' });

    const channelId = request.params.channelId;
    if (!isValidEntityId(channelId)) return reply.code(400).send({ error: 'Invalid channel id' });

    const state = commandQueue.queue(request.params.targetId, target.openclawDir, [
      {
        command: 'openclaw',
        args: ['config', 'unset', `channels.${channelId}.agents.${agentId}`],
        description: `Unbind agent "${agentId}" from channel "${channelId}"`,
      },
    ]);
    return reply.code(200).send({ queued: true, state });
  }
);

// ── Config Snapshots ──

app.get(
  '/openclaw/targets/:targetId/config-snapshots',
  async (request: FastifyRequest<{ Params: { targetId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const snapshots = commandQueue.listSnapshots(request.params.targetId);
    return reply.code(200).send({ snapshots });
  }
);

app.get(
  '/openclaw/targets/:targetId/config-snapshots/:snapId',
  async (
    request: FastifyRequest<{ Params: { targetId: string; snapId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const snap = commandQueue.getSnapshot(request.params.targetId, request.params.snapId);
    if (!snap) return reply.code(404).send({ error: 'snapshot_not_found' });
    return reply.code(200).send({ snapshot: snap });
  }
);

app.post(
  '/openclaw/targets/:targetId/config-snapshots/:snapId/rollback',
  async (
    request: FastifyRequest<{ Params: { targetId: string; snapId: string } }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const target = openclawTargetStore.get(request.params.targetId);
    if (!target) return reply.code(404).send({ error: 'target_not_found' });

    const beforeConfig = readRawConfigString(target.openclawDir);
    if (beforeConfig) {
      await commandQueue.createSnapshot(
        request.params.targetId,
        beforeConfig,
        'rollback',
        `Before rollback to ${request.params.snapId}`
      );
    }

    const result = await commandQueue.rollbackToSnapshot(request.params.snapId, target.openclawDir);
    if (result.ok) {
      broadcastSse({ kind: 'config-changed', payload: { targetId: request.params.targetId } });
    }
    return reply.code(result.ok ? 200 : 422).send(result);
  }
);

// ── Recipes ──

import { BUILT_IN_RECIPES } from './recipes/built-in.js';

app.get('/recipes', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
  return reply.code(200).send({ recipes: BUILT_IN_RECIPES });
});

app.get(
  '/recipes/:recipeId',
  async (request: FastifyRequest<{ Params: { recipeId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const recipe = BUILT_IN_RECIPES.find((r) => r.id === request.params.recipeId);
    if (!recipe) return reply.code(404).send({ error: 'recipe_not_found' });
    return reply.code(200).send({ recipe });
  }
);

app.post(
  '/recipes/:recipeId/resolve',
  async (request: FastifyRequest<{ Params: { recipeId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const recipe = BUILT_IN_RECIPES.find((r) => r.id === request.params.recipeId);
    if (!recipe) return reply.code(404).send({ error: 'recipe_not_found' });
    if (!isRecord(request.body)) return reply.code(400).send({ error: 'invalid_body' });

    const SAFE_PARAM_RE = /^[a-zA-Z0-9_.@:/ -]*$/;
    const params = isRecord(request.body.params) ? request.body.params : {};
    for (const [key, value] of Object.entries(params)) {
      const strValue = String(value);
      if (!SAFE_PARAM_RE.test(strValue)) {
        return reply.code(400).send({ error: `Invalid characters in param "${key}"` });
      }
    }
    const resolvedSteps = recipe.steps.map((step) => {
      const resolvedArgs: Record<string, string> = {};
      for (const [key, template] of Object.entries(step.args)) {
        let resolved = template;
        for (const [paramId, paramValue] of Object.entries(params)) {
          resolved = resolved.replaceAll(`{{${paramId}}}`, String(paramValue));
        }
        resolvedArgs[key] = resolved;
      }
      return { ...step, args: resolvedArgs };
    });

    const commands = resolvedSteps.map((step) => ({
      command: 'openclaw',
      args: Object.values(step.args),
      description: step.label,
    }));

    return reply.code(200).send({ steps: resolvedSteps, commands });
  }
);

// ── File Manager (SFTP) ─────────────────────────────────────────────

function validateAbsolutePath(p: string): boolean {
  if (!p || !p.startsWith('/')) return false;
  const normalized = path.posix.normalize(p);
  if (normalized !== p && normalized !== p.replace(/\/+$/, '')) {
    return false;
  }
  if (normalized.includes('/../') || normalized.endsWith('/..') || normalized === '/..') {
    return false;
  }
  const segments = normalized.split('/');
  for (const seg of segments) {
    if (seg === '..') return false;
  }
  return true;
}

app.get('/files/connections', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
  const connections = await sftpSessionManager.getConnections();
  return reply.code(200).send(connections);
});

app.post(
  '/files/connections',
  async (
    request: FastifyRequest<{
      Body: Omit<CustomSshConnection, 'id'>;
    }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const { label, host, port: sshPort, user, keyPath } = request.body;
    if (!host || !user || !keyPath) {
      return reply.code(400).send({ error: 'host, user, and keyPath are required' });
    }
    if (!isPathUnderSshDir(keyPath)) {
      return reply.code(403).send({ error: 'SSH key path must be under ~/.ssh/' });
    }
    const conn = await sftpSessionManager.addCustomConnection({
      label: label || `${user}@${host}`,
      host,
      port: sshPort || 22,
      user,
      keyPath,
    });
    return reply.code(201).send(conn);
  }
);

app.delete(
  '/files/connections/:id',
  async (request: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const removed = await sftpSessionManager.removeCustomConnection(request.params.id);
    if (!removed) return reply.code(404).send({ error: 'connection not found' });
    return reply.code(200).send({ ok: true });
  }
);

app.get(
  '/files/:connId/ls',
  async (
    request: FastifyRequest<{
      Params: { connId: string };
      Querystring: { path?: string };
    }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const remotePath = (request.query as { path?: string }).path || '/';
    if (!validateAbsolutePath(remotePath)) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    try {
      const sftp = await sftpSessionManager.getSftp(request.params.connId);
      const entries = await new Promise<
        Array<{
          filename: string;
          longname: string;
          attrs: { size: number; mtime: number; mode: number; uid: number; gid: number };
        }>
      >((resolve, reject) => {
        sftp.readdir(remotePath, (err, list) => {
          if (err) return reject(err);
          resolve(list as never);
        });
      });

      const files = entries
        .filter((e) => e.filename !== '.' && e.filename !== '..')
        .map((e) => {
          const isDir = (e.attrs.mode & 0o40000) !== 0;
          const isLink = (e.attrs.mode & 0o120000) === 0o120000;
          const perms = (e.attrs.mode & 0o7777).toString(8).padStart(4, '0');
          return {
            name: e.filename,
            type: isLink ? 'symlink' : isDir ? 'directory' : 'file',
            size: e.attrs.size,
            mtime: e.attrs.mtime * 1000,
            permissions: perms,
          };
        })
        .sort((a, b) => {
          if (a.type === 'directory' && b.type !== 'directory') return -1;
          if (a.type !== 'directory' && b.type === 'directory') return 1;
          return a.name.localeCompare(b.name);
        });

      return reply.code(200).send({ path: remotePath, entries: files });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  }
);

app.get(
  '/files/:connId/stat',
  async (
    request: FastifyRequest<{
      Params: { connId: string };
      Querystring: { path?: string };
    }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const remotePath = (request.query as { path?: string }).path || '/';
    if (!validateAbsolutePath(remotePath)) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    try {
      const sftp = await sftpSessionManager.getSftp(request.params.connId);
      const attrs = await new Promise<{
        size: number;
        mtime: number;
        mode: number;
        uid: number;
        gid: number;
      }>((resolve, reject) => {
        sftp.stat(remotePath, (err, stats) => {
          if (err) return reject(err);
          resolve(stats as never);
        });
      });

      const isDir = (attrs.mode & 0o40000) !== 0;
      return reply.code(200).send({
        path: remotePath,
        type: isDir ? 'directory' : 'file',
        size: attrs.size,
        mtime: attrs.mtime * 1000,
        permissions: (attrs.mode & 0o7777).toString(8).padStart(4, '0'),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  }
);

app.get(
  '/files/:connId/download',
  async (
    request: FastifyRequest<{
      Params: { connId: string };
      Querystring: { path?: string };
    }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const remotePath = (request.query as { path?: string }).path;
    if (!remotePath || !validateAbsolutePath(remotePath)) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    try {
      const sftp = await sftpSessionManager.getSftp(request.params.connId);

      const attrs = await new Promise<{ size: number }>((resolve, reject) => {
        sftp.stat(remotePath, (err, stats) => {
          if (err) return reject(err);
          resolve(stats as never);
        });
      });

      const basename = path.basename(remotePath);
      void reply.header('Content-Type', 'application/octet-stream');
      void reply.header(
        'Content-Disposition',
        `attachment; filename="${encodeURIComponent(basename)}"`
      );
      void reply.header('Content-Length', attrs.size);

      const stream = sftp.createReadStream(remotePath);
      return reply.send(stream);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  }
);

app.post(
  '/files/:connId/upload',
  async (request: FastifyRequest<{ Params: { connId: string } }>, reply: FastifyReply) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    try {
      const sftp = await sftpSessionManager.getSftp(request.params.connId);
      const parts = request.parts();
      let remotePath = '/tmp';
      const uploaded: string[] = [];

      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'remotePath') {
          remotePath = String(part.value);
          if (!validateAbsolutePath(remotePath)) {
            return reply.code(400).send({ error: 'Invalid remotePath' });
          }
          continue;
        }
        if (part.type === 'file') {
          const safeName = path.posix.basename(part.filename);
          if (!safeName || safeName === '.' || safeName === '..') {
            return reply.code(400).send({ error: 'Invalid filename' });
          }
          const destPath = path.posix.join(remotePath, safeName);
          await new Promise<void>((resolve, reject) => {
            const writeStream = sftp.createWriteStream(destPath);
            part.file.pipe(writeStream);
            writeStream.on('close', resolve);
            writeStream.on('error', reject);
            part.file.on('error', reject);
          });
          uploaded.push(destPath);
        }
      }

      return reply.code(200).send({ ok: true, uploaded });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  }
);

app.post(
  '/files/:connId/mkdir',
  async (
    request: FastifyRequest<{
      Params: { connId: string };
      Body: { path: string };
    }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const remotePath = request.body.path;
    if (!remotePath || !validateAbsolutePath(remotePath)) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    try {
      const sftp = await sftpSessionManager.getSftp(request.params.connId);
      await new Promise<void>((resolve, reject) => {
        sftp.mkdir(remotePath, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      return reply.code(201).send({ ok: true, path: remotePath });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  }
);

app.post(
  '/files/:connId/rename',
  async (
    request: FastifyRequest<{
      Params: { connId: string };
      Body: { oldPath: string; newPath: string };
    }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const { oldPath, newPath } = request.body;
    if (!validateAbsolutePath(oldPath) || !validateAbsolutePath(newPath)) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    try {
      const sftp = await sftpSessionManager.getSftp(request.params.connId);
      await new Promise<void>((resolve, reject) => {
        sftp.rename(oldPath, newPath, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
      return reply.code(200).send({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  }
);

app.delete(
  '/files/:connId/rm',
  async (
    request: FastifyRequest<{
      Params: { connId: string };
      Querystring: { path?: string; recursive?: string };
    }>,
    reply: FastifyReply
  ) => {
    if (!isAuthorized(request)) return reply.code(401).send({ error: 'unauthorized' });
    const remotePath = (request.query as { path?: string }).path;
    const recursive = (request.query as { recursive?: string }).recursive === 'true';
    if (!remotePath || !validateAbsolutePath(remotePath)) {
      return reply.code(400).send({ error: 'Invalid path' });
    }

    try {
      const sftp = await sftpSessionManager.getSftp(request.params.connId);

      const attrs = await new Promise<{ mode: number }>((resolve, reject) => {
        sftp.stat(remotePath, (err, stats) => {
          if (err) return reject(err);
          resolve(stats as never);
        });
      });

      const isDir = (attrs.mode & 0o40000) !== 0;

      if (isDir) {
        if (recursive) {
          await removeDirRecursive(sftp, remotePath);
        } else {
          await new Promise<void>((resolve, reject) => {
            sftp.rmdir(remotePath, (err) => {
              if (err) return reject(err);
              resolve();
            });
          });
        }
      } else {
        await new Promise<void>((resolve, reject) => {
          sftp.unlink(remotePath, (err) => {
            if (err) return reject(err);
            resolve();
          });
        });
      }

      return reply.code(200).send({ ok: true });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ error: msg });
    }
  }
);

async function removeDirRecursive(
  sftp: Awaited<ReturnType<typeof sftpSessionManager.getSftp>>,
  dirPath: string
): Promise<void> {
  const entries = await new Promise<Array<{ filename: string; attrs: { mode: number } }>>(
    (resolve, reject) => {
      sftp.readdir(dirPath, (err, list) => {
        if (err) return reject(err);
        resolve(list as never);
      });
    }
  );

  for (const entry of entries) {
    if (entry.filename === '.' || entry.filename === '..') continue;
    const fullPath = path.posix.join(dirPath, entry.filename);
    const isDir = (entry.attrs.mode & 0o40000) !== 0;
    if (isDir) {
      await removeDirRecursive(sftp, fullPath);
    } else {
      await new Promise<void>((resolve, reject) => {
        sftp.unlink(fullPath, (err) => {
          if (err) return reject(err);
          resolve();
        });
      });
    }
  }

  await new Promise<void>((resolve, reject) => {
    sftp.rmdir(dirPath, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

// ── Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  app.log.info(`Received ${signal}, shutting down gracefully…`);
  cronService.stop();
  openclawSyncManager.stopAll();
  sftpSessionManager.closeAll();
  await bridgeSetupManager.closeAll();
  clearInterval(heartbeatChecker);
  await orchestrator.close();
  await app.close();
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

process.on('uncaughtException', (error) => {
  app.log.error({ err: error }, 'Uncaught exception');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  app.log.error({ err: reason }, 'Unhandled promise rejection');
});

app.listen({ port, host }).catch((error: unknown) => {
  app.log.error(error);
  process.exit(1);
});
