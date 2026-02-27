import { Fragment, useEffect, useMemo, useState } from 'react';
import { IconLink, IconServer } from '../../components/Icons';
import { StateBadge } from '../../components/badges/StateBadge';
import type { TunnelsViewProps } from './types';
import { navigate } from '../../shell/routes';
import {
  isBridgeRecent,
  formatBridgeLastSeen,
  phaseLabel,
  phaseTone,
  isActivePhase,
  bridgeErrorHint,
} from './utils';
import { BridgeLogPanel } from './BridgeLogPanel';
import { BridgeSetupDialog } from './BridgeSetupDialog';
import { AddEndpointDialog } from './AddEndpointDialog';
import { ConnectCredentialDialog } from './ConnectCredentialDialog';
import { DetachDialog } from './DetachDialog';
import { isSmokeTarget } from '../../features/openclaw/selection/smoke-targets';

function buildAuthHeaders(token: string): Record<string, string> {
  if (token.length === 0) return {};
  return { Authorization: `Bearer ${token}` };
}

function toEpochMs(value?: string): number | null {
  if (!value) return null;
  const ts = new Date(value).getTime();
  return Number.isNaN(ts) ? null : ts;
}

interface OperationJournalEntry {
  readonly operationId: string;
  readonly type: string;
  readonly status: 'started' | 'succeeded' | 'failed';
  readonly message: string;
}

const SMART_FLEET_RISK_GROUP_ORDER: readonly ('critical' | 'high' | 'medium' | 'low')[] = [
  'critical',
  'high',
  'medium',
  'low',
];

export function TunnelsView(props: TunnelsViewProps): JSX.Element {
  const [showAddForm, setShowAddForm] = useState(false);
  const [showBridgeForm, setShowBridgeForm] = useState(false);
  const [connectModalId, setConnectModalId] = useState<string | null>(null);
  const [confirmDetachOpen, setConfirmDetachOpen] = useState(false);
  const [expandedBridgeId, setExpandedBridgeId] = useState<string | null>(null);
  const [copiedDebugBridgeId, setCopiedDebugBridgeId] = useState<string | null>(null);
  const [sudoPasswordBridgeId, setSudoPasswordBridgeId] = useState<string | null>(null);
  const [sudoPassword, setSudoPassword] = useState('');
  const [sudoSubmitting, setSudoSubmitting] = useState(false);
  const [reconcilingTargetId, setReconcilingTargetId] = useState<string | null>(null);
  const [bulkReconciling, setBulkReconciling] = useState(false);
  const [expandedFleetTargetId, setExpandedFleetTargetId] = useState<string | null>(null);
  const [cleaningSmokeTargets, setCleaningSmokeTargets] = useState(false);
  const [refreshingSmartFleet, setRefreshingSmartFleet] = useState(false);
  const [smokeCleanupMessage, setSmokeCleanupMessage] = useState<string | null>(null);
  const [operations, setOperations] = useState<readonly OperationJournalEntry[]>([]);
  const [smartFleetReportedFilter, setSmartFleetReportedFilter] = useState<
    'all' | 'reported' | 'unreported'
  >('all');
  const [smartFleetRiskFilter, setSmartFleetRiskFilter] = useState<
    'focus' | 'all' | 'critical' | 'high_critical'
  >('focus');
  const [collapsedRiskGroups, setCollapsedRiskGroups] = useState({
    critical: false,
    high: false,
    medium: true,
    low: true,
  });

  const endpoint = props.endpoints[0];
  const isConnecting = endpoint?.connectionState === 'connecting';
  const disableActions = props.isTransitioning || isConnecting;
  const canAttach = endpoint
    ? endpoint.connectionState === 'idle' || endpoint.connectionState === 'error'
    : true;
  const canReconnect = endpoint
    ? endpoint.connectionState === 'connected' ||
      endpoint.connectionState === 'degraded' ||
      endpoint.connectionState === 'error'
    : false;
  const canDetach = endpoint
    ? endpoint.connectionState === 'connected' || endpoint.connectionState === 'degraded'
    : false;
  const cleanSmartFleetTargets = useMemo(
    () => props.smartFleetTargets.filter((target) => !isSmokeTarget({ label: target.targetLabel })),
    [props.smartFleetTargets]
  );
  const visibleSmartFleetTargets = useMemo(() => {
    const identityFiltered = cleanSmartFleetTargets.filter((target) => {
      const isReported = Boolean(target.reported?.machineId);
      if (smartFleetReportedFilter === 'reported') return isReported;
      if (smartFleetReportedFilter === 'unreported') return !isReported;
      return true;
    });
    return identityFiltered.filter((target) => {
      if (smartFleetRiskFilter === 'all') return true;
      if (smartFleetRiskFilter === 'critical') return target.riskLevel === 'critical';
      if (smartFleetRiskFilter === 'high_critical') {
        return target.riskLevel === 'high' || target.riskLevel === 'critical';
      }
      return target.riskLevel === 'high' || target.riskLevel === 'critical';
    });
  }, [cleanSmartFleetTargets, smartFleetReportedFilter, smartFleetRiskFilter]);
  const groupedSmartFleetTargets = useMemo(
    () => ({
      critical: visibleSmartFleetTargets.filter((target) => target.riskLevel === 'critical'),
      high: visibleSmartFleetTargets.filter((target) => target.riskLevel === 'high'),
      medium: visibleSmartFleetTargets.filter((target) => target.riskLevel === 'medium'),
      low: visibleSmartFleetTargets.filter((target) => target.riskLevel === 'low'),
    }),
    [visibleSmartFleetTargets]
  );
  const hiddenSmartFleetSmokeCount = useMemo(
    () =>
      props.smartFleetTargets.filter((target) => isSmokeTarget({ label: target.targetLabel }))
        .length,
    [props.smartFleetTargets]
  );
  const hiddenSmartFleetSmokeIds = useMemo(
    () =>
      props.smartFleetTargets
        .filter((target) => isSmokeTarget({ label: target.targetLabel }))
        .map((target) => target.targetId),
    [props.smartFleetTargets]
  );
  const visibleSmartFleetViolations = useMemo(
    () => visibleSmartFleetTargets.reduce((sum, target) => sum + target.violations.length, 0),
    [visibleSmartFleetTargets]
  );
  const visibleReportedCount = useMemo(
    () => visibleSmartFleetTargets.filter((target) => Boolean(target.reported?.machineId)).length,
    [visibleSmartFleetTargets]
  );
  const visibleCriticalCount = useMemo(
    () => visibleSmartFleetTargets.filter((target) => target.riskLevel === 'critical').length,
    [visibleSmartFleetTargets]
  );
  const visibleUnreportedIds = useMemo(
    () =>
      visibleSmartFleetTargets
        .filter((target) => !target.reported?.machineId)
        .map((target) => target.targetId),
    [visibleSmartFleetTargets]
  );

  const copyUnreportedTargetIds = async (): Promise<void> => {
    if (visibleUnreportedIds.length === 0) return;
    try {
      await navigator.clipboard.writeText(visibleUnreportedIds.join('\n'));
    } catch {
      // Clipboard can fail in restricted webviews; keep action best-effort only.
    }
  };

  const reconcileVisibleUnreported = async (): Promise<void> => {
    if (visibleUnreportedIds.length === 0 || bulkReconciling) return;
    setBulkReconciling(true);
    try {
      for (const targetId of visibleUnreportedIds) {
        await props.onReconcileFleetTarget(targetId);
      }
      await props.onRefreshSmartFleet();
    } finally {
      setBulkReconciling(false);
    }
  };

  const refreshSmartFleetNow = async (): Promise<void> => {
    if (refreshingSmartFleet) return;
    setRefreshingSmartFleet(true);
    setSmokeCleanupMessage(null);
    try {
      await props.onRefreshSmartFleet();
    } finally {
      setRefreshingSmartFleet(false);
    }
  };

  const cleanSmokeTargets = async (): Promise<void> => {
    if (hiddenSmartFleetSmokeCount === 0 || cleaningSmokeTargets) return;
    setCleaningSmokeTargets(true);
    setSmokeCleanupMessage(null);
    try {
      const response = await fetch(
        `${props.baseUrl}/openclaw/targets?ids=${encodeURIComponent(hiddenSmartFleetSmokeIds.join(','))}&purpose=test`,
        {
          method: 'DELETE',
          headers: buildAuthHeaders(props.token),
          signal: AbortSignal.timeout(12_000),
        }
      );
      if (!response.ok) {
        setSmokeCleanupMessage(`Cleanup failed: HTTP ${response.status}`);
        return;
      }
      const payload = (await response.json()) as { removedCount?: number };
      const removedCount = typeof payload.removedCount === 'number' ? payload.removedCount : 0;
      await props.onRefreshSmartFleet();
      setSmokeCleanupMessage(
        removedCount > 0
          ? `Removed ${String(removedCount)} test targets. Smart Fleet refreshed.`
          : 'No test targets found to remove.'
      );
    } catch {
      setSmokeCleanupMessage('Cleanup failed: network timeout');
    } finally {
      setCleaningSmokeTargets(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const headers: Record<string, string> = {};
    if (props.token.length > 0) {
      headers.Authorization = `Bearer ${props.token}`;
    }
    void fetch(`${props.baseUrl}/operations/recent?limit=6`, {
      headers,
      signal: AbortSignal.timeout(6_000),
    })
      .then(async (res) => {
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as { operations?: OperationJournalEntry[] };
        if (!cancelled) {
          setOperations(data.operations ?? []);
        }
      })
      .catch(() => {
        if (!cancelled) setOperations([]);
      });
    return () => {
      cancelled = true;
    };
  }, [props.baseUrl, props.token, props.smartFleetTargets.length]);

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Connections</h2>
      </div>

      <div className="settings-section" style={{ marginBottom: 20 }}>
        <h3 className="settings-section-title">Operation Trace</h3>
        <div className="fleet-policy-actions" style={{ marginBottom: 10 }}>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              navigate('settings');
            }}
          >
            Open Diagnostics
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              navigate('tasks', { taskView: 'openclaw' });
            }}
          >
            Open OpenClaw Jobs
          </button>
        </div>
        {operations.length === 0 ? (
          <p className="doctor-hint">No recent operations.</p>
        ) : (
          <div className="doctor-playbook-list">
            {operations.map((entry) => (
              <div key={entry.operationId} className="doctor-playbook-item">
                <span className="mono">{`${entry.type} · ${entry.status}`}</span>
                <span className="doctor-hint">{entry.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="settings-section" style={{ marginBottom: 20 }}>
        <h3 className="settings-section-title">Primary Control Plane</h3>
        {props.endpoints.length === 0 ? (
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>
            No primary endpoint configured.
          </p>
        ) : (
          <div className="panel">
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Base URL</th>
                    <th>Connection</th>
                    <th>Port</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {props.endpoints.map((row) => (
                    <tr key={row.endpointId}>
                      <td className="mono">{row.baseUrl}</td>
                      <td>
                        <StateBadge value={row.connectionState} />
                        {row.connectionState === 'connecting' ? (
                          <span className="inline-loading">
                            <span className="mini-spinner" /> attaching
                          </span>
                        ) : null}
                      </td>
                      <td className="mono">{row.forwardedPort}</td>
                      <td>
                        <div className="actions" style={{ gap: 6 }}>
                          <button
                            className="btn-primary"
                            onClick={props.onAttach}
                            disabled={disableActions || !canAttach}
                            style={{ fontSize: '0.75rem', padding: '3px 10px' }}
                          >
                            Connect
                          </button>
                          <button
                            className="btn-secondary"
                            onClick={props.onReconnect}
                            disabled={disableActions || !canReconnect}
                            style={{ fontSize: '0.75rem', padding: '3px 10px' }}
                          >
                            Reconnect
                          </button>
                          <button
                            className="btn-danger"
                            onClick={() => {
                              setConfirmDetachOpen(true);
                            }}
                            disabled={disableActions || !canDetach}
                            style={{ fontSize: '0.75rem', padding: '3px 10px' }}
                          >
                            Disconnect
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="settings-section" style={{ marginBottom: 20 }}>
        <h3 className="settings-section-title">
          Remote Endpoints
          <button
            className="btn-primary"
            style={{ marginLeft: 12, fontSize: '0.75rem', padding: '3px 10px' }}
            onClick={() => {
              setShowAddForm(true);
            }}
          >
            + Add
          </button>
        </h3>

        {props.remoteEndpoints.length === 0 && !showAddForm ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <IconLink width={28} height={28} />
            </div>
            No remote endpoints configured. Click + Add to connect to another OpenClaw instance.
          </div>
        ) : (
          <div className="panel">
            <div className="table-scroll">
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>Label</th>
                    <th>Host</th>
                    <th>Port</th>
                    <th>User</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {props.remoteEndpoints.map((ep) => (
                    <tr key={ep.id}>
                      <td>{ep.label}</td>
                      <td className="mono">{ep.host}</td>
                      <td className="mono">{String(ep.port)}</td>
                      <td className="mono">{ep.sshUser}</td>
                      <td>
                        <span
                          className={`status-dot`}
                          data-status={
                            ep.status === 'connected'
                              ? 'connected'
                              : ep.status === 'error'
                                ? 'error'
                                : 'idle'
                          }
                          style={{ marginRight: 6 }}
                        />
                        {ep.status}
                        {ep.errorMessage ? (
                          <span
                            className="error"
                            style={{ marginLeft: 6, fontSize: '0.75rem' }}
                            title={ep.errorMessage}
                          >
                            {ep.errorMessage.length > 30
                              ? `${ep.errorMessage.slice(0, 30)}…`
                              : ep.errorMessage}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <div className="actions" style={{ gap: 6 }}>
                          {ep.status === 'disconnected' || ep.status === 'error' ? (
                            <button
                              className="btn-primary"
                              style={{ fontSize: '0.75rem', padding: '3px 10px' }}
                              onClick={() => {
                                setConnectModalId(ep.id);
                              }}
                            >
                              Connect
                            </button>
                          ) : ep.status === 'connected' ? (
                            <button
                              className="btn-secondary"
                              style={{ fontSize: '0.75rem', padding: '3px 10px' }}
                              onClick={() => {
                                void props.onDisconnectEndpoint(ep.id);
                              }}
                            >
                              Disconnect
                            </button>
                          ) : (
                            <span className="mini-spinner" />
                          )}
                          <button
                            className="btn-danger"
                            style={{ fontSize: '0.75rem', padding: '3px 10px' }}
                            onClick={() => {
                              props.onRemoveEndpoint(ep.id);
                            }}
                            disabled={ep.status === 'connecting'}
                          >
                            Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="settings-section" style={{ marginBottom: 20 }}>
        <h3 className="settings-section-title">
          <IconServer
            width={18}
            height={18}
            style={{ marginRight: 6, verticalAlign: 'text-bottom' }}
          />
          VPS Bridges
          <button
            className="btn-primary"
            style={{ marginLeft: 12, fontSize: '0.75rem', padding: '3px 10px' }}
            onClick={() => {
              setShowBridgeForm(true);
            }}
          >
            + Connect VPS
          </button>
        </h3>

        {props.managedBridges.length === 0 &&
        props.bridgeConnections.length === 0 &&
        !showBridgeForm ? (
          <div className="empty-state" style={{ textAlign: 'left', padding: '16px 20px' }}>
            <p style={{ fontSize: '0.85rem', marginBottom: 8 }}>No VPS bridges connected.</p>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: 0 }}>
              Click "+ Connect VPS" to establish a reverse SSH tunnel to your VPS running OpenClaw.
              The bridge agent will push cron job data and run history back to this control plane.
            </p>
          </div>
        ) : (
          <>
            {props.managedBridges.length > 0 ? (
              <div className="panel" style={{ marginBottom: 12 }}>
                <div className="table-scroll">
                  <table className="data-table compact">
                    <thead>
                      <tr>
                        <th>Label</th>
                        <th>Host</th>
                        <th>Status</th>
                        <th>Machine ID</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {props.managedBridges.map((b) =>
                        (() => {
                          const matchedConnection = b.machineId
                            ? props.bridgeConnections.find((conn) => conn.machineId === b.machineId)
                            : null;
                          const fallbackConnection =
                            !matchedConnection &&
                            props.managedBridges.length === 1 &&
                            props.bridgeConnections.length === 1
                              ? props.bridgeConnections[0]
                              : null;
                          const selectedConnection =
                            matchedConnection ?? fallbackConnection ?? null;
                          const selectedLastSeenAt = selectedConnection?.lastSeenAt;
                          const selectedLastSeenTs = toEpochMs(selectedLastSeenAt);
                          const hasTelemetrySignal = selectedLastSeenTs !== null;
                          const telemetryRecent = hasTelemetrySignal
                            ? isBridgeRecent(selectedLastSeenAt)
                            : false;
                          const telemetryStale = hasTelemetrySignal && !telemetryRecent;
                          const canBeLive =
                            b.status === 'tunnel_open' ||
                            b.status === 'running' ||
                            b.status === 'telemetry_active';
                          const showStaleWarning = canBeLive && telemetryStale;

                          return (
                            <tr key={b.id}>
                              <td>{b.label}</td>
                              <td className="mono">
                                {b.sshUser}@{b.sshHost}:{b.sshPort}
                              </td>
                              <td>
                                <span className={`badge ${phaseTone(b.status)}`}>
                                  {isActivePhase(b.status) ? (
                                    <span className="mini-spinner" style={{ marginRight: 4 }} />
                                  ) : null}
                                  {phaseLabel(b.status)}
                                </span>
                                {showStaleWarning ? (
                                  <span className="badge tone-warn" style={{ marginLeft: 6 }}>
                                    Telemetry Stale
                                  </span>
                                ) : null}
                                {showStaleWarning ? (
                                  <div
                                    style={{
                                      marginTop: 4,
                                      fontSize: '0.7rem',
                                      color: 'var(--text-muted)',
                                    }}
                                  >
                                    Tunnel may be stale. Last telemetry:{' '}
                                    {formatBridgeLastSeen(selectedLastSeenAt)}. Try reconnecting VPS
                                    bridge.
                                  </div>
                                ) : null}
                                {b.status === 'needs_sudo_password' ? (
                                  <div
                                    style={{
                                      marginTop: 8,
                                      padding: '8px 10px',
                                      background: 'var(--bg-secondary)',
                                      borderRadius: 6,
                                      fontSize: '0.78rem',
                                    }}
                                  >
                                    <div style={{ marginBottom: 6, color: 'var(--text-muted)' }}>
                                      Bridge install requires sudo password for{' '}
                                      <strong>
                                        {b.sshUser}@{b.sshHost}
                                      </strong>
                                    </div>
                                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                      <input
                                        type="password"
                                        placeholder="sudo password"
                                        value={sudoPasswordBridgeId === b.id ? sudoPassword : ''}
                                        onFocus={() => {
                                          if (sudoPasswordBridgeId !== b.id) {
                                            setSudoPasswordBridgeId(b.id);
                                            setSudoPassword('');
                                          }
                                        }}
                                        onChange={(e) => {
                                          setSudoPasswordBridgeId(b.id);
                                          setSudoPassword(e.target.value);
                                        }}
                                        onKeyDown={(e) => {
                                          if (
                                            e.key === 'Enter' &&
                                            sudoPassword &&
                                            !sudoSubmitting
                                          ) {
                                            setSudoSubmitting(true);
                                            void props
                                              .onSubmitSudoPassword(b.id, sudoPassword)
                                              .finally(() => {
                                                setSudoSubmitting(false);
                                                setSudoPassword('');
                                                setSudoPasswordBridgeId(null);
                                              });
                                          }
                                        }}
                                        disabled={sudoSubmitting}
                                        style={{
                                          flex: 1,
                                          padding: '4px 8px',
                                          fontSize: '0.78rem',
                                          borderRadius: 4,
                                          border: '1px solid var(--border)',
                                          background: 'var(--bg-primary)',
                                          color: 'var(--text-primary)',
                                        }}
                                      />
                                      <button
                                        className="btn-primary"
                                        style={{ fontSize: '0.72rem', padding: '4px 10px' }}
                                        disabled={
                                          sudoSubmitting ||
                                          !sudoPassword ||
                                          sudoPasswordBridgeId !== b.id
                                        }
                                        onClick={() => {
                                          setSudoSubmitting(true);
                                          void props
                                            .onSubmitSudoPassword(b.id, sudoPassword)
                                            .finally(() => {
                                              setSudoSubmitting(false);
                                              setSudoPassword('');
                                              setSudoPasswordBridgeId(null);
                                            });
                                        }}
                                      >
                                        {sudoSubmitting ? 'Submitting…' : 'Submit'}
                                      </button>
                                      <button
                                        className="btn-ghost"
                                        style={{ fontSize: '0.72rem', padding: '4px 10px' }}
                                        disabled={sudoSubmitting}
                                        onClick={() => {
                                          setSudoSubmitting(true);
                                          void props.onSkipSudo(b.id).finally(() => {
                                            setSudoSubmitting(false);
                                            setSudoPassword('');
                                            setSudoPasswordBridgeId(null);
                                          });
                                        }}
                                      >
                                        Skip (user-level)
                                      </button>
                                    </div>
                                  </div>
                                ) : null}
                                {b.error ? (
                                  <span
                                    className="error"
                                    style={{ marginLeft: 6, fontSize: '0.72rem' }}
                                    title={b.error}
                                  >
                                    {b.error.length > 40 ? `${b.error.slice(0, 40)}…` : b.error}
                                  </span>
                                ) : null}
                                {bridgeErrorHint(b.error) ? (
                                  <div
                                    style={{
                                      marginTop: 4,
                                      fontSize: '0.7rem',
                                      color: 'var(--text-muted)',
                                    }}
                                  >
                                    Hint: {bridgeErrorHint(b.error)}
                                  </div>
                                ) : null}
                                {b.error ? (
                                  <button
                                    className="btn-ghost"
                                    style={{
                                      marginTop: 6,
                                      fontSize: '0.68rem',
                                      padding: '2px 6px',
                                    }}
                                    onClick={() => {
                                      const command = `ssh -o BatchMode=yes -p ${b.sshPort} ${b.sshUser}@${b.sshHost} "echo ok && systemctl is-active patze-bridge && curl -sf http://localhost:${b.remotePort}/health"`;
                                      void navigator.clipboard
                                        .writeText(command)
                                        .then(() => {
                                          setCopiedDebugBridgeId(b.id);
                                          window.setTimeout(() => {
                                            setCopiedDebugBridgeId((prev) =>
                                              prev === b.id ? null : prev
                                            );
                                          }, 1200);
                                        })
                                        .catch(() => undefined);
                                    }}
                                  >
                                    {copiedDebugBridgeId === b.id
                                      ? 'Debug Cmd Copied'
                                      : 'Copy Debug Cmd'}
                                  </button>
                                ) : null}
                              </td>
                              <td className="mono" style={{ fontSize: '0.78rem' }}>
                                {b.machineId ?? '—'}
                              </td>
                              <td>
                                <div className="actions" style={{ gap: 6 }}>
                                  <button
                                    className="btn-secondary"
                                    style={{ fontSize: '0.72rem', padding: '2px 8px' }}
                                    onClick={() => {
                                      setExpandedBridgeId(expandedBridgeId === b.id ? null : b.id);
                                    }}
                                  >
                                    {expandedBridgeId === b.id ? 'Hide Logs' : 'Logs'}
                                  </button>
                                  {b.status === 'telemetry_active' ||
                                  b.status === 'running' ||
                                  b.status === 'tunnel_open' ||
                                  b.status === 'connecting' ||
                                  b.status === 'ssh_test' ||
                                  b.status === 'installing' ||
                                  b.status === 'needs_sudo_password' ? (
                                    <button
                                      className="btn-danger"
                                      style={{ fontSize: '0.72rem', padding: '2px 8px' }}
                                      onClick={() => {
                                        void props.onDisconnectBridge(b.id);
                                      }}
                                    >
                                      Disconnect
                                    </button>
                                  ) : (
                                    <button
                                      className="btn-danger"
                                      style={{ fontSize: '0.72rem', padding: '2px 8px' }}
                                      onClick={() => {
                                        void props.onRemoveBridge(b.id);
                                      }}
                                    >
                                      Remove
                                    </button>
                                  )}
                                </div>
                              </td>
                            </tr>
                          );
                        })()
                      )}
                    </tbody>
                  </table>
                </div>

                {expandedBridgeId ? (
                  <BridgeLogPanel
                    bridge={props.managedBridges.find((b) => b.id === expandedBridgeId) ?? null}
                  />
                ) : null}
              </div>
            ) : null}

            {props.bridgeConnections.length > 0 ? (
              <div className="panel">
                <p
                  style={{
                    fontSize: '0.78rem',
                    color: 'var(--text-muted)',
                    margin: '10px 14px 6px',
                  }}
                >
                  Bridge data connections (received telemetry):
                </p>
                <div className="table-scroll">
                  <table className="data-table compact">
                    <thead>
                      <tr>
                        <th>Machine ID</th>
                        <th>Label</th>
                        <th>Bridge Version</th>
                        <th>Last Seen</th>
                        <th>Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {props.bridgeConnections.map((b) => (
                        <tr key={b.machineId}>
                          <td className="mono" style={{ fontSize: '0.8rem' }}>
                            {b.machineId}
                          </td>
                          <td>{b.machineLabel ?? '—'}</td>
                          <td className="mono">{b.bridgeVersion ?? '—'}</td>
                          <td>{formatBridgeLastSeen(b.lastSeenAt)}</td>
                          <td>
                            <span
                              className="status-dot"
                              data-status={isBridgeRecent(b.lastSeenAt) ? 'connected' : 'idle'}
                              style={{ marginRight: 6 }}
                            />
                            {isBridgeRecent(b.lastSeenAt) ? 'online' : 'stale'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </>
        )}
      </div>

      {props.smartFleetEnabled ? (
        <div className="settings-section" style={{ marginBottom: 20 }}>
          <h3 className="settings-section-title">Smart Fleet</h3>
          <div className="panel">
            <div className="fleet-summary-bar">
              <span className="fleet-summary-chip">{`visible ${String(visibleSmartFleetTargets.length)}`}</span>
              <span className="fleet-summary-chip">{`reported ${String(visibleReportedCount)}`}</span>
              <span className="fleet-summary-chip">{`unreported ${String(visibleUnreportedIds.length)}`}</span>
              <span className="fleet-summary-chip">{`critical ${String(visibleCriticalCount)}`}</span>
              {hiddenSmartFleetSmokeCount > 0 ? (
                <span className="fleet-summary-chip">{`hidden test ${String(hiddenSmartFleetSmokeCount)}`}</span>
              ) : null}
            </div>
            <div style={{ padding: '10px 14px 0' }}>
              <div className="fleet-policy-toolbar" style={{ margin: 0 }}>
                <select
                  className="fleet-policy-select fleet-policy-risk-filter"
                  value={smartFleetReportedFilter}
                  onChange={(event) =>
                    setSmartFleetReportedFilter(
                      event.target.value as 'all' | 'reported' | 'unreported'
                    )
                  }
                >
                  <option value="all">Identity: all</option>
                  <option value="reported">Identity: reported only</option>
                  <option value="unreported">Identity: unreported only</option>
                </select>
                <select
                  className="fleet-policy-select fleet-policy-risk-filter"
                  value={smartFleetRiskFilter}
                  onChange={(event) =>
                    setSmartFleetRiskFilter(
                      event.target.value as 'focus' | 'all' | 'critical' | 'high_critical'
                    )
                  }
                >
                  <option value="focus">Risk: focus (high/critical)</option>
                  <option value="all">Risk: all</option>
                  <option value="high_critical">Risk: high + critical</option>
                  <option value="critical">Risk: critical only</option>
                </select>
                <div className="fleet-policy-batch-actions">
                  {hiddenSmartFleetSmokeCount > 0 ? (
                    <button
                      className="btn-danger fleet-policy-btn"
                      disabled={cleaningSmokeTargets}
                      onClick={() => void cleanSmokeTargets()}
                    >
                      {cleaningSmokeTargets
                        ? 'Cleaning tests…'
                        : `Clean test targets (${String(hiddenSmartFleetSmokeCount)})`}
                    </button>
                  ) : null}
                  <button
                    className="btn-ghost fleet-policy-btn"
                    disabled={refreshingSmartFleet || bulkReconciling || cleaningSmokeTargets}
                    onClick={() => void refreshSmartFleetNow()}
                  >
                    {refreshingSmartFleet ? 'Refreshing…' : 'Refresh now'}
                  </button>
                  <button
                    className="btn-ghost fleet-policy-btn"
                    disabled={visibleUnreportedIds.length === 0}
                    onClick={() => void copyUnreportedTargetIds()}
                  >
                    Copy unreported IDs
                  </button>
                  <button
                    className="btn-secondary fleet-policy-btn"
                    disabled={visibleUnreportedIds.length === 0 || bulkReconciling}
                    onClick={() => void reconcileVisibleUnreported()}
                  >
                    {bulkReconciling ? 'Reconciling…' : 'Reconcile unreported'}
                  </button>
                </div>
              </div>
              {smokeCleanupMessage ? (
                <p style={{ margin: '8px 0 0', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  {smokeCleanupMessage}
                </p>
              ) : null}
            </div>
            <div className="table-scroll">
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>Target</th>
                    <th>Health</th>
                    <th>Risk</th>
                    <th>Drifts</th>
                    <th>Violations</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleSmartFleetTargets.length === 0 ? (
                    <tr>
                      <td colSpan={6} style={{ color: 'var(--text-muted)' }}>
                        No Smart Fleet targets match current filters.
                      </td>
                    </tr>
                  ) : (
                    SMART_FLEET_RISK_GROUP_ORDER.map((riskKey) => {
                      const groupTargets = groupedSmartFleetTargets[riskKey];
                      if (groupTargets.length === 0) return null;
                      const collapsed = collapsedRiskGroups[riskKey];
                      return (
                        <Fragment key={riskKey}>
                          <tr>
                            <td
                              colSpan={6}
                              style={{ background: 'var(--bg-tertiary)', padding: '6px 10px' }}
                            >
                              <button
                                className="btn-ghost"
                                style={{ fontSize: '0.72rem', padding: '2px 8px' }}
                                onClick={() =>
                                  setCollapsedRiskGroups((prev) => ({
                                    ...prev,
                                    [riskKey]: !prev[riskKey],
                                  }))
                                }
                              >
                                {collapsed ? 'Expand' : 'Collapse'} {riskKey} ({groupTargets.length}
                                )
                              </button>
                            </td>
                          </tr>
                          {!collapsed
                            ? groupTargets.map((target) => (
                                <Fragment key={target.targetId}>
                                  <tr>
                                    <td>
                                      {target.targetLabel}
                                      <div style={{ marginTop: 4 }}>
                                        <span
                                          className={`badge tone-${target.reported?.machineId ? 'ok' : 'warn'}`}
                                          title={
                                            target.reported?.machineId
                                              ? 'Reported machine identity from bridge telemetry'
                                              : 'No reported machine identity yet'
                                          }
                                        >
                                          {target.reported?.machineId ? 'reported' : 'unreported'}
                                        </span>
                                      </div>
                                      <div
                                        className="mono"
                                        style={{ fontSize: '0.72rem', opacity: 0.75 }}
                                      >
                                        {target.targetType}
                                      </div>
                                      <div
                                        className="mono"
                                        style={{ fontSize: '0.68rem', opacity: 0.65 }}
                                      >
                                        {target.targetId}
                                      </div>
                                      {target.reported?.machineId ? (
                                        <div
                                          className="mono"
                                          style={{ fontSize: '0.68rem', opacity: 0.65 }}
                                        >
                                          machine: {target.reported.machineId}
                                        </div>
                                      ) : null}
                                    </td>
                                    <td>{String(target.healthScore)}</td>
                                    <td>
                                      <span
                                        className={`badge tone-${target.riskLevel === 'low' ? 'ok' : target.riskLevel === 'medium' ? 'warn' : 'error'}`}
                                      >
                                        {target.riskLevel}
                                      </span>
                                    </td>
                                    <td>{String(target.drifts.length)}</td>
                                    <td>{String(target.violations.length)}</td>
                                    <td>
                                      <div className="fleet-policy-actions">
                                        <button
                                          className="btn-secondary"
                                          style={{ fontSize: '0.72rem', padding: '2px 8px' }}
                                          disabled={reconcilingTargetId === target.targetId}
                                          onClick={() => {
                                            setReconcilingTargetId(target.targetId);
                                            void props
                                              .onReconcileFleetTarget(target.targetId)
                                              .then(async () => {
                                                await props.onRefreshSmartFleet();
                                              })
                                              .finally(() => {
                                                setReconcilingTargetId((prev) =>
                                                  prev === target.targetId ? null : prev
                                                );
                                              });
                                          }}
                                        >
                                          {reconcilingTargetId === target.targetId
                                            ? 'Reconciling…'
                                            : 'Reconcile'}
                                        </button>
                                        <button
                                          className="btn-ghost fleet-policy-btn"
                                          onClick={() =>
                                            setExpandedFleetTargetId((prev) =>
                                              prev === target.targetId ? null : target.targetId
                                            )
                                          }
                                        >
                                          {expandedFleetTargetId === target.targetId
                                            ? 'Hide details'
                                            : 'Details'}
                                        </button>
                                      </div>
                                    </td>
                                  </tr>
                                  {expandedFleetTargetId === target.targetId ? (
                                    <tr>
                                      <td colSpan={6}>
                                        <div className="fleet-row-details">
                                          <div className="fleet-row-details-column">
                                            <div className="fleet-row-details-title">
                                              {`Drifts (${String(target.drifts.length)})`}
                                            </div>
                                            {target.drifts.length === 0 ? (
                                              <div className="fleet-row-details-item">
                                                No drift records.
                                              </div>
                                            ) : (
                                              target.drifts.slice(0, 4).map((drift) => (
                                                <div
                                                  key={`${target.targetId}:${drift.category}:${drift.detectedAt}`}
                                                  className="fleet-row-details-item"
                                                >
                                                  {`${drift.severity} · ${drift.category} · expected ${drift.expected} / actual ${drift.actual}`}
                                                </div>
                                              ))
                                            )}
                                          </div>
                                          <div className="fleet-row-details-column">
                                            <div className="fleet-row-details-title">
                                              {`Violations (${String(target.violations.length)})`}
                                            </div>
                                            {target.violations.length === 0 ? (
                                              <div className="fleet-row-details-item">
                                                No active violations.
                                              </div>
                                            ) : (
                                              target.violations.slice(0, 4).map((violation) => (
                                                <div
                                                  key={violation.id}
                                                  className="fleet-row-details-item"
                                                >
                                                  {`${violation.severity} · ${violation.code} · ${violation.message}`}
                                                </div>
                                              ))
                                            )}
                                          </div>
                                        </div>
                                      </td>
                                    </tr>
                                  ) : null}
                                </Fragment>
                              ))
                            : null}
                        </Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
            {props.smartFleetViolations.length > 0 ? (
              <p style={{ margin: '10px 14px', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
                {`Active violations (visible/all): ${String(visibleSmartFleetViolations)}/${String(props.smartFleetViolations.length)}`}
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      {showBridgeForm ? (
        <BridgeSetupDialog
          baseUrl={props.baseUrl}
          token={props.token}
          onCancel={() => {
            setShowBridgeForm(false);
          }}
          onSubmit={async (input) => {
            setShowBridgeForm(false);
            await props.onSetupBridge(input);
          }}
          loading={props.managedBridgesLoading}
        />
      ) : null}

      {showAddForm ? (
        <AddEndpointDialog
          onCancel={() => {
            setShowAddForm(false);
          }}
          onSubmit={(config) => {
            props.onAddEndpoint(config);
            setShowAddForm(false);
          }}
        />
      ) : null}

      {connectModalId ? (
        <ConnectCredentialDialog
          endpointId={connectModalId}
          endpoint={props.remoteEndpoints.find((e) => e.id === connectModalId) ?? null}
          onCancel={() => {
            setConnectModalId(null);
          }}
          onConnect={async (creds) => {
            setConnectModalId(null);
            await props.onConnectEndpoint(connectModalId, creds);
          }}
        />
      ) : null}

      {confirmDetachOpen ? (
        <DetachDialog
          onCancel={() => {
            setConfirmDetachOpen(false);
          }}
          onConfirm={() => {
            setConfirmDetachOpen(false);
            props.onDetach();
          }}
        />
      ) : null}
    </section>
  );
}
