import { createHmac, timingSafeEqual } from 'node:crypto';
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

const INGEST_BODY_LIMIT_BYTES = 1024 * 1024;
const CRON_SYNC_BODY_LIMIT_BYTES = 4 * 1024 * 1024;
const APP_BODY_LIMIT_BYTES = Math.max(INGEST_BODY_LIMIT_BYTES, CRON_SYNC_BODY_LIMIT_BYTES);
const SSE_HEARTBEAT_MS = 15_000;
const SSE_MAX_PENDING_CHUNKS = 1_024;
const BRIDGE_CRON_SYNC_RATE_LIMIT_WINDOW_MS = 60_000;
const BRIDGE_CRON_SYNC_RATE_LIMIT_MAX_REQUESTS = Number(
  process.env.BRIDGE_CRON_SYNC_RATE_LIMIT_MAX ?? '60'
);

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
}

interface OpenClawChannelSummary {
  readonly id: string;
  readonly name: string;
  readonly configured: boolean;
  readonly dmPolicy: 'pairing' | 'open' | 'unknown';
  readonly hasGroups: boolean;
  readonly connected: boolean;
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
  fs.mkdirSync(AUTH_SETTINGS_DIR, { recursive: true });
  fs.writeFileSync(AUTH_SETTINGS_FILE, JSON.stringify(settings, null, 2) + '\n');
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

const HMAC_KEY = Buffer.from('patze-constant-time-compare');

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
  return typeof value === 'object' && value !== null;
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
  return reply.code(200).send({ ok: true });
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
  if (origin) {
    response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
  }
  response.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  response.setHeader('Cache-Control', 'no-cache, no-transform');
  response.setHeader('Connection', 'keep-alive');
  response.setHeader('X-Accel-Buffering', 'no');
  // TODO: support Last-Event-ID resume semantics once replay buffer is introduced.
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

function buildOpenClawHealth(
  targetPath: string,
  syncStatus: OpenClawSyncStatus
): OpenClawHealthCheck {
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

  const ok = checks.every((check) => check.status === 'ok');
  return {
    ok,
    target: path.resolve(targetPath),
    checks,
    syncStatus,
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

function parseDmPolicy(config: Readonly<Record<string, unknown>>): 'pairing' | 'open' | 'unknown' {
  const dmPolicy = config.dmPolicy;
  if (dmPolicy === 'pairing' || dmPolicy === 'open') {
    return dmPolicy;
  }
  return 'unknown';
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
        hasGroups: false,
        connected: false,
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
          hasGroups: false,
          connected: false,
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
      const lastMessageAt = toStringOrUndefined(sessionStats.lastMessageAt);
      const messageCount = toNumberOrUndefined(sessionStats.messageCount);
      return {
        id: channel.id,
        name: channel.name,
        configured: isChannelConfigured(channelConfig),
        dmPolicy: parseDmPolicy(channelConfig),
        hasGroups: toBoolean(channelConfig.hasGroups) || toBoolean(channelConfig.groupsEnabled),
        connected: toBoolean(channelConfig.connected) || channelConfig.status === 'connected',
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
        hasGroups: false,
        connected: false,
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

if (authConfig.mode === 'none') {
  app.log.warn('Auth mode is "none" — all endpoints are publicly accessible.');
}

// ── Scheduled Tasks (Cron) ──────────────────────────────────────────

const cronStoreDir =
  process.env.CRON_STORE_DIR ?? path.join(os.homedir(), '.patze-control', 'cron');
const taskExecutor = createTaskExecutor({ orchestrator, telemetryAggregator, app });

const taskEventListeners = new Set<(event: TaskEvent) => void>();
const openclawSyncStatusListeners = new Set<(status: OpenClawSyncStatus) => void>();

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
  if (origin) {
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

  const heartbeat = setInterval(() => {
    sse.enqueue(writeSseCommentChunk('heartbeat'));
  }, SSE_HEARTBEAT_MS);

  const cleanup = (): void => {
    clearInterval(heartbeat);
    taskEventListeners.delete(listener);
    openclawSyncStatusListeners.delete(syncListener);
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
      ? body.openclawDir.replace('~', os.homedir())
      : body.openclawDir
  );
  if (resolvedDir === '/' || resolvedDir === '/etc' || resolvedDir === '/root') {
    return reply
      .code(400)
      .send({ error: 'invalid_openclaw_dir', message: 'Cannot use system root directories.' });
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
    return reply.code(200).send(buildOpenClawHealth(target.openclawDir, status));
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
  return reply.code(200).send(buildOpenClawHealth(openclawDir, status));
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

// ── Shutdown ────────────────────────────────────────────────────────

async function shutdown(signal: string): Promise<void> {
  app.log.info(`Received ${signal}, shutting down gracefully…`);
  cronService.stop();
  openclawSyncManager.stopAll();
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
