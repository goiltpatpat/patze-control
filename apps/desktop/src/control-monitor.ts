import { createControlClient, type ControlClient } from '@patze/control-client';
import type { ConnectionStatus, FrontendUnifiedSnapshot } from './types';
import type { FrontendHealthStatus, FrontendMachineSnapshot } from '@patze/telemetry-core';

export interface ConnectParams {
  readonly baseUrl: string;
  readonly token: string;
}

export interface MonitorState {
  readonly status: ConnectionStatus;
  readonly errorMessage: string | null;
  readonly snapshot: FrontendUnifiedSnapshot | null;
}

export type MonitorStateListener = (state: MonitorState) => void;

const STALE_GHOST_MACHINE_PRUNE_MS = 2 * 60_000;

function freezeState(state: MonitorState): Readonly<MonitorState> {
  return Object.freeze({ ...state });
}

function isGhostMachine(machine: FrontendMachineSnapshot): boolean {
  return (
    machine.machineId.startsWith('machine_') && (!machine.name || machine.name.trim().length === 0)
  );
}

function recomputeOverallHealth(
  failedRunsTotal: number,
  machineStatuses: readonly FrontendHealthStatus[]
): FrontendHealthStatus {
  if (machineStatuses.length === 0) return 'unknown';
  if (failedRunsTotal > 0 || machineStatuses.some((status) => status === 'critical'))
    return 'critical';
  if (machineStatuses.some((status) => status === 'degraded')) return 'degraded';
  return 'healthy';
}

function normalizeSnapshot(snapshot: FrontendUnifiedSnapshot): FrontendUnifiedSnapshot {
  const nowMsCandidate = Date.parse(snapshot.lastUpdated);
  const nowMs = Number.isNaN(nowMsCandidate) ? Date.now() : nowMsCandidate;

  const machineIdsWithRecentActivity = new Set<string>();
  for (const session of snapshot.sessions) {
    const updatedAtMs = Date.parse(session.updatedAt);
    if (!Number.isNaN(updatedAtMs) && nowMs - updatedAtMs <= STALE_GHOST_MACHINE_PRUNE_MS) {
      machineIdsWithRecentActivity.add(session.machineId);
    }
  }
  for (const run of snapshot.runs) {
    const updatedAtMs = Date.parse(run.updatedAt);
    if (!Number.isNaN(updatedAtMs) && nowMs - updatedAtMs <= STALE_GHOST_MACHINE_PRUNE_MS) {
      machineIdsWithRecentActivity.add(run.machineId);
    }
  }

  const filteredMachines = snapshot.machines.filter((machine) => {
    if (!isGhostMachine(machine)) return true;
    const lastSeenMs = Date.parse(machine.lastSeenAt);
    if (Number.isNaN(lastSeenMs)) return true;
    const stale = nowMs - lastSeenMs > STALE_GHOST_MACHINE_PRUNE_MS;
    if (!stale) return true;
    return machineIdsWithRecentActivity.has(machine.machineId);
  });

  if (filteredMachines.length === snapshot.machines.length) {
    return snapshot;
  }

  const allowedMachineIds = new Set(filteredMachines.map((machine) => machine.machineId));
  const filteredHealthMachines = snapshot.health.machines.filter((entry) =>
    allowedMachineIds.has(entry.machineId)
  );

  return {
    ...snapshot,
    machines: filteredMachines,
    health: {
      ...snapshot.health,
      machines: filteredHealthMachines,
      overall: recomputeOverallHealth(
        snapshot.health.failedRunsTotal,
        filteredHealthMachines.map((entry) => entry.status)
      ),
    },
  };
}

export class ControlMonitorService {
  private readonly listeners = new Set<MonitorStateListener>();
  private client: ControlClient | null = null;
  private unsubscribeSnapshot: (() => void) | null = null;
  private operationId = 0;
  private state: MonitorState = freezeState({
    status: 'idle',
    errorMessage: null,
    snapshot: null,
  });

  public subscribe(listener: MonitorStateListener): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return (): void => {
      this.listeners.delete(listener);
    };
  }

  public getState(): MonitorState {
    return this.state;
  }

  public async connect(params: ConnectParams): Promise<void> {
    if (this.state.status === 'connecting') {
      return;
    }

    const operationId = this.operationId + 1;
    this.operationId = operationId;
    this.teardownClient();

    this.setState({
      status: 'connecting',
      errorMessage: null,
      snapshot: null,
    });

    const clientOptions =
      params.token.length > 0
        ? {
            baseUrl: params.baseUrl,
            token: params.token,
          }
        : {
            baseUrl: params.baseUrl,
          };

    const client = createControlClient(clientOptions);

    this.client = client;
    this.unsubscribeSnapshot = client.onSnapshot((snapshot) => {
      if (operationId !== this.operationId) {
        return;
      }

      const normalizedSnapshot = normalizeSnapshot(snapshot);

      const healthStatus = normalizedSnapshot.health.overall;
      const connectionStatus =
        healthStatus === 'critical' || healthStatus === 'degraded' ? 'degraded' : 'connected';

      this.setState({
        status: connectionStatus,
        errorMessage: null,
        snapshot: normalizedSnapshot,
      });
    });

    try {
      await client.start();
    } catch (error) {
      if (operationId !== this.operationId) {
        return;
      }

      const message = this.toUserErrorMessage(error);
      this.teardownClient();
      this.setState({
        status: 'error',
        errorMessage: message,
        snapshot: null,
      });
    }
  }

  public async disconnect(): Promise<void> {
    this.operationId += 1;
    this.teardownClient();

    this.setState({
      status: 'idle',
      errorMessage: null,
      snapshot: null,
    });
  }

  private teardownClient(): void {
    this.unsubscribeSnapshot?.();
    this.unsubscribeSnapshot = null;

    if (!this.client) {
      return;
    }

    this.client.stop();
    this.client = null;
  }

  private toUserErrorMessage(error: unknown): string {
    const fallback = 'Connection failed.';
    if (!(error instanceof Error)) {
      return fallback;
    }

    if (
      error.message.includes('Snapshot fetch timeout') ||
      error.message.includes('SSE connect timeout')
    ) {
      return 'Connection timed out. Check endpoint, auth token, and network reachability.';
    }

    if (
      error.message.includes('Snapshot fetch aborted') ||
      error.message.includes('SSE connect aborted')
    ) {
      return 'Connection was cancelled. Try connecting again.';
    }

    if (error.message.includes('401') || error.message.includes('403')) {
      return 'Authentication failed. Enter the correct token from ~/.patze-control/auth.json';
    }

    return error.message;
  }

  private setState(nextState: MonitorState): void {
    this.state = freezeState(nextState);
    for (const listener of this.listeners) {
      listener(this.state);
    }
  }
}
