import { createHmac, timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import {
  TelemetryAggregator,
  TelemetryNode,
  toFrontendUnifiedSnapshot,
  type AnyTelemetryEvent,
  type AuthConfig,
  type MachineEndpoint,
} from '@patze/telemetry-core';
import { RemoteNodeAttachmentOrchestrator } from './remote-node-attachment-orchestrator.js';
import { SshTunnelRuntime } from './ssh-tunnel-runtime.js';

const INGEST_BODY_LIMIT_BYTES = 1024 * 1024;
const SSE_HEARTBEAT_MS = 15_000;
const SSE_MAX_PENDING_CHUNKS = 1_024;

type IngestRequest = FastifyRequest<{ Body: unknown }>;
type BatchIngestRequest = FastifyRequest<{ Body: unknown }>;
type RawResponse = FastifyReply['raw'];

const app = Fastify({
  logger: true,
  bodyLimit: INGEST_BODY_LIMIT_BYTES,
});

const telemetryNode = new TelemetryNode();
const telemetryAggregator = new TelemetryAggregator();
telemetryAggregator.attachNode('local', telemetryNode);

const sshTunnelRuntime = new SshTunnelRuntime();
const orchestrator = new RemoteNodeAttachmentOrchestrator(sshTunnelRuntime, telemetryAggregator);

function loadAuthConfig(): AuthConfig {
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

const authConfig = loadAuthConfig();

if (authConfig.mode === 'token' && (!authConfig.token || authConfig.token.trim().length === 0)) {
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

  const token = parseBearerToken(request);
  if (token === null || !authConfig.token) {
    return false;
  }

  return constantTimeEquals(token, authConfig.token);
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

function writeSseEventChunk(event: Readonly<AnyTelemetryEvent>): string {
  return `id: ${String(event.id)}\nevent: telemetry\ndata: ${JSON.stringify(event)}\n\n`;
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

  if (!isJsonContentType(request)) {
    return reply.code(415).send({ error: 'unsupported_media_type' });
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

  if (!isJsonContentType(request)) {
    return reply.code(415).send({ error: 'unsupported_media_type' });
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

function parseEndpointBody(body: unknown): MachineEndpoint | null {
  if (!isRecord(body)) {
    return null;
  }
  if (typeof body.id !== 'string' || typeof body.label !== 'string') {
    return null;
  }
  return body as unknown as MachineEndpoint;
}

app.post('/remote/attach', async (request: AttachRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  const endpoint = parseEndpointBody(request.body);
  if (!endpoint) {
    return reply.code(400).send({ error: 'invalid_endpoint_body' });
  }

  try {
    const info = await orchestrator.attachEndpoint(endpoint);
    return reply.code(200).send(info);
  } catch (error) {
    return reply.code(500).send({
      error: 'attach_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

app.post('/remote/detach', async (request: DetachRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  if (!isRecord(request.body) || typeof request.body.endpointId !== 'string') {
    return reply.code(400).send({ error: 'endpointId is required' });
  }

  try {
    await orchestrator.detachEndpoint(request.body.endpointId as string, { closeTunnel: true });
    return reply.code(200).send({ ok: true });
  } catch (error) {
    return reply.code(500).send({
      error: 'detach_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

app.get('/remote/attachments', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  return reply.code(200).send({ attachments: orchestrator.listAttachments() });
});

app.get('/tunnels', async (request: FastifyRequest, reply: FastifyReply) => {
  if (!isAuthorized(request)) {
    return reply.code(401).send({ error: 'unauthorized' });
  }

  return reply.code(200).send({ tunnels: sshTunnelRuntime.listTunnels() });
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
      app.log.warn(`Machine ${machineId} marked offline — no heartbeat for ${String(HEARTBEAT_TIMEOUT_MS)}ms`);
    }
  }
}, HEARTBEAT_CHECK_INTERVAL_MS);

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  const statusCode = (error as { statusCode?: number }).statusCode ?? 500;
  const errorMessage = error instanceof Error ? error.message : String(error);
  void reply.code(statusCode).send({
    error: statusCode >= 500 ? 'internal_server_error' : 'request_error',
    message: statusCode >= 500 ? 'An unexpected error occurred.' : errorMessage,
  });
});

app.setNotFoundHandler((_request, reply) => {
  void reply.code(404).send({ error: 'not_found', message: 'Route not found.' });
});

const port = Number(process.env.PORT ?? '8080');
const host = process.env.HOST ?? '0.0.0.0';

if (authConfig.mode === 'none') {
  app.log.warn('Auth mode is "none" — all endpoints are publicly accessible.');
}

async function shutdown(signal: string): Promise<void> {
  app.log.info(`Received ${signal}, shutting down gracefully…`);
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

app
  .listen({ port, host })
  .catch((error: unknown) => {
    app.log.error(error);
    process.exit(1);
  });
