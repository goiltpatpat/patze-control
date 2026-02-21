import fs from 'node:fs';
import os from 'node:os';
import type { AgentId, LogEntryId, MachineId, SessionId, SessionRunLifecycleState, ToolCallId, TraceId, SpanId, TelemetryEventId, RunId } from '@patze/telemetry-core';
import type { DetectedRun, MachineInfo, MapperState, SessionTrack, TelemetryEnvelope } from './types.js';
import { MAPPER_SESSION_CAP, MAPPER_SESSION_EVICT_MS } from './types.js';
import { TELEMETRY_SCHEMA_VERSION } from '@patze/telemetry-core';

function nowIso(): string {
  return new Date().toISOString();
}

function makeEventId(): TelemetryEventId {
  return `evt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}` as TelemetryEventId;
}

function makeTrace(): { traceId: TraceId; spanId: SpanId } {
  return {
    traceId: `trace_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}` as TraceId,
    spanId: `span_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}` as SpanId,
  };
}

export function createMapperState(): MapperState {
  return {
    knownRuns: new Map<RunId, DetectedRun>(),
    knownSessions: new Map<SessionId, SessionTrack>(),
    emittedToolCallIds: new Set<string>(),
    emittedLogIds: new Set<string>(),
    emittedModelUsageRunIds: new Set<string>(),
  };
}

function isValidIsoTimestamp(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  return !Number.isNaN(new Date(value).getTime());
}

function toRunStateChangedEvent(
  machineId: MachineId,
  run: DetectedRun,
  from: SessionRunLifecycleState,
  to: SessionRunLifecycleState,
  isFirstSeen?: boolean
): TelemetryEnvelope {
  const ts = isFirstSeen && isValidIsoTimestamp(run.startedAt)
    ? run.startedAt!
    : nowIso();

  return {
    version: TELEMETRY_SCHEMA_VERSION,
    id: makeEventId(),
    ts,
    machineId,
    severity: 'info',
    type: 'run.state.changed',
    payload: {
      runId: run.runId,
      sessionId: run.sessionId,
      agentId: run.agentId,
      from,
      to,
    },
    trace: makeTrace(),
  };
}

export function toMachineRegisteredEvent(machine: MachineInfo): TelemetryEnvelope {
  const ts = nowIso();
  return {
    version: TELEMETRY_SCHEMA_VERSION,
    id: makeEventId(),
    ts,
    machineId: machine.machineId,
    severity: 'info',
    type: 'machine.registered',
    payload: {
      machineId: machine.machineId,
      name: machine.machineLabel,
      kind: machine.machineKind,
      status: 'online',
      registeredAt: ts,
    },
    trace: makeTrace(),
  };
}

function collectDiskStats(): { diskUsageBytes: number; diskTotalBytes: number; diskPct: number } | null {
  try {
    const stat = fs.statfsSync('/');
    const totalBytes = stat.bsize * stat.blocks;
    const freeBytes = stat.bsize * stat.bfree;
    const usedBytes = Math.max(0, totalBytes - freeBytes);
    const pct = totalBytes > 0 ? (usedBytes / totalBytes) * 100 : 0;
    return { diskUsageBytes: usedBytes, diskTotalBytes: totalBytes, diskPct: pct };
  } catch {
    return null;
  }
}

export function toMachineHeartbeatEvent(machineId: MachineId): TelemetryEnvelope {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = Math.max(0, totalMem - freeMem);
  const memoryPct = totalMem > 0 ? (usedMem / totalMem) * 100 : 0;
  const coreCount = os.cpus().length;
  const loadOneMinute = os.loadavg()[0] ?? 0;
  const cpuPct = coreCount > 0 ? Math.max(0, Math.min(100, (loadOneMinute / coreCount) * 100)) : 0;
  const disk = collectDiskStats();

  return {
    version: TELEMETRY_SCHEMA_VERSION,
    id: makeEventId(),
    ts: nowIso(),
    machineId,
    severity: 'info',
    type: 'machine.heartbeat',
    payload: {
      machineId,
      status: 'online',
      resource: {
        cpuPct,
        memoryBytes: usedMem,
        memoryPct,
        ...(disk ?? {}),
      },
    },
    trace: makeTrace(),
  };
}

function toSessionStateChangedEvent(
  machineId: MachineId,
  sessionId: SessionId,
  agentId: AgentId,
  from: SessionRunLifecycleState,
  to: SessionRunLifecycleState
): TelemetryEnvelope {
  return {
    version: TELEMETRY_SCHEMA_VERSION,
    id: makeEventId(),
    ts: nowIso(),
    machineId,
    severity: 'info',
    type: 'session.state.changed',
    payload: {
      sessionId,
      agentId,
      machineId,
      from,
      to,
    },
    trace: makeTrace(),
  };
}

function isTerminalState(state: SessionRunLifecycleState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function inferSessionEvents(
  machineId: MachineId,
  runEvents: readonly TelemetryEnvelope[],
  state: MapperState
): readonly TelemetryEnvelope[] {
  const sessionEvents: TelemetryEnvelope[] = [];

  for (const evt of runEvents) {
    if (evt.type !== 'run.state.changed') {
      continue;
    }
    const payload = evt.payload as {
      runId: RunId;
      sessionId: SessionId;
      agentId: AgentId;
      from: SessionRunLifecycleState;
      to: SessionRunLifecycleState;
    };

    const existing = state.knownSessions.get(payload.sessionId);

    // RULE 3: Late run after session terminal → ignore, do not reopen
    if (existing && isTerminalState(existing.state)) {
      continue;
    }

    if (!existing) {
      const newTrack: SessionTrack = {
        sessionId: payload.sessionId,
        agentId: payload.agentId,
        machineId,
        state: 'running',
        activeRunIds: new Set<RunId>(),
      };
      state.knownSessions.set(payload.sessionId, newTrack);
      sessionEvents.push(
        toSessionStateChangedEvent(machineId, payload.sessionId, payload.agentId, 'created', 'running')
      );
    }

    const track = state.knownSessions.get(payload.sessionId)!;
    if (isTerminalState(payload.to)) {
      track.activeRunIds.delete(payload.runId);
    } else {
      track.activeRunIds.add(payload.runId);
    }
  }

  for (const [sessionId, track] of state.knownSessions) {
    if (track.activeRunIds.size === 0 && isActiveState(track.state)) {
      const allRuns = Array.from(state.knownRuns.values()).filter(
        (r) => r.sessionId === sessionId
      );
      const anyFailed = allRuns.some((r) => r.state === 'failed');
      const terminalState: SessionRunLifecycleState = anyFailed ? 'failed' : 'completed';

      // RULE 1: Dedupe — never emit if session state is already the target
      if (track.state === terminalState) {
        continue;
      }

      sessionEvents.push(
        toSessionStateChangedEvent(track.machineId, sessionId, track.agentId, track.state, terminalState)
      );
      track.state = terminalState;
      track.terminalSince = Date.now();
    }
  }

  // RULE 2: Evict terminal sessions idle > MAPPER_SESSION_EVICT_MS + enforce cap
  evictStaleSessions(state);

  return sessionEvents;
}

/** Remove terminal sessions that have been idle past the eviction window, and enforce cap. */
function evictStaleSessions(state: MapperState): void {
  const now = Date.now();

  for (const [sessionId, track] of state.knownSessions) {
    if (
      isTerminalState(track.state) &&
      track.terminalSince !== undefined &&
      now - track.terminalSince > MAPPER_SESSION_EVICT_MS
    ) {
      state.knownSessions.delete(sessionId);
      evictRunsForSession(state, sessionId);
    }
  }

  if (state.knownSessions.size > MAPPER_SESSION_CAP) {
    const sorted = Array.from(state.knownSessions.entries())
      .filter(([, t]) => isTerminalState(t.state))
      .sort((a, b) => (a[1].terminalSince ?? Infinity) - (b[1].terminalSince ?? Infinity));

    const excess = state.knownSessions.size - MAPPER_SESSION_CAP;
    for (let i = 0; i < excess && i < sorted.length; i++) {
      const [sessionId] = sorted[i]!;
      state.knownSessions.delete(sessionId);
      evictRunsForSession(state, sessionId);
    }
  }
}

function evictRunsForSession(state: MapperState, sessionId: SessionId): void {
  for (const [runId, run] of state.knownRuns) {
    if (run.sessionId === sessionId) {
      state.knownRuns.delete(runId);
    }
  }
}

function initialFromState(to: SessionRunLifecycleState): SessionRunLifecycleState {
  if (to === 'created') {
    return 'queued';
  }
  return 'created';
}

function isActiveState(state: SessionRunLifecycleState): boolean {
  return (
    state === 'created' ||
    state === 'queued' ||
    state === 'running' ||
    state === 'waiting_tool' ||
    state === 'streaming'
  );
}

function toRunToolEvents(
  machineId: MachineId,
  run: DetectedRun,
  state: MapperState
): readonly TelemetryEnvelope[] {
  if (!run.toolCalls || run.toolCalls.length === 0) {
    return [];
  }
  const events: TelemetryEnvelope[] = [];
  for (const tc of run.toolCalls) {
    const dedupKey = `${run.runId}:${tc.toolCallId}:${tc.status}`;
    if (state.emittedToolCallIds.has(dedupKey)) {
      continue;
    }
    state.emittedToolCallIds.add(dedupKey);

    const toolCallId = tc.toolCallId as ToolCallId;
    if (tc.status === 'started') {
      events.push({
        version: TELEMETRY_SCHEMA_VERSION,
        id: makeEventId(),
        ts: tc.startedAt ?? nowIso(),
        machineId,
        severity: 'info',
        type: 'run.tool.started',
        payload: {
          runId: run.runId,
          toolCallId,
          toolName: tc.toolName,
          startedAt: tc.startedAt ?? nowIso(),
        },
        trace: makeTrace(),
      });
    } else {
      events.push({
        version: TELEMETRY_SCHEMA_VERSION,
        id: makeEventId(),
        ts: nowIso(),
        machineId,
        severity: tc.status === 'failed' ? 'error' : 'info',
        type: 'run.tool.completed',
        payload: {
          runId: run.runId,
          toolCallId,
          toolName: tc.toolName,
          status: tc.status === 'cancelled' ? 'cancelled' : tc.status === 'failed' ? 'failed' : 'completed',
          durationMs: tc.durationMs ?? 0,
          success: tc.success ?? tc.status === 'completed',
          ...(tc.errorMessage ? { errorMessage: tc.errorMessage } : {}),
        },
        trace: makeTrace(),
      });
    }
  }
  return events;
}

function toRunModelUsageEvent(
  machineId: MachineId,
  run: DetectedRun,
  state: MapperState
): TelemetryEnvelope | null {
  if (!run.modelUsage) {
    return null;
  }
  if (state.emittedModelUsageRunIds.has(run.runId)) {
    return null;
  }
  state.emittedModelUsageRunIds.add(run.runId);

  return {
    version: TELEMETRY_SCHEMA_VERSION,
    id: makeEventId(),
    ts: nowIso(),
    machineId,
    severity: 'info',
    type: 'run.model.usage',
    payload: {
      runId: run.runId,
      machineId,
      provider: run.modelUsage.provider,
      model: run.modelUsage.model,
      inputTokens: run.modelUsage.inputTokens,
      outputTokens: run.modelUsage.outputTokens,
      totalTokens: run.modelUsage.totalTokens,
      ...(run.modelUsage.estimatedCostUsd !== undefined ? { estimatedCostUsd: run.modelUsage.estimatedCostUsd } : {}),
      measuredAt: nowIso(),
    },
    trace: makeTrace(),
  };
}

function toRunLogEvents(
  machineId: MachineId,
  run: DetectedRun,
  state: MapperState
): readonly TelemetryEnvelope[] {
  if (!run.logs || run.logs.length === 0) {
    return [];
  }
  const events: TelemetryEnvelope[] = [];
  for (const log of run.logs) {
    const dedupKey = `${run.runId}:${log.id}`;
    if (state.emittedLogIds.has(dedupKey)) {
      continue;
    }
    state.emittedLogIds.add(dedupKey);

    events.push({
      version: TELEMETRY_SCHEMA_VERSION,
      id: makeEventId(),
      ts: log.ts,
      machineId,
      severity: log.level,
      type: 'run.log.emitted',
      payload: {
        logEntryId: log.id as LogEntryId,
        runId: run.runId,
        sessionId: run.sessionId,
        level: log.level,
        message: log.message,
        ts: log.ts,
      },
      trace: makeTrace(),
    });
  }
  return events;
}

export function mapRunStateChangedEvents(
  machineId: MachineId,
  activeRuns: readonly DetectedRun[],
  state: MapperState
): readonly TelemetryEnvelope[] {
  const events: TelemetryEnvelope[] = [];
  const seenRunIds = new Set<RunId>();

  for (const run of activeRuns) {
    seenRunIds.add(run.runId);
    const previous = state.knownRuns.get(run.runId);

    // RULE 1: Dedupe — skip if state unchanged
    if (previous?.state === run.state) {
      events.push(...toRunToolEvents(machineId, run, state));
      events.push(...toRunLogEvents(machineId, run, state));
      const modelEvt = toRunModelUsageEvent(machineId, run, state);
      if (modelEvt) { events.push(modelEvt); }
      state.knownRuns.set(run.runId, run);
      continue;
    }

    // RULE 3: If a run reappears after being terminal, ignore (don't resurrect)
    if (previous && isTerminalState(previous.state)) {
      continue;
    }

    const from = previous?.state ?? initialFromState(run.state);
    const to = run.state;

    // RULE 1: Final guard — from === to means no-op
    if (from === to) {
      continue;
    }

    events.push(toRunStateChangedEvent(machineId, run, from, to, !previous));
    events.push(...toRunToolEvents(machineId, run, state));
    events.push(...toRunLogEvents(machineId, run, state));
    const modelEvt = toRunModelUsageEvent(machineId, run, state);
    if (modelEvt) { events.push(modelEvt); }
    state.knownRuns.set(run.runId, run);
  }

  for (const [runId, knownRun] of Array.from(state.knownRuns.entries())) {
    if (!seenRunIds.has(runId) && isActiveState(knownRun.state)) {
      events.push(toRunStateChangedEvent(machineId, knownRun, knownRun.state, 'completed'));
      state.knownRuns.delete(runId);
    }
  }

  const sessionEvents = inferSessionEvents(machineId, events, state);
  return [...events, ...sessionEvents];
}
