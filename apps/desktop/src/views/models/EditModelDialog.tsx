import { useState, useCallback } from 'react';
import type { OpenClawModelProfile } from '@patze/telemetry-core';

export interface EditModelDialogProps {
  readonly model: OpenClawModelProfile;
  readonly onSubmit: (data: {
    name: string;
    provider: string;
    model: string;
    apiKey: string;
    baseUrl: string;
    enabled: boolean;
  }) => void;
  readonly onDelete: () => void;
  readonly onClose: () => void;
}

const PROVIDERS = ['openai', 'anthropic', 'google', 'custom'] as const;

const MODEL_CATALOG: Record<string, readonly string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1-preview', 'o1-mini'],
  anthropic: [
    'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-20241022',
    'claude-3-haiku-20240307',
    'claude-3-opus-20240229',
  ],
  google: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
};

export function EditModelDialog(props: EditModelDialogProps): JSX.Element {
  const { model } = props;
  const [name, setName] = useState(model.name || model.id);
  const [provider, setProvider] = useState(model.provider);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState(model.baseUrl ?? '');
  const [enabled, setEnabled] = useState(model.enabled);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const catalog = MODEL_CATALOG[provider] ?? [];
  const currentInCatalog = catalog.includes(model.model);
  const [modelSelect, setModelSelect] = useState(currentInCatalog ? model.model : '__custom');
  const [customModel, setCustomModel] = useState(currentInCatalog ? '' : model.model);

  const isCustom = modelSelect === '__custom';
  const effectiveModel = catalog.length === 0 ? customModel : isCustom ? customModel : modelSelect;

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      props.onSubmit({
        name,
        provider,
        model: effectiveModel.trim() || model.model,
        apiKey,
        baseUrl,
        enabled,
      });
    },
    [name, provider, effectiveModel, model.model, apiKey, baseUrl, enabled, props.onSubmit]
  );

  return (
    <div className="office-interaction-overlay" onClick={props.onClose}>
      <div
        className="office-interaction-modal"
        style={{ maxWidth: 520, width: '90vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="office-interaction-modal-header">
          <h3>Edit Model: {model.id}</h3>
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
            Profile ID
            <input type="text" className="dialog-form-input" value={model.id} disabled />
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
            Provider
            <select
              className="dialog-form-select"
              value={provider}
              onChange={(e) => setProvider(e.target.value)}
            >
              {PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="dialog-form-label">
            Model
            {catalog.length > 0 ? (
              <select
                className="dialog-form-select"
                value={modelSelect}
                onChange={(e) => setModelSelect(e.target.value)}
              >
                {catalog.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="__custom">Custom...</option>
              </select>
            ) : (
              <input
                type="text"
                className="dialog-form-input"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder="model-id"
              />
            )}
          </label>
          {isCustom && catalog.length > 0 ? (
            <label className="dialog-form-label">
              Custom Model ID
              <input
                type="text"
                className="dialog-form-input"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder={model.model}
              />
            </label>
          ) : null}
          <label className="dialog-form-label">
            API Key
            <input
              type="password"
              className="dialog-form-input"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={model.apiKey ? '••••••  (leave blank to keep)' : 'sk-...'}
            />
          </label>
          <label className="dialog-form-label">
            Base URL (optional)
            <input
              type="text"
              className="dialog-form-input"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              placeholder="https://api.example.com"
            />
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
