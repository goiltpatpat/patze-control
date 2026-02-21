import { useCallback, useEffect, useRef, useState } from 'react';
import { IconLink } from '../components/Icons';
import { StateBadge } from '../components/badges/StateBadge';
import type { ConnectCredentials, ManagedEndpoint, PersistedEndpoint } from '../hooks/useEndpointManager';
import type { ConnectionStatus } from '../types';

export interface TunnelEndpointRow {
  readonly endpointId: string;
  readonly baseUrl: string;
  readonly connectionState: ConnectionStatus;
  readonly forwardedPort: string;
}

export interface TunnelsViewProps {
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
}

export function TunnelsView(props: TunnelsViewProps): JSX.Element {
  const [showAddForm, setShowAddForm] = useState(false);
  const [connectModalId, setConnectModalId] = useState<string | null>(null);
  const [confirmDetachOpen, setConfirmDetachOpen] = useState(false);

  const endpoint = props.endpoints[0];
  const isConnecting = endpoint?.connectionState === 'connecting';
  const disableActions = props.isTransitioning || isConnecting;
  const canAttach = endpoint
    ? endpoint.connectionState === 'idle' || endpoint.connectionState === 'error'
    : true;
  const canReconnect = endpoint
    ? endpoint.connectionState === 'connected' || endpoint.connectionState === 'degraded' || endpoint.connectionState === 'error'
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
          <p style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No primary endpoint configured.</p>
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
                          <span className="inline-loading"><span className="mini-spinner" /> attaching</span>
                        ) : null}
                      </td>
                      <td className="mono">{row.forwardedPort}</td>
                      <td>
                        <div className="actions" style={{ gap: 6 }}>
                          <button className="btn-primary" onClick={props.onAttach} disabled={disableActions || !canAttach} style={{ fontSize: '0.75rem', padding: '3px 10px' }}>
                            Connect
                          </button>
                          <button className="btn-secondary" onClick={props.onReconnect} disabled={disableActions || !canReconnect} style={{ fontSize: '0.75rem', padding: '3px 10px' }}>
                            Reconnect
                          </button>
                          <button className="btn-danger" onClick={() => { setConfirmDetachOpen(true); }} disabled={disableActions || !canDetach} style={{ fontSize: '0.75rem', padding: '3px 10px' }}>
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

      <div className="settings-section">
        <h3 className="settings-section-title">
          Remote Endpoints
          <button
            className="btn-primary"
            style={{ marginLeft: 12, fontSize: '0.75rem', padding: '3px 10px' }}
            onClick={() => { setShowAddForm(true); }}
          >
            + Add
          </button>
        </h3>

        {props.remoteEndpoints.length === 0 && !showAddForm ? (
          <div className="empty-state">
            <div className="empty-state-icon"><IconLink width={28} height={28} /></div>
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
                        <span className={`status-dot`} data-status={ep.status === 'connected' ? 'connected' : ep.status === 'error' ? 'error' : 'idle'} style={{ marginRight: 6 }} />
                        {ep.status}
                        {ep.errorMessage ? (
                          <span className="error" style={{ marginLeft: 6, fontSize: '0.75rem' }} title={ep.errorMessage}>
                            {ep.errorMessage.length > 30 ? `${ep.errorMessage.slice(0, 30)}…` : ep.errorMessage}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <div className="actions" style={{ gap: 6 }}>
                          {ep.status === 'disconnected' || ep.status === 'error' ? (
                            <button
                              className="btn-primary"
                              style={{ fontSize: '0.75rem', padding: '3px 10px' }}
                              onClick={() => { setConnectModalId(ep.id); }}
                            >
                              Connect
                            </button>
                          ) : ep.status === 'connected' ? (
                            <button
                              className="btn-secondary"
                              style={{ fontSize: '0.75rem', padding: '3px 10px' }}
                              onClick={() => { void props.onDisconnectEndpoint(ep.id); }}
                            >
                              Disconnect
                            </button>
                          ) : (
                            <span className="mini-spinner" />
                          )}
                          <button
                            className="btn-danger"
                            style={{ fontSize: '0.75rem', padding: '3px 10px' }}
                            onClick={() => { props.onRemoveEndpoint(ep.id); }}
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

      {showAddForm ? (
        <AddEndpointDialog
          onCancel={() => { setShowAddForm(false); }}
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
          onCancel={() => { setConnectModalId(null); }}
          onConnect={async (creds) => {
            setConnectModalId(null);
            await props.onConnectEndpoint(connectModalId, creds);
          }}
        />
      ) : null}

      {confirmDetachOpen ? (
        <DetachDialog
          onCancel={() => { setConfirmDetachOpen(false); }}
          onConfirm={() => {
            setConfirmDetachOpen(false);
            props.onDetach();
          }}
        />
      ) : null}
    </section>
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
  const [remoteBaseUrl, setRemoteBaseUrl] = useState('http://127.0.0.1:8080');
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = dialogRef.current?.querySelector<HTMLInputElement>('input');
    el?.focus();
  }, []);

  const handleSubmit = (): void => {
    if (!label.trim() || !host.trim()) return;
    props.onSubmit({
      label: label.trim(),
      host: host.trim(),
      port: Number(port) || 22,
      sshUser: sshUser.trim() || 'root',
      remoteBaseUrl: remoteBaseUrl.trim(),
      hasToken: false,
      hasSshKeyPath: false,
    });
  };

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="add-ep-title"
      onKeyDown={(e) => { if (e.key === 'Escape') props.onCancel(); }}
    >
      <div className="dialog-card" ref={dialogRef} style={{ maxWidth: 440 }}>
        <h3 id="add-ep-title">Add Remote Endpoint</h3>
        <div className="settings-grid" style={{ gap: 10, marginTop: 12 }}>
          <div className="context-field">
            <span className="context-field-label">Label</span>
            <input type="text" value={label} onChange={(e) => { setLabel(e.target.value); }} placeholder="My VPS" />
          </div>
          <div className="context-field">
            <span className="context-field-label">SSH Host</span>
            <input type="text" value={host} onChange={(e) => { setHost(e.target.value); }} placeholder="192.168.1.100" />
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            <div className="context-field">
              <span className="context-field-label">SSH Port</span>
              <input type="number" value={port} onChange={(e) => { setPort(e.target.value); }} />
            </div>
            <div className="context-field">
              <span className="context-field-label">SSH User</span>
              <input type="text" value={sshUser} onChange={(e) => { setSshUser(e.target.value); }} />
            </div>
          </div>
          <div className="context-field">
            <span className="context-field-label">Remote Base URL</span>
            <input type="url" value={remoteBaseUrl} onChange={(e) => { setRemoteBaseUrl(e.target.value); }} />
          </div>
        </div>
        <div className="actions" style={{ marginTop: 16 }}>
          <button className="btn-secondary" onClick={props.onCancel}>Cancel</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={!label.trim() || !host.trim()}>Add</button>
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
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = dialogRef.current?.querySelector<HTMLInputElement>('input');
    el?.focus();
  }, []);

  return (
    <div className="dialog-backdrop" role="dialog" aria-modal="true" aria-labelledby="cred-title"
      onKeyDown={(e) => { if (e.key === 'Escape') props.onCancel(); }}
    >
      <div className="dialog-card" ref={dialogRef} style={{ maxWidth: 400 }}>
        <h3 id="cred-title">Connect to {props.endpoint?.label ?? props.endpointId}</h3>
        <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: '8px 0' }}>
          Credentials are not stored. You will need to re-enter them next time.
        </p>
        <div className="settings-grid" style={{ gap: 10, marginTop: 12 }}>
          <div className="context-field">
            <span className="context-field-label">Auth Token (optional)</span>
            <input type="password" value={authToken} onChange={(e) => { setAuthToken(e.target.value); }} placeholder="Bearer token" />
          </div>
          <div className="context-field">
            <span className="context-field-label">SSH Key Path (optional)</span>
            <input type="text" value={sshKeyPath} onChange={(e) => { setSshKeyPath(e.target.value); }} placeholder="~/.ssh/id_rsa" />
          </div>
        </div>
        <div className="actions" style={{ marginTop: 16 }}>
          <button className="btn-secondary" onClick={props.onCancel}>Cancel</button>
          <button className="btn-primary" onClick={() => {
            const creds: ConnectCredentials = {
              ...(authToken ? { authToken } : undefined),
              ...(sshKeyPath ? { sshKeyPath } : undefined),
            };
            void props.onConnect(creds);
          }}>
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        props.onCancel();
        return;
      }

      if (e.key !== 'Tab' || !dialogRef.current) {
        return;
      }

      const focusable = dialogRef.current.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusable.length === 0) {
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];

      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    },
    [props]
  );

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
          <button className="btn-secondary" ref={cancelRef} onClick={props.onCancel}>
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
