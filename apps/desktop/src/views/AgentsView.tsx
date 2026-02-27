import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { FilterTabs, type FilterTab } from '../components/FilterTabs';
import { IconBot, IconEdit, IconPlus } from '../components/Icons';
import { onConfigChanged } from '../utils/openclaw-events';
import { navigate, type RouteFilter } from '../shell/routes';
import type { FrontendUnifiedSnapshot } from '../types';
import { useRequiredTarget } from '../features/openclaw/selection/useRequiredTarget';
import { OpenClawPageState } from '../features/openclaw/ui/OpenClawPageState';
import { TargetLockBadge } from '../features/openclaw/ui/TargetLockBadge';
import { cachedFetch } from '../hooks/useApiCache';
import { deriveAgents, type DerivedAgent } from '../utils/derive-agents';
import { formatCost, formatTokenCount } from '../utils/format';
import { formatRelativeTime } from '../utils/time';
import type { OpenClawAgent, OpenClawModelProfile } from '@patze/telemetry-core';
import { CreateAgentDialog } from './agents/CreateAgentDialog';
import { EditAgentDialog } from './agents/EditAgentDialog';
import { useSmartPoll, type SmartPollContext } from '../hooks/useSmartPoll';
import { shouldPausePollWhenHidden } from '../utils/runtime';

export interface AgentsViewProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly filter: RouteFilter;
  readonly baseUrl?: string | undefined;
  readonly token?: string | undefined;
  readonly selectedTargetId: string | null;
}

type AgentFilter = 'all' | 'active' | 'idle';
const AGENTS_POLL_INTERVAL_MS = 45_000;

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
  const [configStatus, setConfigStatus] = useState<
    'found' | 'missing' | 'empty' | 'invalid' | null
  >(null);
  const [configCandidates, setConfigCandidates] = useState<readonly string[]>([]);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [bridgeControlCounts, setBridgeControlCounts] = useState<Record<string, number>>({});
  const [pendingMutation, setPendingMutation] = useState(false);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);
  const requestVersionRef = useRef(0);

  const agents = useMemo(
    () => (props.snapshot ? deriveAgents(props.snapshot) : []),
    [props.snapshot]
  );

  const hasConnectionCreds = Boolean(props.baseUrl);
  const targetContext = useRequiredTarget({
    connected: hasConnectionCreds,
    selectedTargetId: props.selectedTargetId,
  });
  const hasBackend = targetContext.state === 'ready';
  const pauseOnHidden = shouldPausePollWhenHidden();

  const authHeaders = useMemo(
    () => (props.token ? { Authorization: `Bearer ${props.token}` } : {}),
    [props.token]
  );

  const fetchOpenClawData = useCallback(
    async (context?: SmartPollContext): Promise<boolean> => {
      if (!props.baseUrl || !props.selectedTargetId) {
        setOpenclawAgents([]);
        setModelOptions([]);
        setConfigStatus(null);
        setConfigCandidates([]);
        setConfigError(null);
        setBridgeControlCounts({});
        setLoadingConfig(false);
        return true;
      }

      const requestVersion = ++requestVersionRef.current;
      setLoadingConfig(true);
      setConfigError(null);

      const controller = new AbortController();
      const timeoutId = window.setTimeout(() => controller.abort(), 10_000);
      if (context?.signal) {
        if (context.signal.aborted) {
          controller.abort();
        } else {
          context.signal.addEventListener('abort', () => controller.abort(), { once: true });
        }
      }
      const signal = controller.signal;

      try {
        const [agentsRes, modelsRes, channelsRes, controlRes] = await Promise.all([
          cachedFetch(
            `${props.baseUrl}/openclaw/targets/${encodeURIComponent(props.selectedTargetId)}/agents`,
            {
              headers: authHeaders,
              signal,
              ttlMs: 10_000,
            }
          ).catch(() => null),
          cachedFetch(
            `${props.baseUrl}/openclaw/targets/${encodeURIComponent(props.selectedTargetId)}/models`,
            {
              headers: authHeaders,
              signal,
              ttlMs: 15_000,
            }
          ).catch(() => null),
          cachedFetch(
            `${props.baseUrl}/openclaw/channels?targetId=${encodeURIComponent(props.selectedTargetId)}`,
            { headers: authHeaders, signal, ttlMs: 10_000 }
          ).catch(() => null),
          cachedFetch(
            `${props.baseUrl}/openclaw/targets/${encodeURIComponent(props.selectedTargetId)}/control/commands?limit=100`,
            { headers: authHeaders, signal, ttlMs: 5_000 }
          ).catch(() => null),
        ]);

        if (requestVersion !== requestVersionRef.current) return false;

        if (agentsRes?.ok) {
          const data = (await agentsRes.json()) as { agents?: OpenClawAgent[] };
          if (requestVersion === requestVersionRef.current) {
            setOpenclawAgents(data.agents ?? []);
          }
        }
        if (modelsRes?.ok) {
          const data = (await modelsRes.json()) as { models?: OpenClawModelProfile[] };
          if (requestVersion === requestVersionRef.current) {
            setModelOptions(data.models ?? []);
          }
        }
        if (channelsRes?.ok) {
          const data = (await channelsRes.json()) as {
            configStatus?: 'found' | 'missing' | 'empty' | 'invalid';
            configCandidates?: string[];
          };
          if (requestVersion === requestVersionRef.current) {
            setConfigStatus(data.configStatus ?? null);
            setConfigCandidates(data.configCandidates ?? []);
          }
        }
        if (controlRes?.ok) {
          const data = (await controlRes.json()) as { counts?: Record<string, number> };
          if (requestVersion === requestVersionRef.current) {
            setBridgeControlCounts(data.counts ?? {});
          }
        }

        const anyOk = Boolean(agentsRes?.ok || modelsRes?.ok || channelsRes?.ok || controlRes?.ok);
        if (!anyOk && requestVersion === requestVersionRef.current) {
          setConfigError('Failed to load OpenClaw data. Check connection.');
        }
        return anyOk;
      } catch (err) {
        if (requestVersion !== requestVersionRef.current) return false;
        setConfigError(err instanceof Error ? err.message : 'Failed to load OpenClaw data');
        return false;
      } finally {
        window.clearTimeout(timeoutId);
        if (requestVersion === requestVersionRef.current) {
          setLoadingConfig(false);
        }
      }
    },
    [authHeaders, props.baseUrl, props.selectedTargetId]
  );

  useSmartPoll(fetchOpenClawData, {
    enabled: hasBackend,
    baseIntervalMs: AGENTS_POLL_INTERVAL_MS,
    maxIntervalMs: AGENTS_POLL_INTERVAL_MS * 4,
    pauseOnHidden,
  });

  const fetchRef = useRef(fetchOpenClawData);
  fetchRef.current = fetchOpenClawData;

  useEffect(() => {
    return onConfigChanged(() => void fetchRef.current());
  }, []);

  useEffect(() => {
    setEditAgent(null);
    setShowCreate(false);

    if (!hasBackend) {
      setOpenclawAgents([]);
      setModelOptions([]);
      setConfigStatus(null);
      setConfigCandidates([]);
      setConfigError(null);
      setBridgeControlCounts({});
      setLoadingConfig(false);
    }
  }, [hasBackend, props.selectedTargetId]);

  const queueCommand = useCallback(
    async (commands: readonly { command: string; args: string[]; description: string }[]) => {
      if (!props.baseUrl || !props.selectedTargetId) return;
      const doQueue = async (): Promise<void> => {
        setPendingMutation(true);
        try {
          await fetch(`${props.baseUrl}/openclaw/queue`, {
            method: 'POST',
            headers: {
              ...authHeaders,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ targetId: props.selectedTargetId, commands }),
          });
        } catch {
          /* ignore */
        } finally {
          setPendingMutation(false);
        }
      };
      if (pendingMutation) {
        setConfirmState({
          title: 'Queue Pending',
          message: 'A previous command is still pending. Queue another command anyway?',
          onConfirm: () => {
            setConfirmState(null);
            void doQueue();
          },
        });
        return;
      }
      await doQueue();
    },
    [authHeaders, pendingMutation, props.baseUrl, props.selectedTargetId]
  );

  const queueBridgeControlCommand = useCallback(
    async (intent: 'agent_set_enabled', args: Record<string, unknown>): Promise<boolean> => {
      if (!props.baseUrl || !props.selectedTargetId) return false;
      try {
        const res = await fetch(
          `${props.baseUrl}/openclaw/targets/${encodeURIComponent(props.selectedTargetId)}/control/commands`,
          {
            method: 'POST',
            headers: {
              ...authHeaders,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({
              intent,
              args,
              createdBy: 'ui-agents',
              policyVersion: 'bridge-control-v1',
            }),
          }
        );
        return res.ok;
      } catch {
        return false;
      }
    },
    [authHeaders, props.baseUrl, props.selectedTargetId]
  );

  const handleCreateAgent = useCallback(
    (data: {
      id: string;
      name: string;
      emoji: string;
      systemPrompt: string;
      modelPrimary: string;
      enabled: boolean;
    }) => {
      const cmds: { command: string; args: string[]; description: string }[] = [
        {
          command: 'openclaw',
          args: ['agents', 'add', data.id, '--non-interactive'],
          description: `Create agent "${data.id}"`,
        },
      ];
      if (data.name)
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `agents.${data.id}.name`, data.name],
          description: `Set name`,
        });
      if (data.emoji)
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `agents.${data.id}.emoji`, data.emoji],
          description: `Set emoji`,
        });
      if (data.systemPrompt)
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `agents.${data.id}.systemPrompt`, data.systemPrompt],
          description: `Set system prompt`,
        });
      if (data.modelPrimary)
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `agents.${data.id}.model.primary`, data.modelPrimary],
          description: `Set model`,
        });
      if (!data.enabled)
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `agents.${data.id}.enabled`, 'false'],
          description: `Disable agent`,
        });
      void queueCommand(cmds);
      setShowCreate(false);
    },
    [queueCommand]
  );

  const handleEditAgent = useCallback(
    (data: {
      name: string;
      emoji: string;
      systemPrompt: string;
      modelPrimary: string;
      modelFallback: string;
      enabled: boolean;
    }) => {
      if (!editAgent) return;
      const cmds: { command: string; args: string[]; description: string }[] = [];
      if (data.name !== editAgent.name)
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `agents.${editAgent.id}.name`, data.name],
          description: `Update name`,
        });
      if (data.emoji !== (editAgent.emoji ?? ''))
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `agents.${editAgent.id}.emoji`, data.emoji],
          description: `Update emoji`,
        });
      if (data.systemPrompt !== (editAgent.systemPrompt ?? ''))
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `agents.${editAgent.id}.systemPrompt`, data.systemPrompt],
          description: `Update prompt`,
        });
      if (data.modelPrimary !== (editAgent.model?.primary ?? ''))
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `agents.${editAgent.id}.model.primary`, data.modelPrimary],
          description: `Update primary model`,
        });
      if (data.modelFallback !== (editAgent.model?.fallback ?? ''))
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `agents.${editAgent.id}.model.fallback`, data.modelFallback],
          description: `Update fallback model`,
        });
      if (data.enabled !== editAgent.enabled)
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `agents.${editAgent.id}.enabled`, String(data.enabled)],
          description: `Toggle enabled`,
        });
      if (cmds.length > 0) void queueCommand(cmds);
      setEditAgent(null);
    },
    [editAgent, queueCommand]
  );

  const handleToggleAgent = useCallback(
    (agentId: string, currentEnabled: boolean) => {
      void (async () => {
        const nextEnabled = !currentEnabled;
        const controlQueued = await queueBridgeControlCommand('agent_set_enabled', {
          agentId,
          enabled: nextEnabled,
        });
        if (controlQueued) return;
        void queueCommand([
          {
            command: 'openclaw',
            args: ['config', 'set', `agents.${agentId}.enabled`, currentEnabled ? 'false' : 'true'],
            description: `${currentEnabled ? 'Disable' : 'Enable'} agent "${agentId}"`,
          },
        ]);
      })();
    },
    [queueBridgeControlCommand, queueCommand]
  );

  const handleDeleteAgent = useCallback(() => {
    if (!editAgent) return;
    void queueCommand([
      {
        command: 'openclaw',
        args: ['agents', 'remove', editAgent.id],
        description: `Remove agent "${editAgent.id}"`,
      },
    ]);
    setEditAgent(null);
  }, [editAgent, queueCommand]);

  const activeCount = useMemo(() => agents.filter((a) => a.active).length, [agents]);
  const idleCount = agents.length - activeCount;

  const tabs: ReadonlyArray<FilterTab<AgentFilter>> = useMemo(
    () => [
      { id: 'all', label: 'All', count: agents.length },
      { id: 'active', label: 'Active', count: activeCount },
      { id: 'idle', label: 'Idle', count: idleCount },
    ],
    [agents.length, activeCount, idleCount]
  );

  const filtered = useMemo(
    () =>
      agents.filter((a) => {
        switch (filter) {
          case 'active':
            return a.active;
          case 'idle':
            return !a.active;
          case 'all':
            return true;
        }
      }),
    [agents, filter]
  );

  const modelOpts = useMemo(
    () => modelOptions.map((m) => ({ id: m.id, name: m.name })),
    [modelOptions]
  );
  const hasAnyAgentData = openclawAgents.length > 0 || agents.length > 0;

  const renderBody = (): JSX.Element | null => {
    if (configError) {
      return <OpenClawPageState kind="error" featureName="agents" errorMessage={configError} />;
    }

    if (!hasBackend) {
      return (
        <OpenClawPageState
          kind={targetContext.state === 'noTarget' ? 'noTarget' : 'notReady'}
          featureName="agents"
        />
      );
    }

    if (loadingConfig && !hasAnyAgentData) {
      return <OpenClawPageState kind="loading" featureName="agents" />;
    }

    if (!hasAnyAgentData) {
      return (
        <div className="empty-state">
          <div className="empty-state-icon">
            <IconBot width={28} height={28} />
          </div>
          <p className="empty-state-title">No agents found for this target yet.</p>
          <p className="empty-state-desc">
            {configStatus === 'missing'
              ? 'Target connected but openclaw.json is missing on synced path, so agent config cannot be read yet.'
              : 'Create your first agent, or generate activity so telemetry agents appear.'}
          </p>
          {configStatus === 'missing' && configCandidates[0] ? (
            <p className="mono empty-state-path">expected: {configCandidates[0]}</p>
          ) : null}
        </div>
      );
    }

    return (
      <>
        {openclawAgents.length > 0 ? (
          <div className="config-agents-section">
            <h3 className="section-subtitle">OpenClaw Agents</h3>
            <div className="machine-grid">
              {openclawAgents.map((agent) => (
                <div
                  key={agent.id}
                  className="machine-card machine-card-clickable"
                  role="button"
                  tabIndex={0}
                  onClick={() => setEditAgent(agent)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setEditAgent(agent);
                    }
                  }}
                >
                  <div className="machine-card-header">
                    <div className="machine-card-title">
                      {agent.emoji ? <span className="agent-emoji">{agent.emoji}</span> : null}
                      <span className="machine-card-name">{agent.name || agent.id}</span>
                    </div>
                    <button
                      type="button"
                      className={`badge-toggle ${agent.enabled ? 'badge-toggle-on' : 'badge-toggle-off'}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleToggleAgent(agent.id, agent.enabled);
                      }}
                      title={agent.enabled ? 'Click to disable' : 'Click to enable'}
                    >
                      {agent.enabled ? 'enabled' : 'disabled'}
                    </button>
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
                  <button
                    type="button"
                    className="card-edit-btn"
                    onClick={(e) => {
                      e.stopPropagation();
                      setEditAgent(agent);
                    }}
                  >
                    <IconEdit width={14} height={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {agents.length > 0 ? (
          <>
            <h3 className="section-subtitle section-subtitle-spaced">Telemetry Agents</h3>
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
                        <span
                          className={`machine-card-meta-value${agent.activeSessions > 0 ? ' metric-active' : ''}`}
                        >
                          {agent.activeSessions > 0
                            ? `${agent.activeSessions} active / ${agent.totalSessions}`
                            : agent.totalSessions}
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
                            <span className="machine-card-meta-value">
                              {formatTokenCount(agent.totalTokens)}
                            </span>
                          </div>
                          <div className="machine-card-meta-item">
                            <span className="machine-card-meta-label">Cost</span>
                            <span className="machine-card-meta-value">
                              {formatCost(agent.estimatedCostUsd)}
                            </span>
                          </div>
                        </>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </>
        ) : null}
      </>
    );
  };

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Agents</h2>
        <FilterTabs tabs={tabs} active={filter} onChange={setFilter} />
        <TargetLockBadge targetId={props.selectedTargetId} />
        <span className="badge tone-neutral">
          control q/r/f {(bridgeControlCounts.queued ?? 0).toString()}/
          {(bridgeControlCounts.running ?? 0).toString()}/
          {(bridgeControlCounts.failed ?? 0).toString()}
        </span>
        {pendingMutation ? <span className="badge tone-warn">queue pending</span> : null}
        {hasBackend ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              void fetchOpenClawData();
            }}
            disabled={loadingConfig}
          >
            Refresh
          </button>
        ) : null}
        {hasBackend ? (
          <button
            type="button"
            className="dialog-btn-primary ml-auto"
            onClick={() => setShowCreate(true)}
          >
            <IconPlus width={14} height={14} /> New Agent
          </button>
        ) : null}
      </div>

      {renderBody()}

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

      {confirmState ? (
        <ConfirmDialog
          title={confirmState.title}
          message={confirmState.message}
          variant="warn"
          confirmLabel="Queue Anyway"
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      ) : null}
    </section>
  );
}
