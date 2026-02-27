import type {
  FrontendActiveRunSnapshot,
  FrontendHealthIndicators,
  FrontendHealthStatus,
  FrontendMachineHealthIndicator,
  FrontendMachineSnapshot,
  FrontendRunSnapshot,
  FrontendSessionSnapshot,
  FrontendUnifiedSnapshot,
} from './frontend-snapshot.js';
import type { UnifiedTelemetrySnapshot } from './telemetry-aggregator.js';
import type { IsoUtcTimestamp, SessionRunLifecycleState } from './types.js';
import { FRONTEND_ACTIVE_STATES } from './frontend-reducer.js';
import { deepFreeze } from './utils.js';

type ActiveRunState = Exclude<SessionRunLifecycleState, 'completed' | 'failed' | 'cancelled'>;

const EPOCH_ISO_UTC: IsoUtcTimestamp = '1970-01-01T00:00:00.000Z';
const ACTIVE_STATE_SET: ReadonlySet<SessionRunLifecycleState> = new Set(FRONTEND_ACTIVE_STATES);
const STALE_GHOST_MACHINE_PRUNE_MS = 2 * 60_000;

function isActiveState(state: SessionRunLifecycleState): state is ActiveRunState {
  return ACTIVE_STATE_SET.has(state);
}

function compareMachines(left: FrontendMachineSnapshot, right: FrontendMachineSnapshot): number {
  return left.machineId.localeCompare(right.machineId);
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

function machineStatusToHealth(status: FrontendMachineSnapshot['status']): FrontendHealthStatus {
  if (status === 'online') {
    return 'healthy';
  }

  if (status === 'degraded') {
    return 'degraded';
  }

  return 'critical';
}

function deriveHealth(
  machines: readonly FrontendMachineSnapshot[],
  activeRuns: readonly FrontendActiveRunSnapshot[],
  runs: readonly FrontendRunSnapshot[]
): Readonly<FrontendHealthIndicators> {
  const activeByMachine = new Map<string, number>();
  for (const run of activeRuns) {
    const current = activeByMachine.get(run.machineId) ?? 0;
    activeByMachine.set(run.machineId, current + 1);
  }

  const machineIndicators: FrontendMachineHealthIndicator[] = machines
    .map((machine) => ({
      machineId: machine.machineId,
      status: machineStatusToHealth(machine.status),
      activeRunCount: activeByMachine.get(machine.machineId) ?? 0,
      lastSeenAt: machine.lastSeenAt,
    }))
    .sort((left, right) => left.machineId.localeCompare(right.machineId));

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

  return deepFreeze({
    overall,
    machines: machineIndicators,
    activeRunsTotal,
    failedRunsTotal,
    staleMachinesTotal: 0,
  });
}

function deriveLastUpdated(
  machines: readonly FrontendMachineSnapshot[],
  sessions: readonly FrontendSessionSnapshot[],
  runs: readonly FrontendRunSnapshot[]
): IsoUtcTimestamp {
  let last = EPOCH_ISO_UTC;

  for (const machine of machines) {
    if (machine.lastSeenAt > last) {
      last = machine.lastSeenAt;
    }
  }

  for (const session of sessions) {
    if (session.updatedAt > last) {
      last = session.updatedAt;
    }
  }

  for (const run of runs) {
    if (run.updatedAt > last) {
      last = run.updatedAt;
    }
  }

  return last;
}

function isGhostBridgeMachine(machine: FrontendMachineSnapshot): boolean {
  return (
    machine.machineId.startsWith('machine_') && (!machine.name || machine.name.trim().length === 0)
  );
}

export function toFrontendUnifiedSnapshot(
  unified: UnifiedTelemetrySnapshot
): FrontendUnifiedSnapshot {
  const sessions: FrontendSessionSnapshot[] = Object.values(unified.sessions)
    .map((session) => ({ ...session }))
    .sort(compareSessions);

  const runs: FrontendRunSnapshot[] = Object.values(unified.runs)
    .map((run) => ({ ...run }))
    .sort(compareRuns);

  const nowMs = Date.now();
  const machineIdsWithRecentActivity = new Set<string>();
  for (const session of sessions) {
    const updatedAtMs = Date.parse(session.updatedAt);
    if (!Number.isNaN(updatedAtMs) && nowMs - updatedAtMs <= STALE_GHOST_MACHINE_PRUNE_MS) {
      machineIdsWithRecentActivity.add(session.machineId);
    }
  }
  for (const run of runs) {
    const updatedAtMs = Date.parse(run.updatedAt);
    if (!Number.isNaN(updatedAtMs) && nowMs - updatedAtMs <= STALE_GHOST_MACHINE_PRUNE_MS) {
      machineIdsWithRecentActivity.add(run.machineId);
    }
  }

  const machines: FrontendMachineSnapshot[] = Object.values(unified.machines)
    .map((machine) => ({ ...machine }))
    .filter((machine) => {
      if (!isGhostBridgeMachine(machine)) {
        return true;
      }
      const lastSeenMs = Date.parse(machine.lastSeenAt);
      if (Number.isNaN(lastSeenMs)) {
        return true;
      }
      const stale = nowMs - lastSeenMs > STALE_GHOST_MACHINE_PRUNE_MS;
      if (!stale) {
        return true;
      }
      return machineIdsWithRecentActivity.has(machine.machineId);
    })
    .sort(compareMachines);

  const activeRuns: FrontendActiveRunSnapshot[] = runs
    .filter((run): run is FrontendRunSnapshot & { state: ActiveRunState } =>
      isActiveState(run.state)
    )
    .map((run) => ({
      ...run,
      isActive: true as const,
      state: run.state,
    }))
    .sort(compareRuns) as FrontendActiveRunSnapshot[];

  return deepFreeze({
    machines,
    sessions,
    runs,
    activeRuns,
    health: deriveHealth(machines, activeRuns, runs),
    runDetails: {},
    logs: [],
    recentEvents: [],
    lastUpdated: deriveLastUpdated(machines, sessions, runs),
  });
}
