import { useEffect } from 'react';
import type { MonitorState } from '../control-monitor';
import type { ConnectCredentials, ManagedEndpoint, PersistedEndpoint } from '../hooks/useEndpointManager';
import type { ConnectionStatus } from '../types';
import type { TunnelEndpointRow } from '../views/TunnelsView';
import { MainView } from './MainView';
import { navigate, type AppRoute } from './routes';
import { SidebarNav } from './SidebarNav';
import { StatusStrip } from './StatusStrip';
import { TopMachineContextBar } from './TopMachineContextBar';
import { useAppRoute } from './useAppRoute';

export interface AppShellProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly status: ConnectionStatus;
  readonly errorMessage: string | null;
  readonly monitorState: MonitorState;
  readonly tunnelEndpoints: readonly TunnelEndpointRow[];
  readonly isTunnelTransitioning: boolean;
  readonly onBaseUrlChange: (value: string) => void;
  readonly onTokenChange: (value: string) => void;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly onReconnect: () => void;
  readonly remoteEndpoints: readonly ManagedEndpoint[];
  readonly onAddEndpoint: (config: Omit<PersistedEndpoint, 'id'>) => void;
  readonly onRemoveEndpoint: (id: string) => void;
  readonly onConnectEndpoint: (id: string, credentials: ConnectCredentials) => Promise<void>;
  readonly onDisconnectEndpoint: (id: string) => Promise<void>;
}

const SHORTCUT_MAP: Readonly<Record<string, AppRoute>> = {
  '1': 'overview',
  '2': 'agents',
  '3': 'tunnels',
  '4': 'machines',
  '5': 'sessions',
  '6': 'runs',
  '7': 'logs',
  '8': 'settings',
};

function isInputFocused(): boolean {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function AppShell(props: AppShellProps): JSX.Element {
  const { routeState } = useAppRoute();

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.ctrlKey || e.metaKey || e.altKey || isInputFocused()) {
        return;
      }

      const targetRoute = SHORTCUT_MAP[e.key];
      if (targetRoute) {
        e.preventDefault();
        navigate(targetRoute);
        return;
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => { window.removeEventListener('keydown', handleKeyDown); };
  }, []);

  return (
    <main className="app-shell">
      <TopMachineContextBar
        baseUrl={props.baseUrl}
        token={props.token}
        status={props.status}
        errorMessage={props.errorMessage}
        onBaseUrlChange={props.onBaseUrlChange}
        onTokenChange={props.onTokenChange}
        onConnect={props.onConnect}
        onDisconnect={props.onDisconnect}
      />
      <div className="shell-body">
        <SidebarNav route={routeState.route} onNavigate={(r) => { navigate(r); }} />
        <section className="shell-main">
          <MainView
            routeState={routeState}
            snapshot={props.monitorState.snapshot}
            tunnelEndpoints={props.tunnelEndpoints}
            isTunnelTransitioning={props.isTunnelTransitioning}
            baseUrl={props.baseUrl}
            status={props.status}
            onConnect={props.onConnect}
            onAttach={props.onConnect}
            onDetach={props.onDisconnect}
            onReconnect={props.onReconnect}
            remoteEndpoints={props.remoteEndpoints}
            onAddEndpoint={props.onAddEndpoint}
            onRemoveEndpoint={props.onRemoveEndpoint}
            onConnectEndpoint={props.onConnectEndpoint}
            onDisconnectEndpoint={props.onDisconnectEndpoint}
          />
        </section>
      </div>
      <StatusStrip state={props.monitorState} />
    </main>
  );
}
