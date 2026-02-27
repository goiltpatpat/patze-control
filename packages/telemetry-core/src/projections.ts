import type {
  AgentId,
  IsoUtcTimestamp,
  MachineId,
  RunId,
  SessionId,
  SessionRunLifecycleState,
} from './types.js';
import type { AnyTelemetryEvent } from './events.js';
import type { EventStore } from './event-store.js';

type ProjectionEventId = AnyTelemetryEvent['id'];

export interface MachineResourceSnapshot {
  cpuPct: number;
  memoryBytes: number;
  memoryTotalBytes?: number;
  memoryPct: number;
  netRxBytes?: number;
  netTxBytes?: number;
  diskUsageBytes?: number;
  diskTotalBytes?: number;
  diskPct?: number;
}

export interface MachineProjection {
  id: MachineId;
  name?: string;
  kind?: 'local' | 'vps';
  status: 'online' | 'offline' | 'degraded';
  lastSeenAt: IsoUtcTimestamp;
  lastEventId: ProjectionEventId;
  lastResource?: MachineResourceSnapshot;
}

export interface SessionProjection {
  id: SessionId;
  machineId: MachineId;
  agentId: AgentId;
  state: SessionRunLifecycleState;
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
  endedAt?: IsoUtcTimestamp;
  lastEventId: ProjectionEventId;
}

export interface RunProjection {
  id: RunId;
  sessionId: SessionId;
  machineId: MachineId;
  agentId: AgentId;
  state: SessionRunLifecycleState;
  createdAt: IsoUtcTimestamp;
  updatedAt: IsoUtcTimestamp;
  endedAt?: IsoUtcTimestamp;
  failureReason?: string;
  lastEventId: ProjectionEventId;
}

interface ProjectionState {
  machines: Map<MachineId, MachineProjection>;
  sessions: Map<SessionId, SessionProjection>;
  runs: Map<RunId, RunProjection>;
}

export interface TelemetrySnapshot {
  machines: ReadonlyMap<MachineId, Readonly<MachineProjection>>;
  sessions: ReadonlyMap<SessionId, Readonly<SessionProjection>>;
  runs: ReadonlyMap<RunId, Readonly<RunProjection>>;
}

function createEmptyState(): ProjectionState {
  return {
    machines: new Map<MachineId, MachineProjection>(),
    sessions: new Map<SessionId, SessionProjection>(),
    runs: new Map<RunId, RunProjection>(),
  };
}

function freezeProjection<T extends object>(projection: T): Readonly<T> {
  return Object.freeze({ ...projection });
}

function toReadonlySnapshot(state: ProjectionState): TelemetrySnapshot {
  const machines = new Map<MachineId, Readonly<MachineProjection>>();
  for (const [id, machine] of state.machines) {
    machines.set(id, freezeProjection(machine));
  }

  const sessions = new Map<SessionId, Readonly<SessionProjection>>();
  for (const [id, session] of state.sessions) {
    sessions.set(id, freezeProjection(session));
  }

  const runs = new Map<RunId, Readonly<RunProjection>>();
  for (const [id, run] of state.runs) {
    runs.set(id, freezeProjection(run));
  }

  return { machines, sessions, runs };
}

function isTerminalState(state: SessionRunLifecycleState): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled';
}

function reduceMachineEvent(state: ProjectionState, event: Readonly<AnyTelemetryEvent>): void {
  if (event.type === 'machine.registered') {
    const payload = event.payload;

    const next: MachineProjection = {
      id: payload.machineId,
      name: payload.name,
      kind: payload.kind,
      status: payload.status,
      lastSeenAt: payload.registeredAt,
      lastEventId: event.id,
    };

    state.machines.set(payload.machineId, next);
    return;
  }

  if (event.type === 'machine.heartbeat') {
    const payload = event.payload;
    const current = state.machines.get(payload.machineId);

    const next: MachineProjection = {
      id: payload.machineId,
      status: payload.status,
      lastSeenAt: event.ts,
      lastEventId: event.id,
      ...(current?.name ? { name: current.name } : {}),
      ...(current?.kind ? { kind: current.kind } : {}),
      lastResource: {
        cpuPct: payload.resource.cpuPct,
        memoryBytes: payload.resource.memoryBytes,
        memoryPct: payload.resource.memoryPct,
        ...(payload.resource.memoryTotalBytes !== undefined
          ? { memoryTotalBytes: payload.resource.memoryTotalBytes }
          : {}),
        ...(payload.resource.netRxBytes !== undefined
          ? { netRxBytes: payload.resource.netRxBytes }
          : {}),
        ...(payload.resource.netTxBytes !== undefined
          ? { netTxBytes: payload.resource.netTxBytes }
          : {}),
        ...(payload.resource.diskUsageBytes !== undefined
          ? { diskUsageBytes: payload.resource.diskUsageBytes }
          : {}),
        ...(payload.resource.diskTotalBytes !== undefined
          ? { diskTotalBytes: payload.resource.diskTotalBytes }
          : {}),
        ...(payload.resource.diskPct !== undefined ? { diskPct: payload.resource.diskPct } : {}),
      },
    };

    state.machines.set(payload.machineId, next);
  }
}

function reduceSessionEvent(state: ProjectionState, event: Readonly<AnyTelemetryEvent>): void {
  if (event.type !== 'session.state.changed') {
    return;
  }

  const payload = event.payload;
  const current = state.sessions.get(payload.sessionId);

  const next: SessionProjection = {
    id: payload.sessionId,
    machineId: payload.machineId,
    agentId: payload.agentId,
    state: payload.to,
    createdAt: current?.createdAt ?? event.ts,
    updatedAt: event.ts,
    lastEventId: event.id,
    ...(isTerminalState(payload.to) ? { endedAt: event.ts } : {}),
  };

  state.sessions.set(payload.sessionId, next);
}

function reduceRunEvent(state: ProjectionState, event: Readonly<AnyTelemetryEvent>): void {
  if (event.type !== 'run.state.changed') {
    return;
  }

  const payload = event.payload;
  const current = state.runs.get(payload.runId);

  const next: RunProjection = {
    id: payload.runId,
    sessionId: payload.sessionId,
    machineId: event.machineId,
    agentId: payload.agentId,
    state: payload.to,
    createdAt: current?.createdAt ?? event.ts,
    updatedAt: event.ts,
    lastEventId: event.id,
    ...(isTerminalState(payload.to) ? { endedAt: event.ts } : {}),
    ...(payload.to === 'failed' && payload.reason ? { failureReason: payload.reason } : {}),
  };

  state.runs.set(payload.runId, next);
}

function reduceEvent(state: ProjectionState, event: Readonly<AnyTelemetryEvent>): void {
  reduceMachineEvent(state, event);
  reduceSessionEvent(state, event);
  reduceRunEvent(state, event);
}

export function buildTelemetrySnapshot(
  events: readonly Readonly<AnyTelemetryEvent>[]
): TelemetrySnapshot {
  const state = createEmptyState();

  for (const event of events) {
    reduceEvent(state, event);
  }

  return toReadonlySnapshot(state);
}

export class TelemetryProjector {
  private readonly state: ProjectionState;

  public constructor() {
    this.state = createEmptyState();
  }

  public ingest(event: Readonly<AnyTelemetryEvent>): void {
    reduceEvent(this.state, event);
  }

  public ingestMany(events: readonly Readonly<AnyTelemetryEvent>[]): void {
    for (const event of events) {
      this.ingest(event);
    }
  }

  public snapshot(): TelemetrySnapshot {
    return toReadonlySnapshot(this.state);
  }

  public bindToStore(store: EventStore): () => void {
    const listener = (event: Readonly<AnyTelemetryEvent>): void => {
      this.ingest(event);
    };

    store.subscribe(listener);

    return (): void => {
      store.unsubscribe(listener);
    };
  }
}
