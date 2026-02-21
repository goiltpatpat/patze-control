import type { AnyTelemetryEvent } from './events.js';
import type { TelemetryEventListener } from './event-bus.js';
import { buildTelemetrySnapshot, type MachineProjection, type RunProjection, type SessionProjection } from './projections.js';
import { TelemetryNode } from './telemetry-node.js';
import type { SessionRunLifecycleState } from './types.js';

export type MachineReadModel = Omit<MachineProjection, 'id'> & {
  machineId: string;
};

export type SessionReadModel = Omit<SessionProjection, 'id' | 'machineId'> & {
  sessionId: string;
  machineId: string;
};

export type RunReadModel = Omit<RunProjection, 'id' | 'sessionId' | 'machineId'> & {
  runId: string;
  sessionId: string;
  machineId: string;
};

export interface UnifiedTelemetrySnapshot {
  machines: Readonly<Record<string, Readonly<MachineReadModel>>>;
  sessions: Readonly<Record<string, Readonly<SessionReadModel>>>;
  runs: Readonly<Record<string, Readonly<RunReadModel>>>;
  sessionsByMachineId: Readonly<Record<string, readonly string[]>>;
  runsBySessionId: Readonly<Record<string, readonly string[]>>;
  activeRunsByMachineId: Readonly<Record<string, readonly string[]>>;
}

export type UnifiedSnapshotListener = (snapshot: UnifiedTelemetrySnapshot) => void;

interface NodeAttachment {
  readonly nodeId: string;
  readonly node: TelemetryNode;
  readonly log: AnyTelemetryEvent[];
  readonly eventIds: Set<string>;
  unsubscribe: () => void;
}

interface OrderedEvent {
  nodeId: string;
  localIndex: number;
  event: Readonly<AnyTelemetryEvent>;
}

const ACTIVE_STATES: ReadonlySet<SessionRunLifecycleState> = new Set([
  'created',
  'queued',
  'running',
  'waiting_tool',
  'streaming',
]);

function freezeRecord<T>(input: Record<string, T>): Readonly<Record<string, T>> {
  return Object.freeze(input);
}

function freezeArray(values: string[]): readonly string[] {
  return Object.freeze(values);
}

function toSortedRecord<T>(entries: Array<[string, T]>): Record<string, T> {
  const sorted = entries.sort((a, b) => a[0].localeCompare(b[0]));
  const record: Record<string, T> = {};
  for (const [key, value] of sorted) {
    record[key] = value;
  }
  return record;
}

function createEmptyUnifiedSnapshot(): UnifiedTelemetrySnapshot {
  return {
    machines: freezeRecord({}),
    sessions: freezeRecord({}),
    runs: freezeRecord({}),
    sessionsByMachineId: freezeRecord({}),
    runsBySessionId: freezeRecord({}),
    activeRunsByMachineId: freezeRecord({}),
  };
}

function stringifyId(id: unknown): string {
  return String(id);
}

function compareOrderedEvents(left: OrderedEvent, right: OrderedEvent): number {
  const tsCompare = left.event.ts.localeCompare(right.event.ts);
  if (tsCompare !== 0) {
    return tsCompare;
  }

  const idCompare = stringifyId(left.event.id).localeCompare(stringifyId(right.event.id));
  if (idCompare !== 0) {
    return idCompare;
  }

  const nodeCompare = left.nodeId.localeCompare(right.nodeId);
  if (nodeCompare !== 0) {
    return nodeCompare;
  }

  return left.localIndex - right.localIndex;
}

function appendIndexEntry(index: Map<string, string[]>, key: string, value: string): void {
  const existing = index.get(key);
  if (existing) {
    existing.push(value);
    return;
  }
  index.set(key, [value]);
}

export class TelemetryAggregator {
  private readonly attachments = new Map<string, NodeAttachment>();

  private readonly listeners = new Set<UnifiedSnapshotListener>();

  private readonly eventListeners = new Set<TelemetryEventListener>();

  private unifiedSnapshot: UnifiedTelemetrySnapshot = createEmptyUnifiedSnapshot();

  public attachNode(nodeId: string, node: TelemetryNode): void {
    if (this.attachments.has(nodeId)) {
      throw new Error(`Telemetry node '${nodeId}' is already attached.`);
    }

    const attachment: NodeAttachment = {
      nodeId,
      node,
      log: [],
      eventIds: new Set<string>(),
      unsubscribe: () => {
        // no-op until subscription is established
      },
    };

    this.attachments.set(nodeId, attachment);

    const onEvent = (event: Readonly<AnyTelemetryEvent>): void => {
      if (this.appendEvent(attachment, event)) {
        this.emitEvent(event);
        this.recomputeAndNotify();
      }
    };

    attachment.unsubscribe = node.subscribe(onEvent);

    const initialLog = node.getEventLog();
    let changed = false;
    for (const event of initialLog) {
      if (this.appendEvent(attachment, event)) {
        changed = true;
      }
    }

    if (changed || initialLog.length === 0) {
      this.recomputeAndNotify();
    }
  }

  public detachNode(nodeId: string): void {
    const attachment = this.attachments.get(nodeId);
    if (!attachment) {
      return;
    }

    attachment.unsubscribe();
    this.attachments.delete(nodeId);
    this.recomputeAndNotify();
  }

  public listNodes(): readonly string[] {
    return Object.freeze(Array.from(this.attachments.keys()).sort((a, b) => a.localeCompare(b)));
  }

  public getUnifiedSnapshot(): UnifiedTelemetrySnapshot {
    return this.unifiedSnapshot;
  }

  public subscribeUnified(listener: UnifiedSnapshotListener): () => void {
    this.listeners.add(listener);
    listener(this.unifiedSnapshot);

    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public subscribeEvents(listener: TelemetryEventListener): () => void {
    this.eventListeners.add(listener);

    return (): void => {
      this.eventListeners.delete(listener);
    };
  }

  private emitEvent(event: Readonly<AnyTelemetryEvent>): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event);
      } catch {
        // Prevent a failing listener from blocking others.
      }
    }
  }

  private appendEvent(attachment: NodeAttachment, event: Readonly<AnyTelemetryEvent>): boolean {
    const eventId = stringifyId(event.id);
    if (attachment.eventIds.has(eventId)) {
      return false;
    }

    attachment.eventIds.add(eventId);
    attachment.log.push(event);
    return true;
  }

  private recomputeAndNotify(): void {
    this.unifiedSnapshot = this.computeUnifiedSnapshot();

    for (const listener of this.listeners) {
      listener(this.unifiedSnapshot);
    }
  }

  private computeUnifiedSnapshot(): UnifiedTelemetrySnapshot {
    if (this.attachments.size === 0) {
      return createEmptyUnifiedSnapshot();
    }

    const orderedEvents: OrderedEvent[] = [];
    const orderedNodeIds = Array.from(this.attachments.keys()).sort((a, b) => a.localeCompare(b));

    for (const nodeId of orderedNodeIds) {
      const attachment = this.attachments.get(nodeId);
      if (!attachment) {
        continue;
      }

      for (let index = 0; index < attachment.log.length; index += 1) {
        const event = attachment.log[index];
        if (!event) {
          continue;
        }
        orderedEvents.push({
          nodeId,
          localIndex: index,
          event,
        });
      }
    }

    orderedEvents.sort(compareOrderedEvents);

    const mergedEvents = orderedEvents.map((entry) => entry.event);
    const snapshot = buildTelemetrySnapshot(mergedEvents);

    const machineEntries: Array<[string, Readonly<MachineReadModel>]> = [];
    for (const [machineId, machine] of snapshot.machines) {
      const key = stringifyId(machineId);
      const readModel: MachineReadModel = {
        ...machine,
        machineId: key,
      };
      machineEntries.push([key, Object.freeze(readModel)]);
    }

    const sessionEntries: Array<[string, Readonly<SessionReadModel>]> = [];
    for (const [sessionId, session] of snapshot.sessions) {
      const key = stringifyId(sessionId);
      const readModel: SessionReadModel = {
        ...session,
        sessionId: key,
        machineId: stringifyId(session.machineId),
      };
      sessionEntries.push([key, Object.freeze(readModel)]);
    }

    const runEntries: Array<[string, Readonly<RunReadModel>]> = [];
    for (const [runId, run] of snapshot.runs) {
      const key = stringifyId(runId);
      const readModel: RunReadModel = {
        ...run,
        runId: key,
        sessionId: stringifyId(run.sessionId),
        machineId: stringifyId(run.machineId),
      };
      runEntries.push([key, Object.freeze(readModel)]);
    }

    const machines = freezeRecord(toSortedRecord(machineEntries));
    const sessions = freezeRecord(toSortedRecord(sessionEntries));
    const runs = freezeRecord(toSortedRecord(runEntries));

    const sessionsByMachineMap = new Map<string, string[]>();
    for (const sessionId of Object.keys(sessions).sort((a, b) => a.localeCompare(b))) {
      const session = sessions[sessionId];
      if (!session) {
        continue;
      }
      appendIndexEntry(sessionsByMachineMap, session.machineId, sessionId);
    }

    const runsBySessionMap = new Map<string, string[]>();
    const activeRunsByMachineMap = new Map<string, string[]>();

    for (const runId of Object.keys(runs).sort((a, b) => a.localeCompare(b))) {
      const run = runs[runId];
      if (!run) {
        continue;
      }
      appendIndexEntry(runsBySessionMap, run.sessionId, runId);
      if (ACTIVE_STATES.has(run.state)) {
        appendIndexEntry(activeRunsByMachineMap, run.machineId, runId);
      }
    }

    const sessionsByMachineId = freezeRecord(
      toSortedRecord(
        Array.from(sessionsByMachineMap.entries()).map(([machineId, sessionIds]) => [
          machineId,
          freezeArray(sessionIds.sort((a, b) => a.localeCompare(b))),
        ])
      )
    );

    const runsBySessionId = freezeRecord(
      toSortedRecord(
        Array.from(runsBySessionMap.entries()).map(([sessionId, runIds]) => [
          sessionId,
          freezeArray(runIds.sort((a, b) => a.localeCompare(b))),
        ])
      )
    );

    const activeRunsByMachineId = freezeRecord(
      toSortedRecord(
        Array.from(activeRunsByMachineMap.entries()).map(([machineId, runIds]) => [
          machineId,
          freezeArray(runIds.sort((a, b) => a.localeCompare(b))),
        ])
      )
    );

    return {
      machines,
      sessions,
      runs,
      sessionsByMachineId,
      runsBySessionId,
      activeRunsByMachineId,
    };
  }
}
