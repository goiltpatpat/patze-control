import { useState, useCallback } from 'react';
import type { OpenClawAgent } from '@patze/telemetry-core';

export interface EditAgentDialogProps {
  readonly agent: OpenClawAgent;
  readonly onSubmit: (data: {
    name: string;
    emoji: string;
    systemPrompt: string;
    modelPrimary: string;
    modelFallback: string;
    enabled: boolean;
  }) => void;
  readonly onDelete: () => void;
  readonly onClose: () => void;
  readonly modelOptions: readonly { id: string; name: string }[];
}

export function EditAgentDialog(props: EditAgentDialogProps): JSX.Element {
  const { agent } = props;
  const [name, setName] = useState(agent.name);
  const [emoji, setEmoji] = useState(agent.emoji ?? '');
  const [systemPrompt, setSystemPrompt] = useState(agent.systemPrompt ?? '');
  const [modelPrimary, setModelPrimary] = useState(agent.model?.primary ?? '');
  const [modelFallback, setModelFallback] = useState(agent.model?.fallback ?? '');
  const [enabled, setEnabled] = useState(agent.enabled);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      props.onSubmit({ name, emoji, systemPrompt, modelPrimary, modelFallback, enabled });
    },
    [name, emoji, systemPrompt, modelPrimary, modelFallback, enabled, props.onSubmit]
  );

  return (
    <div className="office-interaction-overlay" onClick={props.onClose}>
      <div
        className="office-interaction-modal"
        style={{ maxWidth: 520, width: '90vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="office-interaction-modal-header">
          <h3>Edit Agent: {agent.id}</h3>
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
          <label className="dialog-form-label">
            Agent ID
            <input type="text" className="dialog-form-input" value={agent.id} disabled />
          </label>
          <label className="dialog-form-label">
            Display Name
            <input
              type="text"
              className="dialog-form-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          <label className="dialog-form-label">
            Emoji
            <input
              type="text"
              className="dialog-form-input"
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
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
              rows={3}
            />
          </label>
          <label className="dialog-form-label">
            Primary Model
            <select
              className="dialog-form-select"
              value={modelPrimary}
              onChange={(e) => setModelPrimary(e.target.value)}
            >
              <option value="">-- None --</option>
              {props.modelOptions.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
          <label className="dialog-form-label">
            Fallback Model
            <select
              className="dialog-form-select"
              value={modelFallback}
              onChange={(e) => setModelFallback(e.target.value)}
            >
              <option value="">-- None --</option>
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
            {!confirmDelete ? (
              <button
                type="button"
                className="dialog-btn-danger"
                onClick={() => setConfirmDelete(true)}
              >
                Delete
              </button>
            ) : (
              <button type="button" className="dialog-btn-danger" onClick={props.onDelete}>
                Confirm Delete
              </button>
            )}
            <div style={{ flex: 1 }} />
            <button type="button" className="dialog-btn-secondary" onClick={props.onClose}>
              Cancel
            </button>
            <button type="submit" className="dialog-btn-primary">
              Queue Update
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
