import { useMemo, useState, useEffect, useCallback } from 'react';
import { FilterTabs, type FilterTab } from '../components/FilterTabs';
import { IconBot, IconEdit, IconPlus } from '../components/Icons';
import { navigate, type RouteFilter } from '../shell/routes';
import type { FrontendUnifiedSnapshot } from '../types';
import { deriveAgents, type DerivedAgent } from '../utils/derive-agents';
import { formatCost, formatTokenCount } from '../utils/format';
import { formatRelativeTime } from '../utils/time';
import type { OpenClawAgent, OpenClawModelProfile } from '@patze/telemetry-core';
import { CreateAgentDialog } from './agents/CreateAgentDialog';
import { EditAgentDialog } from './agents/EditAgentDialog';

export interface AgentsViewProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly filter: RouteFilter;
  readonly baseUrl?: string | undefined;
  readonly token?: string | undefined;
  readonly targetId?: string | undefined;
}

type AgentFilter = 'all' | 'active' | 'idle';

function lastSeenLabel(agent: DerivedAgent): string {
  if (agent.lastSeenAt === 0) return 'never';
  return formatRelativeTime(new Date(agent.lastSeenAt).toISOString());
}

export function AgentsView(props: AgentsViewProps): JSX.Element {
  const [filter, setFilter] = useState<AgentFilter>('all');
  const [showCreate, setShowCreate] = useState(false);
  const [editAgent, setEditAgent] = useState<OpenClawAgent | null>(null);
  const [openclawAgents, setOpenclawAgents] = useState<readonly OpenClawAgent[]>([]);
  const [modelOptions, setModelOptions] = useState<readonly OpenClawModelProfile[]>([]);

  const agents = useMemo(
    () => (props.snapshot ? deriveAgents(props.snapshot) : []),
    [props.snapshot]
  );

  const hasBackend = Boolean(props.baseUrl && props.token && props.targetId);

  useEffect(() => {
    if (!props.baseUrl || !props.token || !props.targetId) return;
    const url = props.baseUrl;
    const tok = props.token;
    const tid = props.targetId;
    let active = true;

    void (async () => {
      try {
        const [agentsRes, modelsRes] = await Promise.all([
          fetch(`${url}/openclaw/targets/${encodeURIComponent(tid)}/agents`, {
            headers: { Authorization: `Bearer ${tok}` },
          }),
          fetch(`${url}/openclaw/targets/${encodeURIComponent(tid)}/models`, {
            headers: { Authorization: `Bearer ${tok}` },
          }),
        ]);
        if (!active) return;
        if (agentsRes.ok) {
          const data = (await agentsRes.json()) as { agents: OpenClawAgent[] };
          setOpenclawAgents(data.agents);
        }
        if (modelsRes.ok) {
          const data = (await modelsRes.json()) as { models: OpenClawModelProfile[] };
          setModelOptions(data.models);
        }
      } catch {
        /* ignore */
      }
    })();

    return () => { active = false; };
  }, [props.baseUrl, props.token, props.targetId]);

  const queueCommand = useCallback(
    async (commands: readonly { command: string; args: string[]; description: string }[]) => {
      if (!props.baseUrl || !props.token || !props.targetId) return;
      try {
        await fetch(`${props.baseUrl}/openclaw/queue`, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${props.token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ targetId: props.targetId, commands }),
        });
      } catch {
        /* ignore */
      }
    },
    [props.baseUrl, props.token, props.targetId]
  );

  const handleCreateAgent = useCallback(
    (data: { id: string; name: string; emoji: string; systemPrompt: string; modelPrimary: string; enabled: boolean }) => {
      const cmds: { command: string; args: string[]; description: string }[] = [
        { command: 'openclaw', args: ['agents', 'add', data.id, '--non-interactive'], description: `Create agent "${data.id}"` },
      ];
      if (data.name) cmds.push({ command: 'openclaw', args: ['config', 'set', `agents.${data.id}.name`, data.name], description: `Set name` });
      if (data.emoji) cmds.push({ command: 'openclaw', args: ['config', 'set', `agents.${data.id}.emoji`, data.emoji], description: `Set emoji` });
      if (data.systemPrompt) cmds.push({ command: 'openclaw', args: ['config', 'set', `agents.${data.id}.systemPrompt`, data.systemPrompt], description: `Set system prompt` });
      if (data.modelPrimary) cmds.push({ command: 'openclaw', args: ['config', 'set', `agents.${data.id}.model.primary`, data.modelPrimary], description: `Set model` });
      if (!data.enabled) cmds.push({ command: 'openclaw', args: ['config', 'set', `agents.${data.id}.enabled`, 'false'], description: `Disable agent` });
      void queueCommand(cmds);
      setShowCreate(false);
    },
    [queueCommand]
  );

  const handleEditAgent = useCallback(
    (data: { name: string; emoji: string; systemPrompt: string; modelPrimary: string; modelFallback: string; enabled: boolean }) => {
      if (!editAgent) return;
      const cmds: { command: string; args: string[]; description: string }[] = [];
      if (data.name !== editAgent.name) cmds.push({ command: 'openclaw', args: ['config', 'set', `agents.${editAgent.id}.name`, data.name], description: `Update name` });
      if (data.emoji !== (editAgent.emoji ?? '')) cmds.push({ command: 'openclaw', args: ['config', 'set', `agents.${editAgent.id}.emoji`, data.emoji], description: `Update emoji` });
      if (data.systemPrompt !== (editAgent.systemPrompt ?? '')) cmds.push({ command: 'openclaw', args: ['config', 'set', `agents.${editAgent.id}.systemPrompt`, data.systemPrompt], description: `Update prompt` });
      if (data.modelPrimary !== (editAgent.model?.primary ?? '')) cmds.push({ command: 'openclaw', args: ['config', 'set', `agents.${editAgent.id}.model.primary`, data.modelPrimary], description: `Update primary model` });
      if (data.modelFallback !== (editAgent.model?.fallback ?? '')) cmds.push({ command: 'openclaw', args: ['config', 'set', `agents.${editAgent.id}.model.fallback`, data.modelFallback], description: `Update fallback model` });
      if (data.enabled !== editAgent.enabled) cmds.push({ command: 'openclaw', args: ['config', 'set', `agents.${editAgent.id}.enabled`, String(data.enabled)], description: `Toggle enabled` });
      if (cmds.length > 0) void queueCommand(cmds);
      setEditAgent(null);
    },
    [editAgent, queueCommand]
  );

  const handleDeleteAgent = useCallback(() => {
    if (!editAgent) return;
    void queueCommand([
      { command: 'openclaw', args: ['agents', 'remove', editAgent.id], description: `Remove agent "${editAgent.id}"` },
    ]);
    setEditAgent(null);
  }, [editAgent, queueCommand]);

  const activeCount = agents.filter((a) => a.active).length;
  const idleCount = agents.length - activeCount;

  const tabs: ReadonlyArray<FilterTab<AgentFilter>> = [
    { id: 'all', label: 'All', count: agents.length },
    { id: 'active', label: 'Active', count: activeCount },
    { id: 'idle', label: 'Idle', count: idleCount },
  ];

  const filtered = agents.filter((a) => {
    switch (filter) {
      case 'active':
        return a.active;
      case 'idle':
        return !a.active;
      case 'all':
        return true;
    }
  });

  const modelOpts = modelOptions.map((m) => ({ id: m.id, name: m.name }));

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Agents</h2>
        <FilterTabs tabs={tabs} active={filter} onChange={setFilter} />
        {hasBackend ? (
          <button
            type="button"
            className="dialog-btn-primary"
            style={{ marginLeft: 'auto' }}
            onClick={() => setShowCreate(true)}
          >
            <IconPlus width={14} height={14} /> New Agent
          </button>
        ) : null}
      </div>

      {openclawAgents.length > 0 ? (
        <div className="config-agents-section">
          <h3 className="section-subtitle">OpenClaw Agents</h3>
          <div className="machine-grid">
            {openclawAgents.map((agent) => (
              <div key={agent.id} className="machine-card machine-card-clickable" role="button" tabIndex={0}
                onClick={() => setEditAgent(agent)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setEditAgent(agent); } }}
              >
                <div className="machine-card-header">
                  <div className="machine-card-title">
                    {agent.emoji ? <span style={{ marginRight: 6 }}>{agent.emoji}</span> : null}
                    <span className="machine-card-name">{agent.name || agent.id}</span>
                  </div>
                  <span className={`badge ${agent.enabled ? 'tone-ok' : 'tone-muted'}`}>
                    {agent.enabled ? 'enabled' : 'disabled'}
                  </span>
                </div>
                <div className="machine-card-meta">
                  <div className="machine-card-meta-item">
                    <span className="machine-card-meta-label">ID</span>
                    <span className="machine-card-meta-value">{agent.id}</span>
                  </div>
                  {agent.model?.primary ? (
                    <div className="machine-card-meta-item">
                      <span className="machine-card-meta-label">Model</span>
                      <span className="machine-card-meta-value">{agent.model.primary}</span>
                    </div>
                  ) : null}
                </div>
                <button type="button" className="card-edit-btn" onClick={(e) => { e.stopPropagation(); setEditAgent(agent); }}>
                  <IconEdit width={14} height={14} />
                </button>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {agents.length > 0 ? (
        <>
          <h3 className="section-subtitle" style={{ marginTop: 16 }}>Telemetry Agents</h3>
          {filtered.length === 0 ? (
            <div className="empty-state">No agents match the current filter.</div>
          ) : (
            <div className="machine-grid">
              {filtered.map((agent) => (
                <div
                  key={agent.agentId}
                  className="machine-card machine-card-clickable"
                  role="button"
                  tabIndex={0}
                  onClick={() => navigate('sessions', { agentId: agent.agentId })}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      navigate('sessions', { agentId: agent.agentId });
                    }
                  }}
                >
                  <div className="machine-card-header">
                    <div className="machine-card-title">
                      <span className="machine-card-name">{agent.agentId}</span>
                    </div>
                    <span className={`badge ${agent.active ? 'tone-ok' : 'tone-muted'}`}>
                      {agent.active ? 'active' : 'idle'}
                    </span>
                  </div>
                  <div className="machine-card-meta">
                    <div className="machine-card-meta-item">
                      <span className="machine-card-meta-label">Sessions</span>
                      <span className={`machine-card-meta-value${agent.activeSessions > 0 ? ' metric-active' : ''}`}>
                        {agent.activeSessions > 0 ? `${agent.activeSessions} active / ${agent.totalSessions}` : agent.totalSessions}
                      </span>
                    </div>
                    <div className="machine-card-meta-item">
                      <span className="machine-card-meta-label">Last Seen</span>
                      <span className="machine-card-meta-value">{lastSeenLabel(agent)}</span>
                    </div>
                    {agent.totalTokens > 0 ? (
                      <>
                        <div className="machine-card-meta-item">
                          <span className="machine-card-meta-label">Tokens</span>
                          <span className="machine-card-meta-value">{formatTokenCount(agent.totalTokens)}</span>
                        </div>
                        <div className="machine-card-meta-item">
                          <span className="machine-card-meta-label">Cost</span>
                          <span className="machine-card-meta-value">{formatCost(agent.estimatedCostUsd)}</span>
                        </div>
                      </>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      ) : !hasBackend ? (
        <div className="empty-state">
          <div className="empty-state-icon"><IconBot width={28} height={28} /></div>
          <p style={{ margin: '4px 0 0' }}>No agents detected yet.</p>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
            Connect an OpenClaw instance to manage agents.
          </p>
        </div>
      ) : null}

      {showCreate ? (
        <CreateAgentDialog
          onSubmit={handleCreateAgent}
          onClose={() => setShowCreate(false)}
          modelOptions={modelOpts}
        />
      ) : null}
      {editAgent ? (
        <EditAgentDialog
          agent={editAgent}
          onSubmit={handleEditAgent}
          onDelete={handleDeleteAgent}
          onClose={() => setEditAgent(null)}
          modelOptions={modelOpts}
        />
      ) : null}
    </section>
  );
}
