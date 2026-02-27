import { useState } from 'react';

interface AddTargetFormProps {
  readonly onSubmit: (input: {
    label: string;
    type: 'local' | 'remote';
    purpose: 'production' | 'test';
    openclawDir: string;
    pollIntervalMs: number;
  }) => void;
  readonly onCancel: () => void;
  readonly initialValues?: {
    readonly label: string;
    readonly type: 'local' | 'remote';
    readonly purpose: 'production' | 'test';
    readonly openclawDir: string;
    readonly pollIntervalMs: number;
  };
  readonly title?: string;
  readonly submitLabel?: string;
}

export function AddTargetForm(props: AddTargetFormProps): JSX.Element {
  const [label, setLabel] = useState(props.initialValues?.label ?? '');
  const [type, setType] = useState<'local' | 'remote'>(props.initialValues?.type ?? 'local');
  const [purpose, setPurpose] = useState<'production' | 'test'>(
    props.initialValues?.purpose ?? 'production'
  );
  const [dir, setDir] = useState(props.initialValues?.openclawDir ?? '~/.openclaw');
  const [interval, setInterval] = useState(
    String(Math.max(5, Math.round((props.initialValues?.pollIntervalMs ?? 30_000) / 1000)))
  );

  const canSubmit = label.trim().length > 0 && dir.trim().length > 0;
  const title = props.title ?? 'Add OpenClaw Target';
  const submitLabel = props.submitLabel ?? 'Add Target';

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
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>{title}</h3>
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
            <label className="dialog-field-label">Purpose</label>
            <select
              value={purpose}
              onChange={(e) => {
                setPurpose(e.target.value as 'production' | 'test');
              }}
            >
              <option value="production">Production</option>
              <option value="test">Test / Sandbox</option>
            </select>
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
        </div>
      </div>
      <div className="actions" style={{ marginTop: 16 }}>
        <button
          className="btn-primary"
          disabled={!canSubmit}
          onClick={() => {
            props.onSubmit({
              label: label.trim(),
              type,
              purpose,
              openclawDir: dir.trim(),
              pollIntervalMs: Math.max(5, parseInt(interval, 10) || 30) * 1000,
            });
          }}
        >
          {submitLabel}
        </button>
        <button className="btn-secondary" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
