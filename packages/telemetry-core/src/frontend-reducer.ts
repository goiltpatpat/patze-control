import type { AnyTelemetryEvent } from './events.js';
import type {
  FrontendActiveRunSnapshot,
  FrontendHealthIndicators,
  FrontendHealthStatus,
  FrontendLogSnapshot,
  FrontendMachineHealthIndicator,
  FrontendMachineSnapshot,
  FrontendModelUsageSnapshot,
  FrontendRecentEvent,
  FrontendRunDetailSnapshot,
  FrontendRunSnapshot,
  FrontendSessionSnapshot,
  FrontendToolCallSnapshot,
  FrontendUnifiedSnapshot,
} from './frontend-snapshot.js';
import type { IsoUtcTimestamp, SessionRunLifecycleState } from './types.js';
import { deepFreeze } from './utils.js';

export type FrontendReducerState = Readonly<FrontendUnifiedSnapshot>;

export interface FrontendReducerContext {
  receivedAt: IsoUtcTimestamp;
}

export interface FrontendReducerInitContext {
  initializedAt: IsoUtcTimestamp;
}

export type InitializeFrontendSnapshot = (
  initial: FrontendReducerState,
  context: Readonly<FrontendReducerInitContext>
) => FrontendUnifiedSnapshot;

export type ReduceFrontendSnapshot = (
  current: FrontendReducerState,
  event: Readonly<AnyTelemetryEvent>,
  context: Readonly<FrontendReducerContext>
) => FrontendUnifiedSnapshot;

export type ReduceFrontendSnapshotMany = (
  current: FrontendReducerState,
  events: readonly Readonly<AnyTelemetryEvent>[],
  context: Readonly<FrontendReducerContext>
) => FrontendUnifiedSnapshot;

export interface FrontendSnapshotReducerContract {
  initialize: InitializeFrontendSnapshot;
  reduce: ReduceFrontendSnapshot;
  reduceMany: ReduceFrontendSnapshotMany;
}

type ActiveRunState = Exclude<SessionRunLifecycleState, 'completed' | 'failed' | 'cancelled'>;

const MAX_RECENT_EVENTS = 50;
const MAX_TOOL_CALLS_PER_RUN = 50;
const MAX_LOGS = 200;

interface SnapshotCollections {
  machines: Map<string, FrontendMachineSnapshot>;
  sessions: Map<string, FrontendSessionSnapshot>;
  runs: Map<string, FrontendRunSnapshot>;
  runDetails: Map<string, MutableRunDetail>;
  logs: FrontendLogSnapshot[];
  recentEvents: FrontendRecentEvent[];
}

interface MutableRunDetail {
  runId: string;
  toolCalls: Map<string, FrontendToolCallSnapshot>;
  modelUsage: FrontendModelUsageSnapshot | undefined;
}

export const FRONTEND_ACTIVE_STATES = Object.freeze([
  'created',
  'queued',
  'running',
  'waiting_tool',
  'streaming',
] as const satisfies readonly SessionRunLifecycleState[]);

const ACTIVE_STATES: ReadonlySet<SessionRunLifecycleState> = new Set(FRONTEND_ACTIVE_STATES);

function maxIsoTimestamp(left: IsoUtcTimestamp, right: IsoUtcTimestamp): IsoUtcTimestamp {
  return left >= right ? left : right;
}

function normalizeIsoTimestamp(
  candidate: IsoUtcTimestamp,
  fallback: IsoUtcTimestamp
): IsoUtcTimestamp {
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    return fallback;
  }

  return parsed.toISOString();
}

function compareByIdAsc<T extends { machineId?: string; sessionId?: string; runId?: string }>(
  left: T,
  right: T
): number {
  const leftId = left.machineId ?? left.sessionId ?? left.runId ?? '';
  const rightId = right.machineId ?? right.sessionId ?? right.runId ?? '';
  return leftId.localeCompare(rightId);
}

function compareSessions(left: FrontendSessionSnapshot, right: FrontendSessionSnapshot): number {
  const ts = right.updatedAt.localeCompare(left.updatedAt);
  if (ts !== 0) {
    return ts;
  }
  return left.sessionId.localeCompare(right.sessionId);
}

function compareRuns(left: FrontendRunSnapshot, right: FrontendRunSnapshot): number {
  const ts = right.updatedAt.localeCompare(left.updatedAt);
  if (ts !== 0) {
    return ts;
  }
  return left.runId.localeCompare(right.runId);
}

function isActiveRunState(state: SessionRunLifecycleState): state is ActiveRunState {
  return ACTIVE_STATES.has(state);
}

function machineStatusToHealth(status: FrontendMachineSnapshot['status']): FrontendHealthStatus {
  if (status === 'online') {
    return 'healthy';
  }

  if (status === 'degraded') {
    return 'degraded';
  }

  return 'critical';
}

function freezeArray<T>(values: readonly T[]): readonly T[] {
  return deepFreeze([...values]);
}

function freezeObject<T extends object>(value: T): Readonly<T> {
  return deepFreeze(value);
}

function createCollections(snapshot: FrontendReducerState): SnapshotCollections {
  const runDetails = new Map<string, MutableRunDetail>();
  for (const [runId, detail] of Object.entries(snapshot.runDetails)) {
    const mrd: MutableRunDetail = {
      runId,
      toolCalls: new Map(detail.toolCalls.map((tc) => [tc.toolCallId, tc])),
      modelUsage: detail.modelUsage ? { ...detail.modelUsage } : undefined,
    };
    runDetails.set(runId, mrd);
  }

  return {
    machines: new Map(snapshot.machines.map((machine) => [machine.machineId, machine])),
    sessions: new Map(snapshot.sessions.map((session) => [session.sessionId, session])),
    runs: new Map(snapshot.runs.map((run) => [run.runId, run])),
    runDetails,
    logs: [...snapshot.logs],
    recentEvents: [...snapshot.recentEvents],
  };
}

function upsertFromEvent(collections: SnapshotCollections, event: Readonly<AnyTelemetryEvent>): boolean {
  if (event.type === 'machine.registered') {
    const payload = event.payload;
    const machineId = String(payload.machineId);
    const registeredAt = normalizeIsoTimestamp(payload.registeredAt, event.ts);

    const machine: FrontendMachineSnapshot = freezeObject({
      machineId,
      name: payload.name,
      kind: payload.kind,
      status: payload.status,
      lastSeenAt: registeredAt,
      lastEventId: event.id,
    });

    collections.machines.set(machineId, machine);
    return true;
  }

  if (event.type === 'machine.heartbeat') {
    const payload = event.payload;
    const machineId = String(payload.machineId);
    const current = collections.machines.get(machineId);

    const machine: FrontendMachineSnapshot = freezeObject({
      machineId,
      status: payload.status,
      lastSeenAt: event.ts,
      lastEventId: event.id,
      ...(current?.name !== undefined ? { name: current.name } : {}),
      ...(current?.kind !== undefined ? { kind: current.kind } : {}),
      lastResource: {
        cpuPct: payload.resource.cpuPct,
        memoryBytes: payload.resource.memoryBytes,
        memoryPct: payload.resource.memoryPct,
      },
    });

    collections.machines.set(machineId, machine);
    return true;
  }

  if (event.type === 'session.state.changed') {
    const payload = event.payload;
    const sessionId = String(payload.sessionId);
    const current = collections.sessions.get(sessionId);

    const session: FrontendSessionSnapshot = freezeObject({
      sessionId,
      machineId: String(payload.machineId),
      agentId: payload.agentId,
      state: payload.to,
      createdAt: current?.createdAt ?? event.ts,
      updatedAt: event.ts,
      lastEventId: event.id,
      ...(payload.to === 'completed' || payload.to === 'failed' || payload.to === 'cancelled'
        ? { endedAt: event.ts }
        : {}),
    });

    collections.sessions.set(sessionId, session);
    return true;
  }

  if (event.type === 'run.state.changed') {
    const payload = event.payload;
    const runId = String(payload.runId);
    const current = collections.runs.get(runId);

    const run: FrontendRunSnapshot = freezeObject({
      runId,
      sessionId: String(payload.sessionId),
      machineId: String(event.machineId),
      agentId: payload.agentId,
      state: payload.to,
      createdAt: current?.createdAt ?? event.ts,
      updatedAt: event.ts,
      lastEventId: event.id,
      ...(payload.to === 'completed' || payload.to === 'failed' || payload.to === 'cancelled'
        ? { endedAt: event.ts }
        : {}),
      ...(payload.to === 'failed' && payload.reason ? { failureReason: payload.reason } : {}),
    });

    collections.runs.set(runId, run);
    return true;
  }

  if (event.type === 'run.tool.started') {
    const payload = event.payload;
    const runId = String(payload.runId);
    const detail = getOrCreateRunDetail(collections, runId);
    const tc: FrontendToolCallSnapshot = {
      toolCallId: String(payload.toolCallId),
      toolName: payload.toolName,
      status: 'started',
      startedAt: payload.startedAt,
    };
    detail.toolCalls.set(tc.toolCallId, tc);
    trimToolCalls(detail);
    return true;
  }

  if (event.type === 'run.tool.completed') {
    const payload = event.payload;
    const runId = String(payload.runId);
    const detail = getOrCreateRunDetail(collections, runId);
    const existing = detail.toolCalls.get(String(payload.toolCallId));
    const toolStatus = payload.status === 'completed' ? 'completed' as const : payload.status === 'failed' ? 'failed' as const : 'cancelled' as const;
    const tc: FrontendToolCallSnapshot = {
      toolCallId: String(payload.toolCallId),
      toolName: payload.toolName,
      status: toolStatus,
      startedAt: existing?.startedAt ?? event.ts,
      durationMs: payload.durationMs,
      success: payload.success,
      ...(payload.errorMessage !== undefined ? { errorMessage: payload.errorMessage } : {}),
    };
    detail.toolCalls.set(tc.toolCallId, tc);
    return true;
  }

  if (event.type === 'run.model.usage') {
    const payload = event.payload;
    const runId = String(payload.runId);
    const detail = getOrCreateRunDetail(collections, runId);
    const existing = detail.modelUsage;
    const newUsage: FrontendModelUsageSnapshot = {
      provider: payload.provider,
      model: payload.model,
      inputTokens: (existing?.inputTokens ?? 0) + payload.inputTokens,
      outputTokens: (existing?.outputTokens ?? 0) + payload.outputTokens,
      totalTokens: (existing?.totalTokens ?? 0) + payload.totalTokens,
    };
    if (payload.estimatedCostUsd !== undefined) {
      newUsage.estimatedCostUsd = (existing?.estimatedCostUsd ?? 0) + payload.estimatedCostUsd;
    }
    detail.modelUsage = newUsage;
    return true;
  }

  if (event.type === 'run.log.emitted') {
    const payload = event.payload;
    const logEntry: FrontendLogSnapshot = {
      id: String(payload.logEntryId),
      runId: String(payload.runId),
      sessionId: String(payload.sessionId),
      machineId: String(event.machineId),
      level: payload.level,
      message: payload.message,
      ts: payload.ts,
    };
    collections.logs.push(logEntry);
    if (collections.logs.length > MAX_LOGS) {
      collections.logs = collections.logs.slice(-MAX_LOGS);
    }
    return true;
  }

  return false;
}

function getOrCreateRunDetail(collections: SnapshotCollections, runId: string): MutableRunDetail {
  const existing = collections.runDetails.get(runId);
  if (existing) {
    return existing;
  }
  const detail: MutableRunDetail = { runId, toolCalls: new Map(), modelUsage: undefined };
  collections.runDetails.set(runId, detail);
  return detail;
}

function trimToolCalls(detail: MutableRunDetail): void {
  if (detail.toolCalls.size <= MAX_TOOL_CALLS_PER_RUN) {
    return;
  }
  const sorted = Array.from(detail.toolCalls.values()).sort((a, b) =>
    a.startedAt.localeCompare(b.startedAt)
  );
  const excess = sorted.length - MAX_TOOL_CALLS_PER_RUN;
  for (let i = 0; i < excess; i++) {
    detail.toolCalls.delete(sorted[i]!.toolCallId);
  }
}

function summarizeEvent(event: Readonly<AnyTelemetryEvent>): string {
  switch (event.type) {
    case 'machine.registered': return `Machine ${String(event.payload.machineId)} registered`;
    case 'machine.heartbeat': return `Heartbeat from ${String(event.payload.machineId)}`;
    case 'run.state.changed': return `Run ${String(event.payload.runId)}: ${String(event.payload.from)} → ${String(event.payload.to)}`;
    case 'session.state.changed': return `Session ${String(event.payload.sessionId)}: ${String(event.payload.from)} → ${String(event.payload.to)}`;
    case 'run.tool.started': return `Tool ${String(event.payload.toolName)} started`;
    case 'run.tool.completed': return `Tool ${String(event.payload.toolName)} ${String(event.payload.status)}`;
    case 'run.model.usage': return `${String(event.payload.model)}: ${String(event.payload.totalTokens)} tokens`;
    case 'run.log.emitted': return String(event.payload.message).slice(0, 80);
    case 'agent.state.changed': return `Agent ${String(event.payload.agentId)}: ${String(event.payload.from)} → ${String(event.payload.to)}`;
    case 'run.resource.usage': return `Resource usage: CPU ${String(event.payload.cpuPct)}%`;
    case 'trace.span.recorded': return `Trace span: ${String(event.payload.name)}`;
  }
}

function appendRecentEvent(collections: SnapshotCollections, event: Readonly<AnyTelemetryEvent>): void {
  if (event.type === 'machine.heartbeat') {
    return;
  }

  const recent: FrontendRecentEvent = {
    id: String(event.id),
    ts: event.ts,
    type: event.type,
    machineId: String(event.machineId),
    summary: summarizeEvent(event),
  };

  collections.recentEvents.push(recent);

  if (collections.recentEvents.length > MAX_RECENT_EVENTS) {
    collections.recentEvents = collections.recentEvents.slice(-MAX_RECENT_EVENTS);
  }
}

function buildHealth(
  machines: readonly FrontendMachineSnapshot[],
  activeRuns: readonly FrontendActiveRunSnapshot[],
  runs: readonly FrontendRunSnapshot[]
): Readonly<FrontendHealthIndicators> {
  const activeRunCountByMachine = new Map<string, number>();
  for (const run of activeRuns) {
    const current = activeRunCountByMachine.get(run.machineId) ?? 0;
    activeRunCountByMachine.set(run.machineId, current + 1);
  }

  const machineIndicators: FrontendMachineHealthIndicator[] = machines
    .map((machine) =>
      freezeObject({
        machineId: machine.machineId,
        status: machineStatusToHealth(machine.status),
        activeRunCount: activeRunCountByMachine.get(machine.machineId) ?? 0,
        lastSeenAt: machine.lastSeenAt,
      })
    )
    .sort(compareByIdAsc);

  const failedRunsTotal = runs.filter((run) => run.state === 'failed').length;
  const activeRunsTotal = activeRuns.length;

  let overall: FrontendHealthStatus = 'unknown';
  if (machines.length > 0) {
    const hasCritical = machineIndicators.some((indicator) => indicator.status === 'critical');
    const hasDegraded = machineIndicators.some((indicator) => indicator.status === 'degraded');

    if (hasCritical || failedRunsTotal > 0) {
      overall = 'critical';
    } else if (hasDegraded) {
      overall = 'degraded';
    } else {
      overall = 'healthy';
    }
  }

  return freezeObject({
    overall,
    machines: freezeArray(machineIndicators),
    activeRunsTotal,
    failedRunsTotal,
    staleMachinesTotal: 0,
  });
}

function buildSnapshot(
  collections: SnapshotCollections,
  lastUpdated: IsoUtcTimestamp
): FrontendUnifiedSnapshot {
  const machines = freezeArray(
    Array.from(collections.machines.values())
      .map((machine) => freezeObject({ ...machine }))
      .sort(compareByIdAsc)
  );

  const sessions = freezeArray(
    Array.from(collections.sessions.values())
      .map((session) => freezeObject({ ...session }))
      .sort(compareSessions)
  );

  const runs = freezeArray(
    Array.from(collections.runs.values())
      .map((run) => freezeObject({ ...run }))
      .sort(compareRuns)
  );

  const activeRuns = freezeArray(
    runs
      .filter((run): run is FrontendRunSnapshot & { state: ActiveRunState } =>
        isActiveRunState(run.state)
      )
      .map((run) =>
        freezeObject({
          ...run,
          isActive: true as const,
          state: run.state,
        }) as FrontendActiveRunSnapshot
      )
      .sort(compareRuns)
  );

  const runDetailsRecord: Record<string, Readonly<FrontendRunDetailSnapshot>> = {};
  for (const [runId, detail] of collections.runDetails) {
    const toolCalls = Array.from(detail.toolCalls.values())
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    runDetailsRecord[runId] = freezeObject({
      runId,
      toolCalls: freezeArray(toolCalls.map((tc) => freezeObject({ ...tc }))),
      ...(detail.modelUsage ? { modelUsage: freezeObject({ ...detail.modelUsage }) } : {}),
    });
  }

  return freezeObject({
    machines,
    sessions,
    runs,
    activeRuns,
    health: buildHealth(machines, activeRuns, runs),
    runDetails: freezeObject(runDetailsRecord),
    logs: freezeArray(collections.logs.map((l) => freezeObject({ ...l }))),
    recentEvents: freezeArray(collections.recentEvents.map((e) => freezeObject({ ...e }))),
    lastUpdated,
  });
}

export const initializeFrontendSnapshot: InitializeFrontendSnapshot = (
  initial,
  context
): FrontendUnifiedSnapshot => {
  const collections = createCollections(initial);
  const fallback = normalizeIsoTimestamp(context.initializedAt, context.initializedAt);
  const lastUpdated =
    initial.lastUpdated.length > 0
      ? normalizeIsoTimestamp(initial.lastUpdated, fallback)
      : fallback;
  return buildSnapshot(collections, lastUpdated);
};

export const reduceFrontendSnapshot: ReduceFrontendSnapshot = (
  current,
  event,
  _context
): FrontendUnifiedSnapshot => {
  const collections = createCollections(current);
  const changed = upsertFromEvent(collections, event);
  appendRecentEvent(collections, event);

  if (!changed && collections.recentEvents.length === current.recentEvents.length) {
    return current;
  }

  const normalizedEventTs = normalizeIsoTimestamp(event.ts, current.lastUpdated);
  const lastUpdated = maxIsoTimestamp(current.lastUpdated, normalizedEventTs);
  return buildSnapshot(collections, lastUpdated);
};

export const reduceFrontendSnapshotMany: ReduceFrontendSnapshotMany = (
  current,
  events,
  _context
): FrontendUnifiedSnapshot => {
  const collections = createCollections(current);
  let lastUpdated = current.lastUpdated;
  let changed = false;

  for (const event of events) {
    const updated = upsertFromEvent(collections, event);
    appendRecentEvent(collections, event);
    if (!updated) {
      continue;
    }

    changed = true;
    const normalizedEventTs = normalizeIsoTimestamp(event.ts, lastUpdated);
    lastUpdated = maxIsoTimestamp(lastUpdated, normalizedEventTs);
  }

  if (!changed && collections.recentEvents.length === current.recentEvents.length) {
    return current;
  }

  return buildSnapshot(collections, lastUpdated);
};

export const frontendSnapshotReducer: FrontendSnapshotReducerContract = {
  initialize: initializeFrontendSnapshot,
  reduce: reduceFrontendSnapshot,
  reduceMany: reduceFrontendSnapshotMany,
};
