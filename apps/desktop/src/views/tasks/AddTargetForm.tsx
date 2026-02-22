import { useState } from 'react';

interface AddTargetFormProps {
  readonly onAdd: (input: {
    label: string;
    type: 'local' | 'remote';
    openclawDir: string;
    pollIntervalMs: number;
  }) => void;
  readonly onCancel: () => void;
}

export function AddTargetForm(props: AddTargetFormProps): JSX.Element {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<'local' | 'remote'>('local');
  const [dir, setDir] = useState('~/.openclaw');
  const [interval, setInterval] = useState('30');

  const canSubmit = label.trim().length > 0 && dir.trim().length > 0;

  return (
    <div className="panel" style={{ padding: 20 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 14,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Add OpenClaw Target</h3>
      </div>
      <div className="dialog-form-grid" style={{ marginTop: 0 }}>
        <div className="dialog-form-row cols-2">
          <div className="dialog-field">
            <label className="dialog-field-label">Label</label>
            <input
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
              }}
              placeholder="e.g. Production VPS"
            />
          </div>
          <div className="dialog-field">
            <label className="dialog-field-label">Type</label>
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value as 'local' | 'remote');
              }}
            >
              <option value="local">Local</option>
              <option value="remote">Remote</option>
            </select>
          </div>
        </div>
        <div className="dialog-form-row cols-2">
          <div className="dialog-field">
            <label className="dialog-field-label">OpenClaw Directory</label>
            <input
              value={dir}
              onChange={(e) => {
                setDir(e.target.value);
              }}
              placeholder="/home/user/.openclaw"
            />
          </div>
          <div className="dialog-field">
            <label className="dialog-field-label">Poll Interval (seconds)</label>
            <input
              type="number"
              min="5"
              value={interval}
              onChange={(e) => {
                setInterval(e.target.value);
              }}
            />
          </div>
        </div>
      </div>
      <div className="actions" style={{ marginTop: 16 }}>
        <button
          className="btn-primary"
          disabled={!canSubmit}
          onClick={() => {
            props.onAdd({
              label: label.trim(),
              type,
              openclawDir: dir.trim(),
              pollIntervalMs: Math.max(5, parseInt(interval, 10) || 30) * 1000,
            });
          }}
        >
          Add Target
        </button>
        <button className="btn-secondary" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
