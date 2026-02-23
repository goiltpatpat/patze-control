import type { BridgeConnection } from '../../hooks/useBridgeConnections';
import type { ManagedBridgeState, BridgeSetupInput } from '../../hooks/useManagedBridges';
import type {
  ConnectCredentials,
  ManagedEndpoint,
  PersistedEndpoint,
} from '../../hooks/useEndpointManager';
import type { ConnectionStatus } from '../../types';

export type { BridgeConnection, ManagedBridgeState, BridgeSetupInput };
export type { ConnectCredentials, ManagedEndpoint, PersistedEndpoint };
export type { ConnectionStatus };

export interface TunnelEndpointRow {
  readonly endpointId: string;
  readonly baseUrl: string;
  readonly connectionState: ConnectionStatus;
  readonly forwardedPort: string;
}

export interface TunnelsViewProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly endpoints: readonly TunnelEndpointRow[];
  readonly isTransitioning: boolean;
  readonly onAttach: () => void;
  readonly onDetach: () => void;
  readonly onReconnect: () => void;
  readonly remoteEndpoints: readonly ManagedEndpoint[];
  readonly onAddEndpoint: (config: Omit<PersistedEndpoint, 'id'>) => void;
  readonly onRemoveEndpoint: (id: string) => void;
  readonly onConnectEndpoint: (id: string, credentials: ConnectCredentials) => Promise<void>;
  readonly onDisconnectEndpoint: (id: string) => Promise<void>;
  readonly bridgeConnections: readonly BridgeConnection[];
  readonly managedBridges: readonly ManagedBridgeState[];
  readonly onSetupBridge: (input: BridgeSetupInput) => Promise<ManagedBridgeState | null>;
  readonly onDisconnectBridge: (id: string) => Promise<boolean>;
  readonly onRemoveBridge: (id: string) => Promise<boolean>;
  readonly managedBridgesLoading: boolean;
}

export const BRIDGE_STALE_THRESHOLD_MS = 120_000;

export const BRIDGE_PROGRESS_FLOW: readonly ManagedBridgeState['status'][] = [
  'connecting',
  'ssh_test',
  'tunnel_open',
  'installing',
  'running',
  'telemetry_active',
];

export const BRIDGE_PROGRESS_STEPS: ReadonlyArray<{
  readonly key: ManagedBridgeState['status'];
  readonly label: string;
}> = [
  { key: 'connecting', label: 'Connect SSH' },
  { key: 'ssh_test', label: 'SSH Test' },
  { key: 'tunnel_open', label: 'Tunnel' },
  { key: 'installing', label: 'Install' },
  { key: 'running', label: 'Bridge Up' },
  { key: 'telemetry_active', label: 'Telemetry' },
];
