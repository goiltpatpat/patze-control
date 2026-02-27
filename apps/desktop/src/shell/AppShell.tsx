import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CommandPalette } from '../components/CommandPalette';
import type { MonitorState } from '../control-monitor';
import type { BridgeConnection } from '../hooks/useBridgeConnections';
import type {
  ConnectCredentials,
  ManagedEndpoint,
  PersistedEndpoint,
} from '../hooks/useEndpointManager';
import type { ManagedBridgeState, BridgeSetupInput } from '../hooks/useManagedBridges';
import type { FleetPolicyViolation, FleetTargetStatus } from '../hooks/useSmartFleet';
import { useNotifications } from '../hooks/useNotifications';
import type {
  OpenClawTargetsSummary,
  TargetSyncStatusEntry,
  UseOpenClawTargetsResult,
} from '../hooks/useOpenClawTargets';
import { useOpenClawTargets } from '../hooks/useOpenClawTargets';
import type { ConnectionStatus } from '../types';
import type { TunnelEndpointRow } from '../views/TunnelsView';
import { MainView } from './MainView';
import { PendingChangesBar } from '../components/PendingChangesBar';
import { navigate, type AppRoute } from './routes';
import { SidebarNav } from './SidebarNav';
import { StatusStrip } from './StatusStrip';
import { TopMachineContextBar } from './TopMachineContextBar';
import { useAppRoute } from './useAppRoute';
import { isSmokeTarget } from '../features/openclaw/selection/smoke-targets';

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

function computeOpenClawSummary(entries: readonly TargetSyncStatusEntry[]): OpenClawTargetsSummary {
  if (entries.length === 0) {
    return {
      count: 0,
      totalJobs: 0,
      healthy: 0,
      unhealthy: 0,
      lastSyncAt: null,
      overallHealth: 'none',
    };
  }

  const totalJobs = entries.reduce((sum, e) => sum + e.syncStatus.jobsCount, 0);
  const healthy = entries.filter(
    (e) => e.syncStatus.available && e.syncStatus.consecutiveFailures === 0 && !e.syncStatus.stale
  ).length;
  const unhealthy = Math.max(0, entries.length - healthy);
  const lastSyncAt =
    entries
      .map((e) => e.syncStatus.lastSuccessfulSyncAt ?? null)
      .filter((v): v is string => v !== null)
      .sort((a, b) => b.localeCompare(a))[0] ?? null;

  return {
    count: entries.length,
    totalJobs,
    healthy,
    unhealthy,
    lastSyncAt,
    overallHealth: unhealthy === 0 ? 'healthy' : 'degraded',
  };
}

export function AppShell(props: AppShellProps): JSX.Element {
  const { routeState } = useAppRoute();
  const openclawTargets = useOpenClawTargets(props.baseUrl, props.token, props.status);
  const onlineMachineIds = useMemo(
    () =>
      new Set(props.bridgeConnections.map((conn) => conn.machineId).filter((id) => id.length > 0)),
    [props.bridgeConnections]
  );
  const filteredTargetEntries = useMemo(() => {
    const groups = new Map<string, TargetSyncStatusEntry[]>();
    for (const entry of openclawTargets.entries) {
      const target = entry.target;
      const key =
        target.type === 'remote'
          ? `remote::${target.label.trim().toLowerCase()}`
          : `local::${target.id}`;
      const list = groups.get(key);
      if (list) {
        list.push(entry);
      } else {
        groups.set(key, [entry]);
      }
    }

    const resolved: TargetSyncStatusEntry[] = [];
    for (const entries of groups.values()) {
      let selected = entries[0];
      if (!selected) continue;

      let selectedScore = -1;
      for (const entry of entries) {
        const target = entry.target;
        let score = 0;
        for (const machineId of onlineMachineIds) {
          if (target.openclawDir.includes(machineId)) {
            score = 2;
            break;
          }
        }
        if (score === 0 && entry.syncStatus.lastSuccessfulSyncAt) {
          score = 1;
        }
        const selectedUpdatedAt = Date.parse(selected.target.updatedAt);
        const currentUpdatedAt = Date.parse(target.updatedAt);
        const newer =
          Number.isNaN(currentUpdatedAt) || Number.isNaN(selectedUpdatedAt)
            ? false
            : currentUpdatedAt > selectedUpdatedAt;

        if (score > selectedScore || (score === selectedScore && newer)) {
          selected = entry;
          selectedScore = score;
        }
      }
      resolved.push(selected);
    }

    return resolved;
  }, [onlineMachineIds, openclawTargets.entries]);
  const effectiveOpenclawTargets = useMemo<UseOpenClawTargetsResult>(
    () => ({
      ...openclawTargets,
      entries: filteredTargetEntries,
      summary: computeOpenClawSummary(filteredTargetEntries),
    }),
    [filteredTargetEntries, openclawTargets]
  );
  const targets = useMemo(
    () => effectiveOpenclawTargets.entries.map((entry) => entry.target),
    [effectiveOpenclawTargets.entries]
  );
  const userTargets = useMemo(() => targets.filter((target) => !isSmokeTarget(target)), [targets]);
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [targetSelectionMode, setTargetSelectionMode] = useState<'auto' | 'manual'>('auto');
  const notifications = useNotifications();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    if (targets.length === 0) {
      if (selectedTargetId !== null) {
        setSelectedTargetId(null);
      }
      if (targetSelectionMode !== 'auto') {
        setTargetSelectionMode('auto');
      }
      return;
    }
    if (!selectedTargetId) {
      return;
    }
    if (!targets.some((target) => target.id === selectedTargetId)) {
      setSelectedTargetId(null);
      setTargetSelectionMode('auto');
    }
  }, [selectedTargetId, targetSelectionMode, targets]);

  useEffect(() => {
    if (targets.length === 0) {
      return;
    }
    const targetPool = userTargets.length > 0 ? userTargets : targets;

    const score = (target: { type: 'local' | 'remote'; openclawDir: string }): number => {
      if (target.type === 'remote') {
        for (const machineId of onlineMachineIds) {
          if (target.openclawDir.includes(machineId)) {
            return 3;
          }
        }
        return 2;
      }
      return 1;
    };

    const firstTarget = targetPool[0];
    if (!firstTarget) {
      return;
    }
    let preferred = firstTarget;
    for (const target of targetPool) {
      if (score(target) > score(preferred)) {
        preferred = target;
      }
    }

    if (targetSelectionMode === 'manual' && selectedTargetId !== null) {
      return;
    }

    if (selectedTargetId === null || targetSelectionMode === 'auto') {
      setSelectedTargetId(preferred.id);
      return;
    }

    const current = targetPool.find((target) => target.id === selectedTargetId);
    if (!current) {
      setSelectedTargetId(preferred.id);
      return;
    }

    if (
      onlineMachineIds.size > 0 &&
      score(preferred) > score(current) &&
      preferred.id !== current.id
    ) {
      setSelectedTargetId(preferred.id);
    }
  }, [onlineMachineIds, selectedTargetId, targetSelectionMode, targets, userTargets]);

  const handleSelectedTargetIdChange = useCallback((targetId: string | null) => {
    if (targetId === null) {
      setTargetSelectionMode('auto');
      setSelectedTargetId(null);
      return;
    }
    setTargetSelectionMode('manual');
    setSelectedTargetId(targetId);
  }, []);

  const closePalette = useCallback(() => {
    setPaletteOpen(false);
  }, []);
  const openPalette = useCallback(() => {
    setPaletteOpen(true);
  }, []);

  // Auto-generate notifications from connection state changes
  const prevStatusRef = useRef(props.status);
  useEffect(() => {
    const prev = prevStatusRef.current;
    const next = props.status;
    prevStatusRef.current = next;
    if (prev === next) return;

    switch (next) {
      case 'connected':
        notifications.addNotification(
          'success',
          'Connected',
          'Successfully connected to control plane',
          { kind: 'navigate', route: 'overview' }
        );
        break;
      case 'error':
        notifications.addNotification(
          'error',
          'Connection Error',
          props.errorMessage ?? 'Connection to control plane failed',
          { kind: 'navigate', route: 'settings' }
        );
        break;
      case 'degraded':
        notifications.addNotification(
          'warning',
          'Connection Degraded',
          'Connection to control plane is degraded',
          { kind: 'navigate', route: 'monitor' }
        );
        break;
      case 'idle':
        if (prev === 'connected' || prev === 'degraded') {
          notifications.addNotification('info', 'Disconnected', 'Disconnected from control plane');
        }
        break;
      case 'connecting':
        break;
    }
  }, [props.status, props.errorMessage, notifications.addNotification]);

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

  const alertBadges = useMemo<Partial<Record<AppRoute, number>>>(() => {
    const snap = props.monitorState.snapshot;
    if (!snap) return {};
    const badges: Partial<Record<AppRoute, number>> = {};
    const failedRuns = snap.runs.filter((r) => r.state === 'failed').length;
    if (failedRuns > 0) badges.runs = failedRuns;
    const errorLogs = snap.logs.filter((l) => l.level === 'error' || l.level === 'critical').length;
    if (errorLogs > 0) badges.logs = errorLogs;
    return badges;
  }, [props.monitorState.snapshot]);

  return (
    <main className="app-shell">
      <CommandPalette
        open={paletteOpen}
        onClose={closePalette}
        snapshot={props.monitorState.snapshot}
        baseUrl={props.baseUrl}
        token={props.token}
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
        notifications={notifications}
        onOpenPalette={openPalette}
        openclawTargets={targets}
        openclawTargetsIssue={effectiveOpenclawTargets.lastError}
        selectedTargetId={selectedTargetId}
        targetSelectionMode={targetSelectionMode}
        onSelectedTargetIdChange={handleSelectedTargetIdChange}
      />
      <div className="shell-body">
        <SidebarNav
          route={routeState.route}
          onNavigate={(r) => {
            navigate(r);
          }}
          alertBadges={alertBadges}
        />
        <section className="shell-main">
          <MainView
            routeState={routeState}
            snapshot={props.monitorState.snapshot}
            tunnelEndpoints={props.tunnelEndpoints}
            isTunnelTransitioning={props.isTunnelTransitioning}
            baseUrl={props.baseUrl}
            token={props.token}
            onTokenChange={props.onTokenChange}
            status={props.status}
            onBaseUrlChange={props.onBaseUrlChange}
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
            onSubmitSudoPassword={props.onSubmitSudoPassword}
            onSkipSudo={props.onSkipSudo}
            managedBridgesLoading={props.managedBridgesLoading}
            smartFleetTargets={props.smartFleetTargets}
            smartFleetViolations={props.smartFleetViolations}
            onReconcileFleetTarget={props.onReconcileFleetTarget}
            onRefreshSmartFleet={props.onRefreshSmartFleet}
            smartFleetEnabled={props.smartFleetEnabled}
            openclawTargets={effectiveOpenclawTargets}
            selectedTargetId={selectedTargetId}
            onSelectedTargetIdChange={handleSelectedTargetIdChange}
          />
        </section>
      </div>
      <PendingChangesBar
        baseUrl={props.baseUrl}
        token={props.token}
        connected={props.status === 'connected' || props.status === 'degraded'}
        targetId={selectedTargetId}
      />
      <StatusStrip
        state={props.monitorState}
        bridgeCount={props.bridgeConnections.length}
        openclawSummary={effectiveOpenclawTargets.summary}
      />
    </main>
  );
}
