import { useCallback, useEffect, useRef, useState } from 'react';
import { IconEdit } from '../../components/Icons';

export interface RenameDialogProps {
  readonly open: boolean;
  readonly currentName: string;
  readonly onClose: () => void;
  readonly onRename: (newName: string) => void;
}

export function RenameDialog(props: RenameDialogProps): JSX.Element | null {
  const { open, currentName, onClose, onRename } = props;
  const [name, setName] = useState(currentName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName(currentName);
      requestAnimationFrame(() => inputRef.current?.select());
    }
  }, [open, currentName]);

  const handleSubmit = useCallback(() => {
    const trimmed = name.trim();
    if (trimmed && trimmed !== currentName) {
      onRename(trimmed);
    }
  }, [name, currentName, onRename]);

  if (!open) return null;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div className="dialog-card fm-dialog-sm" onClick={(e) => e.stopPropagation()}>
        <div className="fm-conn-dialog-icon">
          <IconEdit />
        </div>
        <h3>Rename</h3>
        <p>
          Renaming <strong>{currentName}</strong>
        </p>
        <div className="dialog-form-grid">
          <div className="dialog-field">
            <label className="dialog-field-label">New name</label>
            <input
              ref={inputRef}
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
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
          <button
            className="fm-btn fm-btn-primary"
            onClick={handleSubmit}
            disabled={!name.trim() || name.trim() === currentName}
          >
            Rename
          </button>
        </div>
      </div>
    </div>
  );
}
