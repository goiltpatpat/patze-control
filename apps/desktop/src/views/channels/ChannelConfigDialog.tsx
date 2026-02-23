import { useState, useCallback } from 'react';

export interface ChannelConfigDialogProps {
  readonly channelId: string;
  readonly channelName: string;
  readonly initialEnabled?: boolean | undefined;
  readonly initialDmPolicy?: string | undefined;
  readonly initialGroupPolicy?: string | undefined;
  readonly agentOptions: readonly { id: string; name: string }[];
  readonly modelOptions: readonly { id: string; name: string }[];
  readonly onSubmit: (data: {
    enabled?: boolean;
    dmPolicy?: string;
    groupPolicy?: string;
    modelOverride?: string;
  }) => void;
  readonly onBind: (agentId: string, modelOverride?: string) => void;
  readonly onClose: () => void;
}

export function ChannelConfigDialog(props: ChannelConfigDialogProps): JSX.Element {
  const [enabled, setEnabled] = useState(props.initialEnabled ?? true);
  const [dmPolicy, setDmPolicy] = useState(props.initialDmPolicy ?? 'allow');
  const [groupPolicy, setGroupPolicy] = useState(props.initialGroupPolicy ?? 'mention');
  const [modelOverride, setModelOverride] = useState('');
  const [bindAgent, setBindAgent] = useState('');
  const [bindModel, setBindModel] = useState('');

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const data: { enabled: boolean; dmPolicy: string; groupPolicy: string; modelOverride?: string } = { enabled, dmPolicy, groupPolicy };
      if (modelOverride) data.modelOverride = modelOverride;
      props.onSubmit(data);
    },
    [enabled, dmPolicy, groupPolicy, modelOverride, props.onSubmit]
  );

  const handleBind = useCallback(() => {
    if (!bindAgent) return;
    props.onBind(bindAgent, bindModel || undefined);
    setBindAgent('');
    setBindModel('');
  }, [bindAgent, bindModel, props.onBind]);

  return (
    <div className="office-interaction-overlay" onClick={props.onClose}>
      <div className="office-interaction-modal" style={{ maxWidth: 520, width: '90vw' }} onClick={(e) => e.stopPropagation()}>
        <div className="office-interaction-modal-header">
          <h3>Configure: {props.channelName}</h3>
          <button type="button" className="office-agent-panel-close" aria-label="Close" onClick={props.onClose}>&times;</button>
        </div>
        <form onSubmit={handleSubmit} className="dialog-form-grid">
          <label className="dialog-form-label dialog-form-toggle">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Enabled
          </label>
          <label className="dialog-form-label">
            DM Policy
            <select className="dialog-form-select" value={dmPolicy} onChange={(e) => setDmPolicy(e.target.value)}>
              <option value="allow">Allow</option>
              <option value="deny">Deny</option>
              <option value="allowlist">Allowlist Only</option>
            </select>
          </label>
          <label className="dialog-form-label">
            Group Policy
            <select className="dialog-form-select" value={groupPolicy} onChange={(e) => setGroupPolicy(e.target.value)}>
              <option value="all">Respond to all</option>
              <option value="mention">Respond on mention</option>
              <option value="none">Ignore groups</option>
            </select>
          </label>
          <label className="dialog-form-label">
            Model Override
            <select className="dialog-form-select" value={modelOverride} onChange={(e) => setModelOverride(e.target.value)}>
              <option value="">-- Default --</option>
              {props.modelOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          <div className="dialog-form-actions">
            <button type="button" className="dialog-btn-secondary" onClick={props.onClose}>Cancel</button>
            <button type="submit" className="dialog-btn-primary">Queue Config</button>
          </div>
        </form>

        <div style={{ borderTop: '1px solid var(--border)', marginTop: 16, paddingTop: 12 }}>
          <h4 style={{ marginBottom: 8, fontSize: '0.85rem', color: 'var(--text-secondary)' }}>Add Binding</h4>
          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
            <label className="dialog-form-label" style={{ flex: 1 }}>
              Agent
              <select className="dialog-form-select" value={bindAgent} onChange={(e) => setBindAgent(e.target.value)}>
                <option value="">-- Select --</option>
                {props.agentOptions.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </select>
            </label>
            <label className="dialog-form-label" style={{ flex: 1 }}>
              Model (optional)
              <select className="dialog-form-select" value={bindModel} onChange={(e) => setBindModel(e.target.value)}>
                <option value="">-- Default --</option>
                {props.modelOptions.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
              </select>
            </label>
            <button type="button" className="dialog-btn-primary" onClick={handleBind} disabled={!bindAgent}>
              Bind
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
