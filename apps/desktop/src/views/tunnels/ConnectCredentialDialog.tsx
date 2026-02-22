import { useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { ConnectCredentials, ManagedEndpoint } from './types';

export function ConnectCredentialDialog(props: {
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
