import { useCallback, useEffect, useRef, useState } from 'react';
import { IconFolder } from '../../components/Icons';

export interface NewFolderDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreate: (name: string) => void;
}

export function NewFolderDialog(props: NewFolderDialogProps): JSX.Element | null {
  const { open, onClose, onCreate } = props;
  const [name, setName] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName('');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const handleSubmit = useCallback(() => {
    const trimmed = name.trim();
    if (trimmed) {
      onCreate(trimmed);
    }
  }, [name, onCreate]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-card fm-dialog-sm" onClick={(e) => e.stopPropagation()}>
        <div className="fm-conn-dialog-icon">
          <IconFolder />
        </div>
        <h3>New Folder</h3>
        <p>Create a new directory in the current location.</p>
        <div className="dialog-form-grid">
          <div className="dialog-field">
            <label className="dialog-field-label">Folder name</label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="new-folder"
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleSubmit();
                if (e.key === 'Escape') onClose();
              }}
            />
          </div>
        </div>
        <div className="fm-conn-dialog-actions">
          <button className="fm-btn fm-btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button className="fm-btn fm-btn-primary" onClick={handleSubmit} disabled={!name.trim()}>
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
