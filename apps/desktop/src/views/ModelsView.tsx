import { useState, useEffect, useCallback } from 'react';
import { IconCpu, IconPlus, IconTrash } from '../components/Icons';
import type { OpenClawModelProfile } from '@patze/telemetry-core';
import { CreateModelDialog } from './models/CreateModelDialog';

export interface ModelsViewProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly connected: boolean;
  readonly targetId: string | null;
}

const PROVIDER_COLORS: Record<string, string> = {
  openai: '#10a37f',
  anthropic: '#d4a574',
  google: '#4285f4',
  custom: '#888',
};

export function ModelsView(props: ModelsViewProps): JSX.Element {
  const { baseUrl, token, connected, targetId } = props;
  const [models, setModels] = useState<readonly OpenClawModelProfile[]>([]);
  const [showCreate, setShowCreate] = useState(false);

  const fetchModels = useCallback(async () => {
    if (!connected || !targetId) return;
    try {
      const res = await fetch(
        `${baseUrl}/openclaw/targets/${encodeURIComponent(targetId)}/models`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      if (res.ok) {
        const data = (await res.json()) as { models: OpenClawModelProfile[] };
        setModels(data.models);
      }
    } catch {
      /* ignore */
    }
  }, [baseUrl, token, connected, targetId]);

  useEffect(() => {
    void fetchModels();
  }, [fetchModels]);

  const queueCommand = useCallback(
    async (commands: readonly { command: string; args: string[]; description: string }[]) => {
      if (!targetId) return;
      try {
        await fetch(`${baseUrl}/openclaw/queue`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetId, commands }),
        });
      } catch {
        /* ignore */
      }
    },
    [baseUrl, token, targetId]
  );

  const handleCreate = useCallback(
    (data: { id: string; name: string; provider: string; model: string; apiKey: string; baseUrl: string; enabled: boolean }) => {
      const cmds: { command: string; args: string[]; description: string }[] = [];
      if (data.name) cmds.push({ command: 'openclaw', args: ['config', 'set', `models.${data.id}.name`, data.name], description: `Set model name` });
      cmds.push({ command: 'openclaw', args: ['config', 'set', `models.${data.id}.provider`, data.provider], description: `Set provider` });
      cmds.push({ command: 'openclaw', args: ['config', 'set', `models.${data.id}.model`, data.model], description: `Set model ID` });
      if (data.apiKey) cmds.push({ command: 'openclaw', args: ['config', 'set', `models.${data.id}.apiKey`, data.apiKey], description: `Set API key` });
      if (data.baseUrl) cmds.push({ command: 'openclaw', args: ['config', 'set', `models.${data.id}.baseUrl`, data.baseUrl], description: `Set base URL` });
      if (!data.enabled) cmds.push({ command: 'openclaw', args: ['config', 'set', `models.${data.id}.enabled`, 'false'], description: `Disable model` });
      void queueCommand(cmds);
      setShowCreate(false);
    },
    [queueCommand]
  );

  const handleDelete = useCallback(
    (modelId: string) => {
      void queueCommand([
        { command: 'openclaw', args: ['config', 'unset', `models.${modelId}`], description: `Remove model "${modelId}"` },
      ]);
    },
    [queueCommand]
  );

  const handleSetDefault = useCallback(
    (modelId: string) => {
      void queueCommand([
        { command: 'openclaw', args: ['config', 'set', 'agents.defaults.model.primary', modelId], description: `Set default model to "${modelId}"` },
      ]);
    },
    [queueCommand]
  );

  const isConnected = connected && targetId;

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Model Profiles</h2>
        {isConnected ? (
          <button
            type="button"
            className="dialog-btn-primary"
            style={{ marginLeft: 'auto' }}
            onClick={() => setShowCreate(true)}
          >
            <IconPlus width={14} height={14} /> Add Model
          </button>
        ) : null}
      </div>

      {!isConnected ? (
        <div className="empty-state">
          <div className="empty-state-icon"><IconCpu width={28} height={28} /></div>
          <p style={{ margin: '4px 0 0' }}>Connect an OpenClaw instance to manage models.</p>
        </div>
      ) : models.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><IconCpu width={28} height={28} /></div>
          <p style={{ margin: '4px 0 0' }}>No model profiles configured yet.</p>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
            Add a model profile to get started.
          </p>
        </div>
      ) : (
        <div className="machine-grid">
          {models.map((model) => (
            <div key={model.id} className="machine-card">
              <div className="machine-card-header">
                <div className="machine-card-title">
                  <span
                    className="model-provider-dot"
                    style={{ background: PROVIDER_COLORS[model.provider] ?? '#888' }}
                  />
                  <span className="machine-card-name">{model.name || model.id}</span>
                </div>
                <span className={`badge ${model.enabled ? 'tone-ok' : 'tone-muted'}`}>
                  {model.enabled ? 'enabled' : 'disabled'}
                </span>
              </div>
              <div className="machine-card-meta">
                <div className="machine-card-meta-item">
                  <span className="machine-card-meta-label">Provider</span>
                  <span className="machine-card-meta-value">{model.provider}</span>
                </div>
                <div className="machine-card-meta-item">
                  <span className="machine-card-meta-label">Model</span>
                  <span className="machine-card-meta-value">{model.model}</span>
                </div>
                <div className="machine-card-meta-item">
                  <span className="machine-card-meta-label">API Key</span>
                  <span className="machine-card-meta-value">{model.apiKey ? '••••••' : 'not set'}</span>
                </div>
                {model.baseUrl ? (
                  <div className="machine-card-meta-item">
                    <span className="machine-card-meta-label">Base URL</span>
                    <span className="machine-card-meta-value" style={{ fontSize: '0.7rem' }}>{model.baseUrl}</span>
                  </div>
                ) : null}
              </div>
              <div className="model-card-actions">
                <button type="button" className="card-action-btn" onClick={() => handleSetDefault(model.id)} title="Set as default model">
                  Set Default
                </button>
                <button type="button" className="card-action-btn card-action-danger" onClick={() => handleDelete(model.id)} title="Remove model">
                  <IconTrash width={13} height={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate ? (
        <CreateModelDialog
          onSubmit={handleCreate}
          onClose={() => setShowCreate(false)}
        />
      ) : null}
    </section>
  );
}
