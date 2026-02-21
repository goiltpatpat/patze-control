import {
  reduceFrontendSnapshot,
  type AnyTelemetryEvent,
  type FrontendUnifiedSnapshot,
} from '@patze/telemetry-core';

export interface ControlClientOptions {
  baseUrl: string;
  token?: string;
  reconnectBaseDelayMs?: number;
  reconnectMaxDelayMs?: number;
  maxSeenEventIds?: number;
}

export type SnapshotListener = (snapshot: FrontendUnifiedSnapshot) => void;

export interface ControlClient {
  start(): Promise<void>;
  stop(): void;
  onSnapshot(listener: SnapshotListener): () => void;
  getSnapshot(): FrontendUnifiedSnapshot | null;
}

const DEFAULT_RECONNECT_BASE_DELAY_MS = 1_000;
const DEFAULT_RECONNECT_MAX_DELAY_MS = 10_000;
const DEFAULT_MAX_SEEN_EVENT_IDS = 5_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function deepFreeze<T>(value: T): Readonly<T> {
  return deepFreezeUnknown(value) as Readonly<T>;
}

function deepFreezeUnknown(value: unknown): unknown {
  if (Array.isArray(value)) {
    const cloned = value.map((item) => deepFreezeUnknown(item));
    return Object.freeze(cloned);
  }

  if (isRecord(value)) {
    const clone: Record<string, unknown> = { ...value };
    for (const key of Object.keys(clone)) {
      clone[key] = deepFreezeUnknown(clone[key]);
    }
    return Object.freeze(clone);
  }

  return value;
}

function buildAuthHeaders(token?: string): Record<string, string> {
  if (!token || token.length === 0) {
    return {};
  }

  return {
    Authorization: `Bearer ${token}`,
  };
}

function buildSseHeaders(token?: string, lastEventId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    ...buildAuthHeaders(token),
  };

  // TODO: rely on Last-Event-ID once server-side resume semantics are implemented.
  if (lastEventId && lastEventId.length > 0) {
    headers['Last-Event-ID'] = lastEventId;
  }

  return headers;
}

function toAbsoluteUrl(baseUrl: string, path: string): string {
  const url = new URL(baseUrl);
  url.pathname = path;
  url.search = '';
  url.hash = '';
  return url.toString();
}

function withDegradedHealth(snapshot: FrontendUnifiedSnapshot): FrontendUnifiedSnapshot {
  if (snapshot.health.overall === 'degraded') {
    return snapshot;
  }

  return deepFreeze({
    ...snapshot,
    health: {
      ...snapshot.health,
      overall: 'degraded' as const,
    },
  }) as FrontendUnifiedSnapshot;
}

function parseEventTimestamp(event: Readonly<AnyTelemetryEvent>): string {
  const timestamp = event.ts;
  if (typeof timestamp === 'string' && timestamp.length > 0) {
    return timestamp;
  }
  return new Date().toISOString();
}

function parseSseEventPayload(dataLines: readonly string[]): unknown {
  return JSON.parse(dataLines.join('\n'));
}

interface SseFrame {
  id?: string;
  event?: string;
  data: string[];
}

function createEmptySseFrame(): SseFrame {
  return { data: [] };
}

function extractEventId(payload: unknown, frameId?: string): string | null {
  if (frameId && frameId.length > 0) {
    return frameId;
  }

  if (isRecord(payload) && typeof payload.id === 'string' && payload.id.length > 0) {
    return payload.id;
  }

  return null;
}

function shouldApplySseFrame(frame: SseFrame): boolean {
  if (frame.data.length === 0) {
    return false;
  }

  if (frame.event && frame.event.length > 0 && frame.event !== 'telemetry') {
    return false;
  }

  return true;
}

function rememberEventId(
  eventId: string,
  seenEventIds: Set<string>,
  seenEventQueue: string[],
  maxSeenEventIds: number
): void {
  if (seenEventIds.has(eventId)) {
    return;
  }

  seenEventIds.add(eventId);
  seenEventQueue.push(eventId);

  while (seenEventQueue.length > maxSeenEventIds) {
    const removed = seenEventQueue.shift();
    if (!removed) {
      continue;
    }
    seenEventIds.delete(removed);
  }
}

export function createControlClient(options: ControlClientOptions): ControlClient {
  const listeners = new Set<SnapshotListener>();

  let snapshot: FrontendUnifiedSnapshot | null = null;
  let running = false;
  let reconnectAttempt = 0;
  let abortController: AbortController | null = null;
  let lifecycleAbortController: AbortController | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let streamLoop: Promise<void> | null = null;
  let lastEventId: string | null = null;
  const seenEventIds = new Set<string>();
  const seenEventQueue: string[] = [];

  const reconnectBaseDelayMs =
    options.reconnectBaseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS;
  const reconnectMaxDelayMs =
    options.reconnectMaxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS;
  const maxSeenEventIds = options.maxSeenEventIds ?? DEFAULT_MAX_SEEN_EVENT_IDS;

  const snapshotUrl = toAbsoluteUrl(options.baseUrl, '/snapshot');
  const eventsUrl = toAbsoluteUrl(options.baseUrl, '/events');

  function emitSnapshot(next: FrontendUnifiedSnapshot): void {
    snapshot = next;
    for (const listener of listeners) {
      listener(next);
    }
  }

  function clearReconnectTimer(): void {
    if (!reconnectTimer) {
      return;
    }
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  async function waitForReconnect(ms: number, signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const onAbort = (): void => {
        clearReconnectTimer();
        signal.removeEventListener('abort', onAbort);
        resolve();
      };

      reconnectTimer = setTimeout(() => {
        clearReconnectTimer();
        signal.removeEventListener('abort', onAbort);
        resolve();
      }, ms);

      signal.addEventListener('abort', onAbort);
    });
  }

  async function fetchSnapshot(signal?: AbortSignal): Promise<FrontendUnifiedSnapshot> {
    const response = await fetch(snapshotUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...buildAuthHeaders(options.token),
      },
      ...(signal ? { signal } : {}),
    });

    if (!response.ok) {
      throw new Error(`Snapshot fetch failed: ${String(response.status)}`);
    }

    const payload: unknown = await response.json();
    return deepFreeze(payload) as FrontendUnifiedSnapshot;
  }

  async function consumeSse(signal: AbortSignal): Promise<void> {
    const response = await fetch(eventsUrl, {
      method: 'GET',
      headers: buildSseHeaders(options.token, lastEventId ?? undefined),
      signal,
    });

    if (!response.ok) {
      throw new Error(`SSE connect failed: ${String(response.status)}`);
    }

    if (!response.body) {
      throw new Error('SSE stream response body is empty.');
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    let buffer = '';
    let frame = createEmptySseFrame();

    const dispatchFrame = (): void => {
      if (!snapshot || !shouldApplySseFrame(frame)) {
        frame = createEmptySseFrame();
        return;
      }

      let rawPayload: unknown;
      try {
        rawPayload = parseSseEventPayload(frame.data);
      } catch {
        frame = createEmptySseFrame();
        return;
      }

      if (!isRecord(rawPayload)) {
        frame = createEmptySseFrame();
        return;
      }

      const eventId = extractEventId(rawPayload, frame.id);
      if (eventId && seenEventIds.has(eventId)) {
        frame = createEmptySseFrame();
        return;
      }

      const event = deepFreeze(rawPayload) as Readonly<AnyTelemetryEvent>;
      const reduced = reduceFrontendSnapshot(snapshot, event, {
        receivedAt: parseEventTimestamp(event),
      });
      emitSnapshot(reduced);

      if (eventId) {
        lastEventId = eventId;
        rememberEventId(eventId, seenEventIds, seenEventQueue, maxSeenEventIds);
      }

      frame = createEmptySseFrame();
    };

    try {
      while (running) {
        const next = await reader.read();
        if (next.done) {
          break;
        }

        buffer += decoder.decode(next.value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const rawLine of lines) {
          const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

          if (line.length === 0) {
            dispatchFrame();
            continue;
          }

          if (line.startsWith(':')) {
            continue;
          }

          const separatorIndex = line.indexOf(':');
          const field = separatorIndex >= 0 ? line.slice(0, separatorIndex) : line;
          const rawValue = separatorIndex >= 0 ? line.slice(separatorIndex + 1) : '';
          const value = rawValue.startsWith(' ') ? rawValue.slice(1) : rawValue;

          if (field === 'data') {
            frame.data.push(value);
            continue;
          }

          if (field === 'id') {
            frame.id = value;
            continue;
          }

          if (field === 'event') {
            frame.event = value;
          }
        }
      }

      if (frame.data.length > 0) {
        dispatchFrame();
      }
    } finally {
      await reader.cancel();
    }
  }

  async function runSseLoop(signal: AbortSignal): Promise<void> {
    let shouldRefreshBeforeConnect = false;

    while (running) {
      try {
        if (shouldRefreshBeforeConnect) {
          const refreshed = await fetchSnapshot(signal);
          emitSnapshot(refreshed);
        }

        await consumeSse(signal);
        reconnectAttempt = 0;
        shouldRefreshBeforeConnect = false;
      } catch {
        // Connection failure is handled by degraded health and reconnect backoff below.
        shouldRefreshBeforeConnect = true;
      }

      if (!running) {
        break;
      }

      if (snapshot) {
        emitSnapshot(withDegradedHealth(snapshot));
      }

      shouldRefreshBeforeConnect = true;

      const delay = Math.min(
        reconnectMaxDelayMs,
        reconnectBaseDelayMs * Math.max(1, 2 ** reconnectAttempt)
      );

      reconnectAttempt += 1;
      await waitForReconnect(delay, signal);
    }

    clearReconnectTimer();
    abortController = null;
    lifecycleAbortController = null;
  }

  return {
    async start(): Promise<void> {
      if (running) {
        return;
      }

      running = true;
      reconnectAttempt = 0;
      lifecycleAbortController = new AbortController();
      abortController = lifecycleAbortController;
      const signal = lifecycleAbortController.signal;

      const initialSnapshot = await fetchSnapshot(signal);
      emitSnapshot(initialSnapshot);

      streamLoop = runSseLoop(signal);
    },

    stop(): void {
      running = false;
      clearReconnectTimer();
      lifecycleAbortController?.abort();
      abortController?.abort();
      lifecycleAbortController = null;
      abortController = null;
      void streamLoop;
    },

    onSnapshot(listener: SnapshotListener): () => void {
      listeners.add(listener);

      if (snapshot) {
        listener(snapshot);
      }

      return (): void => {
        listeners.delete(listener);
      };
    },

    getSnapshot(): FrontendUnifiedSnapshot | null {
      return snapshot;
    },
  };
}
