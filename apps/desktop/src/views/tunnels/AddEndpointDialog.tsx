import { useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import type { PersistedEndpoint } from './types';

export function AddEndpointDialog(props: {
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
