import { useState, useCallback, useEffect } from 'react';

export interface CreateModelDialogProps {
  readonly onSubmit: (data: {
    id: string;
    name: string;
    provider: string;
    model: string;
    apiKey: string;
    baseUrl: string;
    enabled: boolean;
  }) => void;
  readonly initialProvider?: string | undefined;
  readonly initialModel?: string | undefined;
  readonly initialName?: string | undefined;
  readonly onClose: () => void;
}

const PROVIDERS = ['openai', 'anthropic', 'google', 'moonshot', 'xai', 'custom'] as const;

const MODEL_CATALOG: Record<string, readonly string[]> = {
  openai: ['gpt-4o', 'gpt-4o-mini', 'gpt-4-turbo', 'gpt-3.5-turbo', 'o1-preview', 'o1-mini'],
  anthropic: [
    'claude-sonnet-4-20250514',
    'claude-3-5-sonnet-20241022',
    'claude-3-haiku-20240307',
    'claude-3-opus-20240229',
  ],
  google: ['gemini-2.0-flash', 'gemini-1.5-pro', 'gemini-1.5-flash'],
  moonshot: ['kimi-k2.5'],
  xai: ['grok-4', 'grok-4-fast'],
};

export function CreateModelDialog(props: CreateModelDialogProps): JSX.Element {
  const initialProvider =
    typeof props.initialProvider === 'string' && props.initialProvider.trim().length > 0
      ? props.initialProvider.trim()
      : 'openai';
  const initialModel =
    typeof props.initialModel === 'string' && props.initialModel.trim().length > 0
      ? props.initialModel.trim()
      : '';
  const [name, setName] = useState(props.initialName ?? '');
  const [provider, setProvider] = useState<string>(initialProvider);
  const [modelSelect, setModelSelect] = useState('');
  const [customModel, setCustomModel] = useState(initialModel);
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const catalog = MODEL_CATALOG[provider] ?? [];
  const isCustom = modelSelect === '__custom';
  const effectiveModel = catalog.length === 0 ? customModel : isCustom ? customModel : modelSelect;

  useEffect(() => {
    if (provider !== initialProvider) {
      return;
    }
    const providerCatalog = MODEL_CATALOG[provider] ?? [];
    if (providerCatalog.includes(initialModel)) {
      setModelSelect(initialModel);
      setCustomModel('');
      return;
    }
    if (initialModel.length > 0) {
      setModelSelect('__custom');
      setCustomModel(initialModel);
    }
  }, [initialModel, initialProvider, provider]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      if (!effectiveModel.trim()) {
        setError('Model name is required');
        return;
      }
      setError(null);
      const normalizedId = `${provider}/${effectiveModel.trim()}`;
      props.onSubmit({
        id: normalizedId,
        name: name || normalizedId,
        provider,
        model: effectiveModel.trim(),
        apiKey,
        baseUrl,
        enabled,
      });
    },
    [name, provider, effectiveModel, apiKey, baseUrl, enabled, props.onSubmit]
  );

  return (
    <div className="office-interaction-overlay" onClick={props.onClose}>
      <div
        className="office-interaction-modal"
        style={{ maxWidth: 520, width: '90vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="office-interaction-modal-header">
          <h3>+ Add Model Profile</h3>
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
            Display Name
            <input
              type="text"
              className="dialog-form-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Model"
              autoFocus
            />
          </label>
          <label className="dialog-form-label">
            Provider *
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
            Model *
            {catalog.length > 0 ? (
              <select
                className="dialog-form-select"
                value={modelSelect}
                onChange={(e) => setModelSelect(e.target.value)}
              >
                <option value="">-- Select --</option>
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
          {isCustom ? (
            <label className="dialog-form-label">
              Custom Model ID
              <input
                type="text"
                className="dialog-form-input"
                value={customModel}
                onChange={(e) => setCustomModel(e.target.value)}
                placeholder="Enter model ID"
                autoFocus
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
              placeholder="sk-..."
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
