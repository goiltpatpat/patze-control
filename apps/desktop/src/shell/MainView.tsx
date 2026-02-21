import { ErrorBoundary } from '../components/ErrorBoundary';
import { FilterBar } from '../components/FilterBar';
import { LoadingSkeleton } from '../components/LoadingSkeleton';
import type { ConnectCredentials, ManagedEndpoint, PersistedEndpoint } from '../hooks/useEndpointManager';
import type { ConnectionStatus, FrontendUnifiedSnapshot } from '../types';
import { AgentsView } from '../views/AgentsView';
import { LogsView } from '../views/LogsView';
import { MachinesView } from '../views/MachinesView';
import { OverviewView } from '../views/OverviewView';
import { RunsView } from '../views/RunsView';
import { SessionsView } from '../views/SessionsView';
import { SettingsView } from '../views/SettingsView';
import { TunnelsView, type TunnelEndpointRow } from '../views/TunnelsView';
import type { AppRoute, RouteFilter, RouteState } from './routes';

export interface MainViewProps {
  readonly routeState: RouteState;
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly tunnelEndpoints: readonly TunnelEndpointRow[];
  readonly isTunnelTransitioning: boolean;
  readonly baseUrl: string;
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
}

function renderRoute(
  route: AppRoute,
  filter: RouteFilter,
  props: MainViewProps,
): JSX.Element {
  switch (route) {
    case 'overview':
      return <OverviewView snapshot={props.snapshot} onConnect={props.onConnect} />;
    case 'agents':
      return <AgentsView snapshot={props.snapshot} filter={filter} />;
    case 'tunnels':
      return (
        <TunnelsView
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
    case 'settings':
      return (
        <SettingsView
          snapshot={props.snapshot}
          baseUrl={props.baseUrl}
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
  'overview', 'agents', 'machines', 'sessions', 'runs', 'logs',
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
