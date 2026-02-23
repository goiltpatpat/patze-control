import { useState } from 'react';
import { IconLink, IconServer } from '../../components/Icons';
import { StateBadge } from '../../components/badges/StateBadge';
import type { TunnelsViewProps } from './types';
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
