import { useState, useCallback } from 'react';

export interface CreateAgentDialogProps {
  readonly onSubmit: (data: {
    id: string;
    name: string;
    emoji: string;
    systemPrompt: string;
    modelPrimary: string;
    enabled: boolean;
  }) => void;
  readonly onClose: () => void;
  readonly modelOptions: readonly { id: string; name: string }[];
}

export function CreateAgentDialog(props: CreateAgentDialogProps): JSX.Element {
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [modelPrimary, setModelPrimary] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const trimmedId = id.trim();
      if (!trimmedId) {
        setError('Agent ID is required');
        return;
      }
      if (!/^[a-zA-Z0-9_-]+$/.test(trimmedId)) {
        setError('Agent ID must be alphanumeric (hyphens and underscores allowed)');
        return;
      }
      setError(null);
      props.onSubmit({ id: trimmedId, name, emoji, systemPrompt, modelPrimary, enabled });
    },
    [id, name, emoji, systemPrompt, modelPrimary, enabled, props.onSubmit]
  );

  return (
    <div className="office-interaction-overlay" onClick={props.onClose}>
      <div
        className="office-interaction-modal"
        style={{ maxWidth: 520, width: '90vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="office-interaction-modal-header">
          <h3>+ New Agent</h3>
          <button
            type="button"
            className="office-agent-panel-close"
            aria-label="Close"
            onClick={props.onClose}
          >
            &times;
          </button>
        </div>
        <form onSubmit={handleSubmit} className="dialog-form-grid">
          {error ? (
            <div className="dialog-form-error" role="alert">
              {error}
            </div>
          ) : null}
          <label className="dialog-form-label">
            Agent ID *
            <input
              type="text"
              className="dialog-form-input"
              value={id}
              onChange={(e) => setId(e.target.value)}
              placeholder="my-agent"
              autoFocus
            />
          </label>
          <label className="dialog-form-label">
            Display Name
            <input
              type="text"
              className="dialog-form-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Agent"
            />
          </label>
          <label className="dialog-form-label">
            Emoji
            <input
              type="text"
              className="dialog-form-input"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              placeholder="🤖"
              maxLength={4}
              style={{ width: 60 }}
            />
          </label>
          <label className="dialog-form-label">
            System Prompt
            <textarea
              className="dialog-form-textarea"
              value={systemPrompt}
              onChange={(e) => setSystemPrompt(e.target.value)}
              placeholder="You are a helpful assistant..."
              rows={3}
            />
          </label>
          <label className="dialog-form-label">
            Model
            <select
              className="dialog-form-select"
              value={modelPrimary}
              onChange={(e) => setModelPrimary(e.target.value)}
            >
              <option value="">-- Select model --</option>
              {props.modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="dialog-form-label dialog-form-toggle">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Enabled
          </label>
          <div className="dialog-form-actions">
            <button type="button" className="dialog-btn-secondary" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" className="dialog-btn-primary">
              Queue Create
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
