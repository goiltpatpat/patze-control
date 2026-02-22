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

export function toFrontendUnifiedSnapshot(
  unified: UnifiedTelemetrySnapshot
): FrontendUnifiedSnapshot {
  const machines: FrontendMachineSnapshot[] = Object.values(unified.machines)
    .map((machine) => ({ ...machine }))
    .sort(compareMachines);

  const sessions: FrontendSessionSnapshot[] = Object.values(unified.sessions)
    .map((session) => ({ ...session }))
    .sort(compareSessions);

  const runs: FrontendRunSnapshot[] = Object.values(unified.runs)
    .map((run) => ({ ...run }))
    .sort(compareRuns);

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
