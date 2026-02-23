import { useCallback, useEffect, useRef, useState } from 'react';
import { IconServer } from '../../components/Icons';

export interface AddConnectionDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onAdd: (conn: {
    label: string;
    host: string;
    port: number;
    user: string;
    keyPath: string;
  }) => void;
}

export function AddConnectionDialog(props: AddConnectionDialogProps): JSX.Element | null {
  const { open, onClose, onAdd } = props;
  const [host, setHost] = useState('');
  const [port, setPort] = useState('22');
  const [user, setUser] = useState('root');
  const [keyPath, setKeyPath] = useState('~/.ssh/id_rsa');
  const [label, setLabel] = useState('');
  const hostRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      requestAnimationFrame(() => hostRef.current?.focus());
    }
  }, [open]);

  const handleSubmit = useCallback(() => {
    if (!host.trim() || !user.trim() || !keyPath.trim()) return;
    onAdd({
      label: label.trim() || `${user}@${host}`,
      host: host.trim(),
      port: parseInt(port, 10) || 22,
      user: user.trim(),
      keyPath: keyPath.trim(),
    });
    setHost('');
    setPort('22');
    setUser('root');
    setKeyPath('~/.ssh/id_rsa');
    setLabel('');
  }, [host, port, user, keyPath, label, onAdd]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Enter' && host.trim() && user.trim() && keyPath.trim()) handleSubmit();
    },
    [onClose, host, user, keyPath, handleSubmit]
  );

  if (!open) return null;

  const preview = host.trim()
    ? `${user || 'root'}@${host}${port && port !== '22' ? ':' + port : ''}`
    : '';

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog-card fm-conn-dialog"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={handleKeyDown}
      >
        <div className="fm-conn-dialog-icon">
          <IconServer />
        </div>
        <h3>New SSH Connection</h3>
        {preview && <p className="fm-conn-preview">{preview}</p>}
        {!preview && <p>Enter the SSH details for your remote server.</p>}

        <div className="dialog-form-grid">
          <div className="dialog-form-row cols-2">
            <div className="dialog-field">
              <label className="dialog-field-label">Host</label>
              <input
                ref={hostRef}
                type="text"
                value={host}
                onChange={(e) => setHost(e.target.value)}
                placeholder="192.168.1.100"
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-field-label">Port</label>
              <input type="number" value={port} onChange={(e) => setPort(e.target.value)} />
            </div>
          </div>

          <div className="dialog-form-row cols-2">
            <div className="dialog-field">
              <label className="dialog-field-label">Username</label>
              <input
                type="text"
                value={user}
                onChange={(e) => setUser(e.target.value)}
                placeholder="root"
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-field-label">Label (optional)</label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="My VPS"
              />
            </div>
          </div>

          <div className="dialog-field">
            <label className="dialog-field-label">SSH Key Path</label>
            <input
              type="text"
              value={keyPath}
              onChange={(e) => setKeyPath(e.target.value)}
              placeholder="~/.ssh/id_rsa"
            />
          </div>
        </div>

        <div className="fm-conn-dialog-actions">
          <button className="fm-btn fm-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            className="fm-btn fm-btn-primary"
            onClick={handleSubmit}
            disabled={!host.trim() || !user.trim() || !keyPath.trim()}
          >
            Connect
          </button>
        </div>
      </div>
    </div>
  );
}
