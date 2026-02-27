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
import type { FleetPolicyViolation, FleetTargetStatus } from '../hooks/useSmartFleet';
import type { UseOpenClawTargetsResult } from '../hooks/useOpenClawTargets';
import type { ConnectionStatus, FrontendUnifiedSnapshot } from '../types';
import { AgentsView } from '../views/AgentsView';
import { ChannelsView } from '../views/ChannelsView';
import { CostsView } from '../views/CostsView';
import { LogsView } from '../views/LogsView';
import { MemoryBrowserView } from '../views/MemoryBrowserView';
import { MachinesView } from '../views/MachinesView';
import { OfficeView } from '../views/OfficeView';
import { OverviewView } from '../views/OverviewView';
import { RunsView } from '../views/RunsView';
import { SessionsView } from '../views/SessionsView';
import { SettingsView } from '../views/SettingsView';
import { SystemMonitorView } from '../views/SystemMonitorView';
import { TasksView } from '../views/TasksView';
import { TerminalView } from '../views/TerminalView';
import { TunnelsView, type TunnelEndpointRow } from '../views/TunnelsView';
import { WorkspaceView } from '../views/WorkspaceView';
import { ModelsView } from '../views/ModelsView';
import { RecipesView } from '../views/RecipesView';
import { FileManagerView } from '../views/files/FileManagerView';
import type { AppRoute, RouteFilter, RouteState } from './routes';

export interface MainViewProps {
  readonly routeState: RouteState;
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly tunnelEndpoints: readonly TunnelEndpointRow[];
  readonly isTunnelTransitioning: boolean;
  readonly baseUrl: string;
  readonly token: string;
  readonly onTokenChange: (value: string) => void;
  readonly status: ConnectionStatus;
  readonly onBaseUrlChange: (value: string) => void;
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
  readonly onSubmitSudoPassword: (
    id: string,
    password: string
  ) => Promise<ManagedBridgeState | null>;
  readonly onSkipSudo: (id: string) => Promise<ManagedBridgeState | null>;
  readonly managedBridgesLoading: boolean;
  readonly smartFleetTargets: readonly FleetTargetStatus[];
  readonly smartFleetViolations: readonly FleetPolicyViolation[];
  readonly onReconcileFleetTarget: (targetId: string) => Promise<boolean>;
  readonly onRefreshSmartFleet: () => Promise<void>;
  readonly smartFleetEnabled: boolean;
  readonly openclawTargets: UseOpenClawTargetsResult;
  readonly selectedTargetId: string | null;
  readonly onSelectedTargetIdChange: (targetId: string | null) => void;
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
      return (
        <AgentsView
          snapshot={props.snapshot}
          filter={filter}
          baseUrl={props.baseUrl}
          token={props.token}
          selectedTargetId={props.selectedTargetId}
        />
      );
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
          onSubmitSudoPassword={props.onSubmitSudoPassword}
          onSkipSudo={props.onSkipSudo}
          managedBridgesLoading={props.managedBridgesLoading}
          smartFleetTargets={props.smartFleetTargets}
          smartFleetViolations={props.smartFleetViolations}
          onReconcileFleetTarget={props.onReconcileFleetTarget}
          onRefreshSmartFleet={props.onRefreshSmartFleet}
          smartFleetEnabled={props.smartFleetEnabled}
        />
      );
    case 'machines':
      return <MachinesView snapshot={props.snapshot} filter={filter} />;
    case 'sessions':
      return (
        <SessionsView
          snapshot={props.snapshot}
          filter={filter}
          baseUrl={props.baseUrl}
          token={props.token}
          selectedTargetId={props.selectedTargetId}
        />
      );
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
          selectedTargetId={props.selectedTargetId}
          onSelectedTargetIdChange={props.onSelectedTargetIdChange}
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
          selectedTargetId={props.selectedTargetId}
          onSelectedTargetIdChange={props.onSelectedTargetIdChange}
        />
      );
    case 'monitor':
      return (
        <SystemMonitorView
          snapshot={props.snapshot}
          smartFleetTargets={props.smartFleetTargets}
          smartFleetEnabled={props.smartFleetEnabled}
        />
      );
    case 'workspace':
      return (
        <WorkspaceView
          baseUrl={props.baseUrl}
          token={props.token}
          connected={props.status === 'connected' || props.status === 'degraded'}
          selectedTargetId={props.selectedTargetId}
          {...(filter.openFile ? { initialFilePath: filter.openFile } : {})}
          {...(filter.line ? { initialLine: filter.line } : {})}
        />
      );
    case 'memory':
      return (
        <MemoryBrowserView
          baseUrl={props.baseUrl}
          token={props.token}
          connected={props.status === 'connected' || props.status === 'degraded'}
        />
      );
    case 'terminal':
      return (
        <TerminalView
          baseUrl={props.baseUrl}
          token={props.token}
          connected={props.status === 'connected' || props.status === 'degraded'}
        />
      );
    case 'costs':
      return <CostsView snapshot={props.snapshot} />;
    case 'models':
      return (
        <ModelsView
          baseUrl={props.baseUrl}
          token={props.token}
          connected={props.status === 'connected' || props.status === 'degraded'}
          targetId={props.selectedTargetId}
        />
      );
    case 'recipes':
      return (
        <RecipesView
          baseUrl={props.baseUrl}
          token={props.token}
          connected={props.status === 'connected' || props.status === 'degraded'}
          targetId={props.selectedTargetId}
        />
      );
    case 'files':
      return (
        <FileManagerView
          baseUrl={props.baseUrl}
          token={props.token}
          connected={props.status === 'connected' || props.status === 'degraded'}
        />
      );
    case 'office':
      return (
        <OfficeView
          openclawTargets={props.openclawTargets.entries}
          baseUrl={props.baseUrl}
          token={props.token}
          selectedTargetId={props.selectedTargetId}
        />
      );
    case 'settings':
      return (
        <SettingsView
          snapshot={props.snapshot}
          baseUrl={props.baseUrl}
          token={props.token}
          status={props.status}
          selectedTargetId={props.selectedTargetId}
          onBaseUrlChange={props.onBaseUrlChange}
          onTokenChange={props.onTokenChange}
          onConnect={props.onConnect}
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
