import { useCallback, useEffect, useState } from 'react';
import { CommandPalette } from '../components/CommandPalette';
import type { MonitorState } from '../control-monitor';
import type { BridgeConnection } from '../hooks/useBridgeConnections';
import type {
  ConnectCredentials,
  ManagedEndpoint,
  PersistedEndpoint,
} from '../hooks/useEndpointManager';
import type { ManagedBridgeState, BridgeSetupInput } from '../hooks/useManagedBridges';
import { useOpenClawTargets } from '../hooks/useOpenClawTargets';
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
  readonly bridgeConnections: readonly BridgeConnection[];
  readonly managedBridges: readonly ManagedBridgeState[];
  readonly onSetupBridge: (input: BridgeSetupInput) => Promise<ManagedBridgeState | null>;
  readonly onDisconnectBridge: (id: string) => Promise<boolean>;
  readonly onRemoveBridge: (id: string) => Promise<boolean>;
  readonly managedBridgesLoading: boolean;
}

const SHORTCUT_MAP: Readonly<Record<string, AppRoute>> = {
  '1': 'overview',
  '2': 'agents',
  '3': 'tunnels',
  '4': 'machines',
  '5': 'sessions',
  '6': 'channels',
  '7': 'runs',
  '8': 'logs',
  '9': 'tasks',
  '0': 'settings',
};

function isInputFocused(): boolean {
  const tag = document.activeElement?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export function AppShell(props: AppShellProps): JSX.Element {
  const { routeState } = useAppRoute();
  const openclawTargets = useOpenClawTargets(props.baseUrl, props.token, props.status);
  const [paletteOpen, setPaletteOpen] = useState(false);

  const closePalette = useCallback(() => { setPaletteOpen(false); }, []);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent): void {
      // Command Palette: Cmd/Ctrl + K
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setPaletteOpen((prev) => !prev);
        return;
      }

      if (e.ctrlKey || e.metaKey || e.altKey || isInputFocused()) {
        return;
      }

      // Don't trigger number shortcuts while palette is open
      if (paletteOpen) {
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
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [paletteOpen]);

  return (
    <main className="app-shell">
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        snapshot={props.monitorState.snapshot}
      />
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
        <SidebarNav
          route={routeState.route}
          onNavigate={(r) => {
            navigate(r);
          }}
        />
        <section className="shell-main">
          <MainView
            routeState={routeState}
            snapshot={props.monitorState.snapshot}
            tunnelEndpoints={props.tunnelEndpoints}
            isTunnelTransitioning={props.isTunnelTransitioning}
            baseUrl={props.baseUrl}
            token={props.token}
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
            bridgeConnections={props.bridgeConnections}
            managedBridges={props.managedBridges}
            onSetupBridge={props.onSetupBridge}
            onDisconnectBridge={props.onDisconnectBridge}
            onRemoveBridge={props.onRemoveBridge}
            managedBridgesLoading={props.managedBridgesLoading}
            openclawTargets={openclawTargets}
          />
        </section>
      </div>
      <StatusStrip
        state={props.monitorState}
        bridgeCount={props.bridgeConnections.length}
        openclawSummary={openclawTargets.summary}
      />
    </main>
  );
}
