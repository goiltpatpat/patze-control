import { useEffect, useRef, useState } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';
import { IconLink, IconServer } from '../components/Icons';
import { StateBadge } from '../components/badges/StateBadge';
import type { BridgeConnection } from '../hooks/useBridgeConnections';
import type { ManagedBridgeState, BridgeSetupInput } from '../hooks/useManagedBridges';
import type {
  ConnectCredentials,
  ManagedEndpoint,
  PersistedEndpoint,
} from '../hooks/useEndpointManager';
import type { ConnectionStatus } from '../types';

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

const BRIDGE_STALE_THRESHOLD_MS = 120_000;

function isBridgeRecent(lastSeenAt?: string): boolean {
  if (!lastSeenAt) return false;
  const ts = new Date(lastSeenAt).getTime();
  return Date.now() - ts < BRIDGE_STALE_THRESHOLD_MS;
}

function formatBridgeLastSeen(lastSeenAt?: string): string {
  if (!lastSeenAt) return '—';
  const d = new Date(lastSeenAt);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

function phaseLabel(status: ManagedBridgeState['status']): string {
  switch (status) {
    case 'connecting':
      return 'Connecting…';
    case 'ssh_test':
      return 'SSH Pre-flight…';
    case 'tunnel_open':
      return 'Tunnel Open';
    case 'installing':
      return 'Installing…';
    case 'running':
      return 'Running';
    case 'telemetry_active':
      return 'Telemetry Active';
    case 'error':
      return 'Error';
    case 'disconnected':
      return 'Disconnected';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function phaseTone(status: ManagedBridgeState['status']): string {
  switch (status) {
    case 'telemetry_active':
    case 'running':
      return 'tone-good';
    case 'ssh_test':
    case 'tunnel_open':
      return 'tone-neutral';
    case 'connecting':
    case 'installing':
      return 'tone-neutral';
    case 'error':
      return 'tone-bad';
    case 'disconnected':
      return 'tone-warn';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

function isActivePhase(status: ManagedBridgeState['status']): boolean {
  return status === 'connecting' || status === 'ssh_test' || status === 'installing';
}

const BRIDGE_PROGRESS_FLOW: readonly ManagedBridgeState['status'][] = [
  'connecting',
  'ssh_test',
  'tunnel_open',
  'installing',
  'running',
  'telemetry_active',
];

const BRIDGE_PROGRESS_STEPS: ReadonlyArray<{
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

function bridgeProgressPercent(status: ManagedBridgeState['status']): number {
  if (status === 'error') return 100;
  if (status === 'disconnected') return 0;
  const idx = BRIDGE_PROGRESS_FLOW.indexOf(status);
  if (idx < 0) return 0;
  return Math.round(((idx + 1) / BRIDGE_PROGRESS_FLOW.length) * 100);
}

function bridgeErrorHint(error?: string): string | null {
  if (!error) return null;
  const lowered = error.toLowerCase();
  if (lowered.includes('pre-flight')) return 'Check SSH alias/key/path and retry.';
  if (lowered.includes('timed out')) return 'Check firewall, target port, and network stability.';
  if (lowered.includes('cannot read ssh key')) return 'Check key path and file permissions.';
  if (lowered.includes('reverse tunnel'))
    return 'Remote port may already be used by another service.';
  return 'Open Logs for full diagnostics.';
}

export function TunnelsView(props: TunnelsViewProps): JSX.Element {
  const [showAddForm, setShowAddForm] = useState(false);
  const [showBridgeForm, setShowBridgeForm] = useState(false);
  const [connectModalId, setConnectModalId] = useState<string | null>(null);
  const [confirmDetachOpen, setConfirmDetachOpen] = useState(false);
  const [expandedBridgeId, setExpandedBridgeId] = useState<string | null>(null);
  const [copiedDebugBridgeId, setCopiedDebugBridgeId] = useState<string | null>(null);

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

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Connections</h2>
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
                      {props.managedBridges.map((b) => (
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
                                style={{ marginTop: 6, fontSize: '0.68rem', padding: '2px 6px' }}
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
                              b.status === 'installing' ? (
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
                      ))}
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

function BridgeLogPanel(props: { readonly bridge: ManagedBridgeState | null }): JSX.Element | null {
  const { bridge } = props;
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bridge) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [bridge?.logs.length, bridge]);

  if (!bridge) return null;
  const progressPercent = bridgeProgressPercent(bridge.status);
  const currentStepIndex = BRIDGE_PROGRESS_STEPS.findIndex((step) => step.key === bridge.status);
  const statusTone =
    bridge.status === 'error'
      ? 'var(--red)'
      : bridge.status === 'telemetry_active'
        ? 'var(--green)'
        : 'var(--accent)';

  return (
    <div style={{ padding: '8px 14px 12px', borderTop: '1px solid var(--border-muted)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 8,
          border: '1px solid var(--border-muted)',
          borderRadius: 8,
          padding: '6px 10px',
          background: 'color-mix(in srgb, var(--bg-elevated) 40%, transparent)',
        }}
      >
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Current Phase</span>
        <span style={{ fontSize: '0.72rem', color: statusTone, fontWeight: 600 }}>
          {phaseLabel(bridge.status)}
        </span>
      </div>
      <div style={{ marginBottom: 8 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '0.7rem',
            color: 'var(--text-muted)',
            marginBottom: 4,
          }}
        >
          <span>Bridge Progress</span>
          <span>{progressPercent}%</span>
        </div>
        <div
          style={{ height: 6, borderRadius: 999, background: 'var(--bg-base)', overflow: 'hidden' }}
        >
          <div
            style={{
              width: `${progressPercent}%`,
              height: '100%',
              transition: 'width 180ms ease',
              background: bridge.status === 'error' ? 'var(--red)' : 'var(--accent)',
            }}
          />
        </div>
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {BRIDGE_PROGRESS_STEPS.map((step, idx) => {
            const done = currentStepIndex >= 0 && idx < currentStepIndex;
            const active = step.key === bridge.status;
            const failed = bridge.status === 'error' && idx === Math.max(currentStepIndex, 0);
            return (
              <span
                key={step.key}
                style={{
                  fontSize: '0.68rem',
                  borderRadius: 999,
                  border: `1px solid ${failed ? 'var(--red-dim)' : done || active ? 'var(--accent-dim)' : 'var(--border-muted)'}`,
                  padding: '2px 8px',
                  color: failed
                    ? 'var(--red)'
                    : done || active
                      ? 'var(--text-primary)'
                      : 'var(--text-muted)',
                  background: failed
                    ? 'color-mix(in srgb, var(--red-dim) 16%, transparent)'
                    : done || active
                      ? 'color-mix(in srgb, var(--accent-dim) 14%, transparent)'
                      : 'transparent',
                }}
              >
                {step.label}
              </span>
            );
          })}
        </div>
        {bridge.status === 'telemetry_active' || bridge.status === 'running' ? (
          <div style={{ marginTop: 8, fontSize: '0.7rem', color: 'var(--green)' }}>
            {bridge.machineId
              ? `Verified: machine ${bridge.machineId} is connected.`
              : 'Bridge connected. Waiting machine-id confirmation.'}
          </div>
        ) : null}
      </div>
      <div
        style={{
          background: 'var(--bg-base)',
          borderRadius: 4,
          padding: '8px 10px',
          maxHeight: 180,
          overflowY: 'auto',
          fontSize: '0.72rem',
          fontFamily: 'var(--font-mono)',
          lineHeight: 1.6,
          color: 'var(--text-secondary)',
        }}
      >
        {bridge.logs.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

function buildAuthHeaders(token: string): Record<string, string> {
  if (token.length > 0) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

function BridgeSetupDialog(props: {
  readonly baseUrl: string;
  readonly token: string;
  readonly onCancel: () => void;
  readonly onSubmit: (input: BridgeSetupInput) => Promise<void>;
  readonly loading: boolean;
}): JSX.Element {
  const PREFLIGHT_FRESH_MS = 120_000;
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightResult, setPreflightResult] = useState<string | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [preflightPassed, setPreflightPassed] = useState(false);
  const [preflightCheckedAt, setPreflightCheckedAt] = useState<number | null>(null);
  const [preflightKey, setPreflightKey] = useState<string | null>(null);
  const [allowUnsafeConnect, setAllowUnsafeConnect] = useState(false);
  const [label, setLabel] = useState('');
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('root');
  const [sshKeyPath, setSshKeyPath] = useState('~/.ssh/id_rsa');
  const [authToken, setAuthToken] = useState('');
  const [sshAliases, setSshAliases] = useState<string[]>([]);
  const [aliasFetchError, setAliasFetchError] = useState<string | null>(null);
  const [autoFilledToken, setAutoFilledToken] = useState(false);
  const [remotePort, setRemotePort] = useState('19700');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [expiresIn, setExpiresIn] = useState('');
  const [openclawHome, setOpenclawHome] = useState('');
  const { containerRef: dialogRef, handleKeyDown: trapKeyDown } = useFocusTrap(props.onCancel);
  const trimmedHost = sshHost.trim();
  const matchedAlias = sshAliases.find((alias) => alias === trimmedHost);
  const aliasDetected = Boolean(matchedAlias);

  useEffect(() => {
    const storedToken = localStorage.getItem('patze_token') ?? '';
    if (storedToken && !authToken) {
      setAuthToken(storedToken);
      setAutoFilledToken(true);
    }
  }, [authToken]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const run = async (): Promise<void> => {
      try {
        const res = await fetch(`${props.baseUrl}/ssh/config-hosts`, {
          headers: buildAuthHeaders(props.token),
          signal: controller.signal,
        });
        if (!res.ok) {
          if (!cancelled) {
            setAliasFetchError('Unable to load SSH aliases.');
          }
          return;
        }
        const data = (await res.json()) as { aliases?: string[] };
        if (!cancelled) {
          setSshAliases(data.aliases ?? []);
          setAliasFetchError(null);
        }
      } catch {
        if (!cancelled) {
          setAliasFetchError('Unable to load SSH aliases.');
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [props.baseUrl, props.token]);

  const parsedSshPort = Number(sshPort) || 0;
  const parsedRemotePort = Number(remotePort) || 0;
  const remotePortIsControlPlanePort = parsedRemotePort === 9700;
  const isPortValid = (p: number): boolean => p >= 1 && p <= 65535;
  const sshKeyOk =
    sshKeyPath.trim().startsWith('~/.ssh/') || sshKeyPath.trim().startsWith('~/.ssh');
  const currentPreflightKey = JSON.stringify({
    sshHost: trimmedHost,
    sshPort: parsedSshPort,
    sshUser: sshUser.trim() || 'root',
    sshKeyPath: sshKeyPath.trim() || '~/.ssh/id_rsa',
    sshMode: aliasDetected ? 'alias' : 'explicit',
  });

  const validationErrors: string[] = [];
  if (!trimmedHost) validationErrors.push('SSH Host is required.');
  if (!aliasDetected && !isPortValid(parsedSshPort))
    validationErrors.push('SSH Port must be 1–65535.');
  if (!isPortValid(parsedRemotePort)) validationErrors.push('Remote Port must be 1–65535.');
  if (!aliasDetected && !sshKeyOk) validationErrors.push('SSH Key must be under ~/.ssh/.');

  const canSubmit = validationErrors.length === 0 && !props.loading;
  const canRunPreflight = validationErrors.length === 0 && !props.loading && !preflightLoading;
  const preflightIsFresh =
    preflightPassed &&
    preflightKey === currentPreflightKey &&
    preflightCheckedAt !== null &&
    Date.now() - preflightCheckedAt <= PREFLIGHT_FRESH_MS;
  const canConnectNow = canSubmit && !preflightLoading && (preflightIsFresh || allowUnsafeConnect);

  const handleSubmit = (): void => {
    if (!canSubmit || preflightLoading) return;
    if (!preflightIsFresh && !allowUnsafeConnect) {
      setPreflightError('Run pre-flight first, or use Connect anyway (advanced).');
      return;
    }
    void props.onSubmit({
      label: label.trim() || trimmedHost,
      sshHost: trimmedHost,
      sshPort: parsedSshPort,
      sshUser: sshUser.trim() || 'root',
      sshKeyPath: sshKeyPath.trim() || '~/.ssh/id_rsa',
      ...(aliasDetected ? { sshMode: 'alias' as const } : { sshMode: 'explicit' as const }),
      authToken: authToken.trim(),
      remotePort: parsedRemotePort,
      expiresIn: expiresIn.trim() || undefined,
      openclawHome: openclawHome.trim() || undefined,
    });
  };

  const handlePreflight = (): void => {
    if (!canRunPreflight) return;
    setPreflightLoading(true);
    setPreflightResult(null);
    setPreflightError(null);

    const payload = {
      sshHost: trimmedHost,
      sshPort: parsedSshPort,
      sshUser: sshUser.trim() || 'root',
      sshKeyPath: sshKeyPath.trim() || '~/.ssh/id_rsa',
      ...(aliasDetected ? { sshMode: 'alias' as const } : { sshMode: 'explicit' as const }),
    };

    void fetch(`${props.baseUrl}/bridge/preflight`, {
      method: 'POST',
      headers: { ...buildAuthHeaders(props.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    })
      .then(async (res) => {
        const data = (await res.json()) as {
          ok?: boolean;
          message?: string;
          mode?: 'alias' | 'explicit';
          sshHost?: string;
          sshUser?: string;
          sshPort?: number;
        };
        if (!res.ok || !data.ok) {
          setPreflightPassed(false);
          setPreflightCheckedAt(Date.now());
          setPreflightKey(currentPreflightKey);
          setAllowUnsafeConnect(false);
          setPreflightError(data.message ?? 'Pre-flight failed.');
          return;
        }
        setPreflightPassed(true);
        setPreflightCheckedAt(Date.now());
        setPreflightKey(currentPreflightKey);
        setAllowUnsafeConnect(false);
        setPreflightResult(
          `${data.message ?? 'Pre-flight passed.'} (${data.mode} ${data.sshUser}@${data.sshHost}:${data.sshPort})`
        );
      })
      .catch(() => {
        setPreflightError('Pre-flight request failed.');
      })
      .finally(() => {
        setPreflightLoading(false);
      });
  };

  useEffect(() => {
    setAllowUnsafeConnect(false);
  }, [currentPreflightKey]);

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bridge-setup-title"
      onKeyDown={(e) => {
        trapKeyDown(e);
        if (e.key === 'Enter' && canSubmit) handleSubmit();
      }}
    >
      <div
        className="dialog-card"
        ref={dialogRef}
        style={{
          maxWidth: 480,
          maxHeight: 'min(640px, calc(100vh - 40px))',
          overflowY: 'auto',
          overscrollBehavior: 'contain',
        }}
      >
        <h3 id="bridge-setup-title">
          <IconServer
            width={18}
            height={18}
            style={{ marginRight: 6, verticalAlign: 'text-bottom' }}
          />
          Connect VPS Bridge
        </h3>
        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '4px 0 14px' }}>
          Establishes a reverse SSH tunnel to your VPS and optionally installs the bridge agent.
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
            marginBottom: 10,
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid var(--border-muted)',
            background: 'color-mix(in srgb, var(--bg-elevated) 45%, transparent)',
            boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--text-muted) 12%, transparent)',
            transition: 'border-color 160ms ease, box-shadow 160ms ease',
          }}
        >
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            <span
              style={{
                display: 'block',
                fontSize: '0.66rem',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
            >
              Mode
            </span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
              {aliasDetected ? 'SSH Alias' : 'Explicit Host'}
            </span>
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            <span
              style={{
                display: 'block',
                fontSize: '0.66rem',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
            >
              Pre-flight
            </span>
            <span
              style={{
                color: preflightIsFresh ? 'var(--green)' : 'var(--yellow)',
                fontWeight: 600,
              }}
            >
              {preflightIsFresh ? 'Passed' : 'Required'}
            </span>
          </div>
        </div>
        <p style={{ margin: '0 0 12px', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          Default remote port: 19700{autoFilledToken ? ' • Saved token loaded' : ''}
        </p>
        {aliasDetected ? (
          <div
            style={{
              marginBottom: 10,
              border: '1px solid var(--accent-dim)',
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: '0.72rem',
              color: 'var(--text-secondary)',
              background: 'color-mix(in srgb, var(--accent-dim) 10%, transparent)',
            }}
          >
            Alias mode active: user/port/key are resolved automatically from `~/.ssh/config`.
          </div>
        ) : null}

        <div className="dialog-form-grid">
          <div className="dialog-form-row cols-2">
            <div className="dialog-field">
              <span className="dialog-field-label">Label</span>
              <input
                type="text"
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                }}
                placeholder="My VPS"
              />
            </div>
            <div className="dialog-field">
              <span className="dialog-field-label">SSH Host *</span>
              <input
                type="text"
                value={sshHost}
                onChange={(e) => {
                  setSshHost(e.target.value);
                }}
                placeholder="192.168.1.100"
                list="ssh-alias-list"
              />
              <datalist id="ssh-alias-list">
                {sshAliases.map((alias) => (
                  <option key={alias} value={alias} />
                ))}
              </datalist>
              {aliasDetected ? (
                <p style={{ margin: '6px 0 0', fontSize: '0.72rem', color: 'var(--accent)' }}>
                  SSH alias detected (`{matchedAlias}`) — user/port/key will use `~/.ssh/config`.
                </p>
              ) : null}
              {!aliasDetected && aliasFetchError ? (
                <p style={{ margin: '6px 0 0', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  {aliasFetchError}
                </p>
              ) : null}
            </div>
          </div>
          <div className="dialog-form-row cols-2">
            <div className="dialog-field">
              <span className="dialog-field-label">SSH User</span>
              <input
                type="text"
                value={sshUser}
                onChange={(e) => {
                  setSshUser(e.target.value);
                }}
                placeholder="root"
                disabled={aliasDetected}
                style={aliasDetected ? { opacity: 0.6 } : undefined}
              />
            </div>
            <div className="dialog-field">
              <span className="dialog-field-label">SSH Port</span>
              <input
                type="number"
                value={sshPort}
                onChange={(e) => {
                  setSshPort(e.target.value);
                }}
                disabled={aliasDetected}
                style={aliasDetected ? { opacity: 0.6 } : undefined}
              />
            </div>
          </div>
          <div className="dialog-field">
            <span className="dialog-field-label">SSH Key Path</span>
            <input
              type="text"
              value={sshKeyPath}
              onChange={(e) => {
                setSshKeyPath(e.target.value);
              }}
              placeholder="~/.ssh/id_rsa"
              disabled={aliasDetected}
              style={aliasDetected ? { opacity: 0.6 } : undefined}
            />
          </div>
          <div className="dialog-form-row cols-2">
            <div className="dialog-field">
              <span className="dialog-field-label">Auth Token</span>
              <input
                type="password"
                value={authToken}
                onChange={(e) => {
                  setAuthToken(e.target.value);
                }}
                placeholder="Token for bridge auth"
              />
            </div>
            <div className="dialog-field">
              <span className="dialog-field-label">Remote Port</span>
              <input
                type="number"
                value={remotePort}
                onChange={(e) => {
                  setRemotePort(e.target.value);
                }}
              />
            </div>
          </div>
        </div>
        {remotePortIsControlPlanePort ? (
          <div
            style={{
              marginTop: 10,
              border: '1px solid var(--yellow-dim)',
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: '0.72rem',
              color: 'var(--yellow)',
              background: 'color-mix(in srgb, var(--yellow-dim) 16%, transparent)',
            }}
          >
            Recommended: use a remote port other than 9700 to avoid overlapping with control plane
            endpoint.
          </div>
        ) : null}
        <p
          style={{ marginTop: 8, marginBottom: 0, fontSize: '0.72rem', color: 'var(--text-muted)' }}
        >
          Security note: reverse tunnel binds to `127.0.0.1` by default; review SSHD `GatewayPorts`
          policy on VPS.
        </p>

        <button
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--accent)',
            cursor: 'pointer',
            fontSize: '0.75rem',
            padding: '8px 0 0',
            textDecoration: 'underline',
          }}
          onClick={() => {
            setShowAdvanced(!showAdvanced);
          }}
        >
          {showAdvanced ? 'Hide advanced options' : 'Show advanced options'}
        </button>

        {showAdvanced ? (
          <div className="dialog-form-grid" style={{ marginTop: 8 }}>
            <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              Advanced options are optional: set token TTL or custom OpenClaw home when needed.
            </p>
            <div className="dialog-form-row cols-2">
              <div className="dialog-field">
                <span className="dialog-field-label">Token Expires In</span>
                <input
                  type="text"
                  value={expiresIn}
                  onChange={(e) => {
                    setExpiresIn(e.target.value);
                  }}
                  placeholder="24h, 7d"
                />
              </div>
              <div className="dialog-field">
                <span className="dialog-field-label">OpenClaw Home</span>
                <input
                  type="text"
                  value={openclawHome}
                  onChange={(e) => {
                    setOpenclawHome(e.target.value);
                  }}
                  placeholder="~/.openclaw"
                />
              </div>
            </div>
          </div>
        ) : null}

        <div style={{ marginTop: 10, borderTop: '1px solid var(--border-muted)' }} />
        {validationErrors.length > 0 && trimmedHost.length > 0 ? (
          <ul
            style={{
              margin: '10px 0 0',
              padding: '0 0 0 16px',
              fontSize: '0.75rem',
              color: 'var(--error)',
              listStyle: 'disc',
            }}
          >
            {validationErrors.map((msg) => (
              <li key={msg}>{msg}</li>
            ))}
          </ul>
        ) : null}
        {preflightResult ? (
          <div
            style={{
              marginTop: 10,
              fontSize: '0.74rem',
              color: 'var(--green)',
              border: '1px solid var(--green-dim)',
              borderRadius: 8,
              padding: '7px 10px',
              background: 'color-mix(in srgb, var(--green-dim) 12%, transparent)',
            }}
          >
            {preflightResult}
          </div>
        ) : null}
        {preflightError ? (
          <div
            style={{
              marginTop: 10,
              fontSize: '0.74rem',
              color: 'var(--red)',
              border: '1px solid var(--red-dim)',
              borderRadius: 8,
              padding: '7px 10px',
              background: 'color-mix(in srgb, var(--red-dim) 12%, transparent)',
            }}
          >
            {preflightError}
          </div>
        ) : null}

        <div style={{ marginTop: 16, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-ghost" onClick={handlePreflight} disabled={!canRunPreflight}>
              {preflightLoading ? 'Testing SSH…' : 'Run Pre-flight'}
            </button>
            {!preflightIsFresh && preflightCheckedAt !== null ? (
              <button
                className="btn-ghost"
                onClick={() => {
                  setAllowUnsafeConnect(true);
                }}
                disabled={!canSubmit || preflightLoading}
                title="Bypass pre-flight for advanced scenarios only."
              >
                Connect anyway
              </button>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn-secondary" onClick={props.onCancel} disabled={props.loading}>
              Cancel
            </button>
            <button className="btn-primary" onClick={handleSubmit} disabled={!canConnectNow}>
              {props.loading ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function AddEndpointDialog(props: {
  readonly onCancel: () => void;
  readonly onSubmit: (config: Omit<PersistedEndpoint, 'id'>) => void;
}): JSX.Element {
  const [label, setLabel] = useState('');
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [sshUser, setSshUser] = useState('root');
  const [remoteBaseUrl, setRemoteBaseUrl] = useState('http://127.0.0.1:9700');
  const { containerRef: dialogRef, handleKeyDown: trapKeyDown } = useFocusTrap(props.onCancel);

  const parsedPort = Number(port) || 0;
  const portOk = parsedPort >= 1 && parsedPort <= 65535;
  const addErrors: string[] = [];
  if (!label.trim()) addErrors.push('Label is required.');
  if (!host.trim()) addErrors.push('SSH Host is required.');
  if (!portOk) addErrors.push('SSH Port must be 1–65535.');

  const handleSubmit = (): void => {
    if (addErrors.length > 0) return;
    props.onSubmit({
      label: label.trim(),
      host: host.trim(),
      port: parsedPort,
      sshUser: sshUser.trim() || 'root',
      remoteBaseUrl: remoteBaseUrl.trim(),
      hasToken: false,
      hasSshKeyPath: false,
    });
  };

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="add-ep-title"
      onKeyDown={trapKeyDown}
    >
      <div className="dialog-card" ref={dialogRef}>
        <h3 id="add-ep-title">Add Remote Endpoint</h3>
        <div className="dialog-form-grid">
          <div className="dialog-field">
            <span className="dialog-field-label">Label *</span>
            <input
              type="text"
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
              }}
              placeholder="My VPS"
            />
          </div>
          <div className="dialog-field">
            <span className="dialog-field-label">SSH Host *</span>
            <input
              type="text"
              value={host}
              onChange={(e) => {
                setHost(e.target.value);
              }}
              placeholder="192.168.1.100"
            />
          </div>
          <div className="dialog-form-row cols-2">
            <div className="dialog-field">
              <span className="dialog-field-label">SSH Port</span>
              <input
                type="number"
                value={port}
                onChange={(e) => {
                  setPort(e.target.value);
                }}
                min={1}
                max={65535}
              />
            </div>
            <div className="dialog-field">
              <span className="dialog-field-label">SSH User</span>
              <input
                type="text"
                value={sshUser}
                onChange={(e) => {
                  setSshUser(e.target.value);
                }}
              />
            </div>
          </div>
          <div className="dialog-field">
            <span className="dialog-field-label">Remote Base URL</span>
            <input
              type="url"
              value={remoteBaseUrl}
              onChange={(e) => {
                setRemoteBaseUrl(e.target.value);
              }}
              placeholder="http://127.0.0.1:9700"
            />
          </div>
        </div>
        {addErrors.length > 0 && (label.trim() || host.trim()) ? (
          <ul
            style={{
              margin: '10px 0 0',
              padding: '0 0 0 16px',
              fontSize: '0.75rem',
              color: 'var(--error)',
              listStyle: 'disc',
            }}
          >
            {addErrors.map((msg) => (
              <li key={msg}>{msg}</li>
            ))}
          </ul>
        ) : null}
        <div className="actions" style={{ marginTop: 18 }}>
          <button className="btn-secondary" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn-primary" onClick={handleSubmit} disabled={addErrors.length > 0}>
            Add
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectCredentialDialog(props: {
  readonly endpointId: string;
  readonly endpoint: ManagedEndpoint | null;
  readonly onCancel: () => void;
  readonly onConnect: (credentials: ConnectCredentials) => Promise<void>;
}): JSX.Element {
  const [authToken, setAuthToken] = useState('');
  const [sshKeyPath, setSshKeyPath] = useState('');
  const { containerRef: dialogRef, handleKeyDown: trapKeyDown } = useFocusTrap(props.onCancel);

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="cred-title"
      onKeyDown={trapKeyDown}
    >
      <div className="dialog-card" ref={dialogRef}>
        <h3 id="cred-title">Connect to {props.endpoint?.label ?? props.endpointId}</h3>
        <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: '8px 0 0' }}>
          Credentials are not stored. Re-enter them each time you connect.
        </p>
        <div className="dialog-form-grid">
          <div className="dialog-field">
            <span className="dialog-field-label">Auth Token (optional)</span>
            <input
              type="password"
              value={authToken}
              onChange={(e) => {
                setAuthToken(e.target.value);
              }}
              placeholder="Bearer token"
            />
          </div>
          <div className="dialog-field">
            <span className="dialog-field-label">SSH Key Path (optional)</span>
            <input
              type="text"
              value={sshKeyPath}
              onChange={(e) => {
                setSshKeyPath(e.target.value);
              }}
              placeholder="~/.ssh/id_rsa"
            />
          </div>
        </div>
        {sshKeyPath.trim() && !sshKeyPath.trim().startsWith('~/.ssh') ? (
          <p style={{ margin: '10px 0 0', fontSize: '0.75rem', color: 'var(--error)' }}>
            SSH Key must be under ~/.ssh/
          </p>
        ) : null}
        <div className="actions" style={{ marginTop: 18 }}>
          <button className="btn-secondary" onClick={props.onCancel}>
            Cancel
          </button>
          <button
            className="btn-primary"
            disabled={!!(sshKeyPath.trim() && !sshKeyPath.trim().startsWith('~/.ssh'))}
            onClick={() => {
              const creds: ConnectCredentials = {
                ...(authToken ? { authToken } : undefined),
                ...(sshKeyPath ? { sshKeyPath } : undefined),
              };
              void props.onConnect(creds);
            }}
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}

function DetachDialog(props: {
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): JSX.Element {
  const { containerRef: dialogRef, handleKeyDown } = useFocusTrap(props.onCancel);

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="detach-dialog-title"
      onKeyDown={handleKeyDown}
    >
      <div className="dialog-card" ref={dialogRef}>
        <h3 id="detach-dialog-title">Disconnect endpoint?</h3>
        <p>This will close the current connection. You can re-connect at any time.</p>
        <div className="actions">
          <button className="btn-secondary" onClick={props.onCancel}>
            Cancel
          </button>
          <button className="btn-danger" onClick={props.onConfirm}>
            Confirm Disconnect
          </button>
        </div>
      </div>
    </div>
  );
}
