import { createControlClient, type ControlClient } from '@patze/control-client';
import type { ConnectionStatus, FrontendUnifiedSnapshot } from './types';

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

function freezeState(state: MonitorState): Readonly<MonitorState> {
  return Object.freeze({ ...state });
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

      this.setState({
        status: snapshot.health.overall === 'healthy' ? 'connected' : 'degraded',
        errorMessage: null,
        snapshot,
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

    if (error.message.includes('401') || error.message.includes('403')) {
      return 'Authentication failed. Check your token and permissions.';
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
