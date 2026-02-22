import { useState } from 'react';
import { NotificationCenter } from '../components/NotificationCenter';
import type { UseNotificationsResult } from '../hooks/useNotifications';
import type { ConnectionStatus } from '../types';
import { IconSearch } from '../components/Icons';

export interface TopMachineContextBarProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly status: ConnectionStatus;
  readonly errorMessage: string | null;
  readonly onBaseUrlChange: (value: string) => void;
  readonly onTokenChange: (value: string) => void;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly notifications: UseNotificationsResult;
  readonly onOpenPalette: () => void;
}

function toStatusLabel(status: ConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'degraded':
      return 'Degraded';
    case 'connecting':
      return 'Connecting…';
    case 'error':
      return 'Error';
    case 'idle':
      return 'Idle';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function TopMachineContextBar(props: TopMachineContextBarProps): JSX.Element {
  const isConnecting = props.status === 'connecting';
  const isConnected = props.status === 'connected' || props.status === 'degraded';
  const [expanded, setExpanded] = useState(false);

  const showCompact = isConnected && !expanded;

  return (
    <header className="context-bar">
      <div className="context-brand">
        <div className="brand-icon">PC</div>
        <h1>Patze Control</h1>
      </div>

      <div className="context-divider" />

      {showCompact ? (
        <div className="context-controls context-controls-compact">
          <span className="mono" style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>
            {props.baseUrl}
          </span>
          <button
            className="btn-secondary"
            style={{ fontSize: '0.72rem', padding: '2px 8px' }}
            onClick={() => {
              setExpanded(true);
            }}
          >
            Edit
          </button>
        </div>
      ) : (
        <div className="context-controls">
          <div className="context-field">
            <span className="context-field-label">Endpoint</span>
            <input
              type="url"
              data-field="url"
              aria-label="Control plane endpoint URL"
              value={props.baseUrl}
              placeholder="http://127.0.0.1:9700"
              onChange={(event) => {
                props.onBaseUrlChange(event.target.value);
              }}
              disabled={isConnecting}
            />
          </div>
          <div className="context-field">
            <span className="context-field-label">Token</span>
            <input
              type="password"
              data-field="token"
              aria-label="Authentication token"
              value={props.token}
              placeholder="optional"
              onChange={(event) => {
                props.onTokenChange(event.target.value);
              }}
              disabled={isConnecting}
            />
          </div>
          <div className="context-actions">
            <button
              className="btn-primary"
              onClick={props.onConnect}
              disabled={isConnecting || isConnected}
            >
              {isConnecting ? 'Connecting…' : 'Connect'}
            </button>
            <button
              className="btn-secondary"
              onClick={props.onDisconnect}
              disabled={!isConnected && !isConnecting}
            >
              Disconnect
            </button>
            {isConnected ? (
              <button
                className="btn-secondary"
                style={{ fontSize: '0.72rem', padding: '2px 8px' }}
                onClick={() => {
                  setExpanded(false);
                }}
              >
                Collapse
              </button>
            ) : null}
          </div>
        </div>
      )}

      {/* Search + Notifications + Status */}
      <div className="context-status-indicator">
        <button
          className="notification-bell"
          title="Search (⌘K)"
          onClick={props.onOpenPalette}
          style={{ marginRight: 2 }}
        >
          <IconSearch width={15} height={15} />
        </button>
        <NotificationCenter notifications={props.notifications} />
        <span className="context-divider" style={{ height: 18, margin: '0 6px' }} />
        <span className="status-dot" data-status={props.status} />
        <span className="status-label">{toStatusLabel(props.status)}</span>
        {props.errorMessage ? (
          <span className="error-hint" title={props.errorMessage}>
            {props.errorMessage}
          </span>
        ) : null}
      </div>
    </header>
  );
}
