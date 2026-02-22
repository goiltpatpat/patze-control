import { ErrorBoundary } from '../components/ErrorBoundary';
import { FilterBar } from '../components/FilterBar';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import type { BridgeConnection } from '../hooks/useBridgeConnections';
import type {
  ConnectCredentials,
  ManagedEndpoint,
  PersistedEndpoint,
} from '../hooks/useEndpointManager';
import type { ManagedBridgeState, BridgeSetupInput } from '../hooks/useManagedBridges';
import type { UseOpenClawTargetsResult } from '../hooks/useOpenClawTargets';
import type { ConnectionStatus, FrontendUnifiedSnapshot } from '../types';
import { AgentsView } from '../views/AgentsView';
import { ChannelsView } from '../views/ChannelsView';
import { LogsView } from '../views/LogsView';
import { MachinesView } from '../views/MachinesView';
import { OverviewView } from '../views/OverviewView';
import { RunsView } from '../views/RunsView';
import { SessionsView } from '../views/SessionsView';
import { SettingsView } from '../views/SettingsView';
import { TasksView } from '../views/TasksView';
import { TunnelsView, type TunnelEndpointRow } from '../views/TunnelsView';
import type { AppRoute, RouteFilter, RouteState } from './routes';

export interface MainViewProps {
  readonly routeState: RouteState;
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly tunnelEndpoints: readonly TunnelEndpointRow[];
  readonly isTunnelTransitioning: boolean;
  readonly baseUrl: string;
  readonly token: string;
  readonly status: ConnectionStatus;
  readonly onConnect: () => void;
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
  readonly openclawTargets: UseOpenClawTargetsResult;
}

function renderRoute(route: AppRoute, filter: RouteFilter, props: MainViewProps): JSX.Element {
  switch (route) {
    case 'overview':
      return (
        <OverviewView
          snapshot={props.snapshot}
          onConnect={props.onConnect}
          bridgeCount={props.bridgeConnections.length}
          openclawSummary={props.openclawTargets.summary}
          status={props.status}
        />
      );
    case 'agents':
      return <AgentsView snapshot={props.snapshot} filter={filter} />;
    case 'tunnels':
      return (
        <TunnelsView
          baseUrl={props.baseUrl}
          token={props.token}
          endpoints={props.tunnelEndpoints}
          isTransitioning={props.isTunnelTransitioning}
          onAttach={props.onAttach}
          onDetach={props.onDetach}
          onReconnect={props.onReconnect}
          remoteEndpoints={props.remoteEndpoints}
          onAddEndpoint={props.onAddEndpoint}
          onRemoveEndpoint={props.onRemoveEndpoint}
          onConnectEndpoint={props.onConnectEndpoint}
          onDisconnectEndpoint={props.onDisconnectEndpoint}
          bridgeConnections={props.bridgeConnections}
          managedBridges={props.managedBridges}
          onSetupBridge={props.onSetupBridge}
          onDisconnectBridge={props.onDisconnectBridge}
          onRemoveBridge={props.onRemoveBridge}
          managedBridgesLoading={props.managedBridgesLoading}
        />
      );
    case 'machines':
      return <MachinesView snapshot={props.snapshot} filter={filter} />;
    case 'sessions':
      return <SessionsView snapshot={props.snapshot} filter={filter} />;
    case 'runs':
      return <RunsView snapshot={props.snapshot} filter={filter} />;
    case 'logs':
      return <LogsView snapshot={props.snapshot} />;
    case 'tasks':
      return (
        <TasksView
          baseUrl={props.baseUrl}
          token={props.token}
          status={props.status}
          openclawTargets={props.openclawTargets}
          {...(filter.taskView ? { initialFilter: filter.taskView } : {})}
        />
      );
    case 'channels':
      return (
        <ChannelsView
          baseUrl={props.baseUrl}
          token={props.token}
          status={props.status}
          openclawTargets={props.openclawTargets.entries}
        />
      );
    case 'settings':
      return (
        <SettingsView
          snapshot={props.snapshot}
          baseUrl={props.baseUrl}
          token={props.token}
          status={props.status}
        />
      );
    default: {
      const _exhaustive: never = route;
      return _exhaustive;
    }
  }
}

const SKELETON_ROUTES: ReadonlySet<AppRoute> = new Set([
  'overview',
  'agents',
  'machines',
  'sessions',
  'runs',
  'logs',
]);

export function MainView(props: MainViewProps): JSX.Element {
  const { route, filter } = props.routeState;
  const isLoading = props.status === 'connecting' && !props.snapshot;
  const showSkeleton = isLoading && SKELETON_ROUTES.has(route);

  return (
    <ErrorBoundary key={route}>
      {showSkeleton ? (
        <section className="view-panel">
          <LoadingSkeleton variant={route === 'machines' ? 'cards' : 'lines'} />
        </section>
      ) : (
        <>
          <FilterBar route={route} filter={filter} />
          {renderRoute(route, filter, props)}
        </>
      )}
    </ErrorBoundary>
  );
}
