import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChannelSkeletonGrid } from '../components/ChannelSkeleton';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { IconMessage } from '../components/Icons';
import { useRequiredTarget } from '../features/openclaw/selection/useRequiredTarget';
import { OpenClawPageState } from '../features/openclaw/ui/OpenClawPageState';
import { TargetLockBadge } from '../features/openclaw/ui/TargetLockBadge';
import { cachedFetch } from '../hooks/useApiCache';
import type { TargetSyncStatusEntry } from '../hooks/useOpenClawTargets';
import { useSmartPoll } from '../hooks/useSmartPoll';
import type { ConnectionStatus } from '../types';
import {
  channelPriority,
  channelRecommendation,
  dmBadgeTone,
  priorityBadgeTone,
  priorityLabel,
  runtimeStateLabel,
  getChannelMeta,
  type ChannelPriority,
} from '../utils/channel-intelligence';
import { onConfigChanged } from '../utils/openclaw-events';
import { shouldPausePollWhenHidden } from '../utils/runtime';
import { formatRelativeTime } from '../utils/time';
import type { OpenClawAgent, OpenClawModelProfile } from '@patze/telemetry-core';
import { ChannelConfigDialog } from './channels/ChannelConfigDialog';

interface OpenClawChannelBoundAgent {
  readonly agentId: string;
  readonly modelOverride?: string;
}

interface OpenClawChannel {
  readonly id: string;
  readonly name: string;
  readonly configured: boolean;
  readonly dmPolicy: 'pairing' | 'allowlist' | 'open' | 'disabled' | 'unknown';
  readonly groupPolicy: 'open' | 'allowlist' | 'disabled' | 'unknown';
  readonly allowFrom: readonly string[];
  readonly allowFromCount: number;
  readonly allowFromHasWildcard: boolean;
  readonly hasGroups: boolean;
  readonly connected: boolean;
  readonly runtimeState: 'connected' | 'disconnected' | 'unknown';
  readonly accountSummary: {
    readonly total: number;
    readonly enabled: number;
    readonly configured: number;
    readonly connected: number;
    readonly runtimeKnown: number;
  };
  readonly boundAgents: readonly OpenClawChannelBoundAgent[];
  readonly lastMessageAt?: string;
  readonly messageCount?: number;
}

interface OpenClawChannelsResponse {
  readonly targetId?: string;
  readonly configPath?: string;
  readonly configStatus?: 'found' | 'missing' | 'empty' | 'invalid';
  readonly configCandidates?: readonly string[];
  readonly channels: readonly OpenClawChannel[];
}

// ChannelPriority imported from channel-intelligence.ts

export interface ChannelsViewProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly status: ConnectionStatus;
  readonly openclawTargets: readonly TargetSyncStatusEntry[];
  readonly selectedTargetId: string | null;
  readonly onSelectedTargetIdChange: (targetId: string | null) => void;
}

function getProviderTheme(id: string): { letter: string; color: string; bg: string } {
  const m = getChannelMeta(id);
  return { letter: m.letter, color: m.color, bg: m.bg };
}

function authHeaders(token: string): Record<string, string> {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function statusDotClass(channel: OpenClawChannel): string {
  if (!channel.configured) return 'ch-dot-off';
  if (channel.connected) return 'ch-dot-on';
  return 'ch-dot-warn';
}

function statusLabel(channel: OpenClawChannel): string {
  if (!channel.configured) return 'Not Configured';
  if (channel.connected) return 'Connected';
  if (channel.runtimeState === 'unknown') return 'Runtime Unknown';
  return 'Disconnected';
}

function SummaryGauge(props: {
  readonly label: string;
  readonly value: number;
  readonly total: number;
  readonly color: string;
}): JSX.Element {
  const pct = props.total > 0 ? (props.value / props.total) * 100 : 0;
  return (
    <div className="ch-summary-gauge">
      <div className="ch-summary-gauge-head">
        <span className="ch-summary-gauge-label">{props.label}</span>
        <span className="ch-summary-gauge-value">
          {props.value}
          <span className="ch-summary-gauge-total">/{props.total}</span>
        </span>
      </div>
      <div className="ch-summary-gauge-track">
        <div
          className="ch-summary-gauge-fill"
          style={{ width: `${String(Math.min(100, pct))}%`, background: props.color }}
        />
      </div>
    </div>
  );
}

function channelPriorityRank(priority: ChannelPriority): number {
  switch (priority) {
    case 'high':
      return 3;
    case 'medium':
      return 2;
    case 'low':
      return 1;
    default: {
      const exhaustive: never = priority;
      return exhaustive;
    }
  }
}

function ChannelCard(props: {
  readonly channel: OpenClawChannel;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly copiedKey: string | null;
  readonly onCopy: (value: string, key: string) => void;
  readonly onConfigure?: (() => void) | undefined;
  readonly agentOptions?: readonly { id: string; name: string }[];
  readonly onBind?: (agentId: string) => void;
  readonly onUnbind?: (agentId: string) => void;
}): JSX.Element {
  const { channel, expanded, onToggle, copiedKey, onCopy } = props;
  const [showAllowFrom, setShowAllowFrom] = useState(false);
  const [bindAgent, setBindAgent] = useState('');
  const priority = channelPriority(channel);
  const theme = getProviderTheme(channel.id);
  const recommendation = channelRecommendation(channel);
  const runtimeLabel = runtimeStateLabel(channel.runtimeState, channel.configured);
  const accountKnown = channel.accountSummary.total > 0;

  return (
    <article
      className={`channel-card channel-card-v2 channel-priority-${priority}${expanded ? ' channel-card-expanded' : ''}`}
      onClick={onToggle}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <header className="channel-card-head-v2">
        <div className="ch-provider-icon" style={{ background: theme.bg, color: theme.color }}>
          {theme.letter}
        </div>
        <div className="ch-card-title-col">
          <div className="ch-card-name-row">
            <strong className="channel-card-title">{channel.name}</strong>
            <span
              className={`ch-status-dot ${statusDotClass(channel)}`}
              title={statusLabel(channel)}
            />
            {priority !== 'low' ? (
              <span
                className={`badge ${priorityBadgeTone(priority)} ch-risk-badge`}
                data-tooltip={recommendation ?? `${priorityLabel(priority)} priority`}
              >
                {priorityLabel(priority)}
              </span>
            ) : null}
          </div>
          <div className="ch-card-sub-row">
            <span
              className="ch-card-dm-pill"
              data-tooltip={`Direct message policy: ${channel.dmPolicy}`}
            >
              <span className={`ch-dm-dot ${dmBadgeTone(channel.dmPolicy)}`} />
              DM: {channel.dmPolicy}
            </span>
            {(channel.boundAgents ?? []).length > 0 ? (
              <span
                className="ch-bound-badge"
                data-tooltip={`Bound: ${channel.boundAgents.map((a) => a.agentId).join(', ')}`}
              >
                {channel.boundAgents.length} agent{channel.boundAgents.length !== 1 ? 's' : ''}
              </span>
            ) : null}
          </div>
        </div>
        <span
          className={`ch-expand-chevron${expanded ? ' ch-expand-open' : ''}`}
          aria-hidden="true"
        >
          &#x25BE;
        </span>
      </header>
      <div className={`ch-priority-line severity-${priority}`} aria-hidden="true" />
      <div className="ch-card-status-row">
        <span
          className={`badge tone-neutral ch-runtime-state-pill`}
          data-tooltip={`Runtime state: ${runtimeLabel}`}
        >
          runtime {runtimeLabel}
        </span>
        {accountKnown ? (
          <span className="badge tone-muted ch-account-pill">
            accounts {channel.accountSummary.connected}/{channel.accountSummary.total}
          </span>
        ) : null}
      </div>
      <div className="ch-meta-inline">
        <span>allow {channel.allowFromCount}</span>
        <span>groups {channel.hasGroups ? 'active' : channel.groupPolicy}</span>
        <span>messages {channel.messageCount ?? 0}</span>
      </div>

      {expanded ? (
        <div className="ch-card-details">
          <div className="ch-detail-grid">
            <div className="ch-detail-item">
              <span className="ch-detail-label">AllowFrom</span>
              <span className="ch-detail-value">
                {channel.allowFromCount}
                {channel.allowFromHasWildcard ? (
                  <span className="badge tone-warn ch-wildcard-badge">wildcard</span>
                ) : null}
                {channel.allowFrom.length > 0 ? (
                  <button
                    className="ch-allowfrom-toggle"
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowAllowFrom(!showAllowFrom);
                    }}
                  >
                    {showAllowFrom ? 'hide' : 'show'}
                  </button>
                ) : null}
              </span>
              {showAllowFrom && channel.allowFrom.length > 0 ? (
                <div className="ch-allowfrom-list">
                  {channel.allowFrom.map((entry) => (
                    <span
                      key={entry}
                      className={`ch-allowfrom-entry${entry === '*' ? ' ch-allowfrom-wildcard' : ''}`}
                    >
                      {entry}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            <div className="ch-detail-item">
              <span className="ch-detail-label">Groups</span>
              <span className="ch-detail-value">
                {channel.groupPolicy}
                {channel.hasGroups ? ' (active)' : ''}
              </span>
            </div>
            {channel.accountSummary.total > 0 ? (
              <div className="ch-detail-item">
                <span className="ch-detail-label">Accounts</span>
                <span className="ch-detail-value">
                  {channel.accountSummary.connected}/{channel.accountSummary.total} connected
                  {channel.accountSummary.enabled !== channel.accountSummary.total ? (
                    <span className="ch-account-muted">
                      ({channel.accountSummary.enabled} enabled)
                    </span>
                  ) : null}
                </span>
              </div>
            ) : null}
            <div className="ch-detail-item">
              <span className="ch-detail-label">Messages</span>
              <span className="ch-detail-value">{channel.messageCount ?? 0}</span>
            </div>
          </div>
          <div className="ch-detail-item ch-detail-item-full">
            <span className="ch-detail-label">Agents</span>
            <div className="ch-inline-agents">
              {(channel.boundAgents ?? []).map((ba) => (
                <span key={ba.agentId} className="ch-inline-agent-tag">
                  <span>{ba.agentId}</span>
                  {ba.modelOverride ? (
                    <span className="ch-model-override">({ba.modelOverride})</span>
                  ) : null}
                  {props.onUnbind ? (
                    <button
                      type="button"
                      className="ch-inline-unbind"
                      title={`Unbind ${ba.agentId}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onUnbind?.(ba.agentId);
                      }}
                    >
                      &times;
                    </button>
                  ) : null}
                </span>
              ))}
              {props.agentOptions && props.agentOptions.length > 0 && props.onBind ? (
                <span className="ch-inline-bind-row" onClick={(e) => e.stopPropagation()}>
                  <select
                    className="ch-inline-agent-select"
                    value={bindAgent}
                    onChange={(e) => setBindAgent(e.target.value)}
                  >
                    <option value="">+ Add agent</option>
                    {props.agentOptions
                      .filter((a) => !(channel.boundAgents ?? []).some((ba) => ba.agentId === a.id))
                      .map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                  </select>
                  {bindAgent ? (
                    <button
                      type="button"
                      className="btn-ghost ch-inline-bind-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onBind?.(bindAgent);
                        setBindAgent('');
                      }}
                    >
                      Bind
                    </button>
                  ) : null}
                </span>
              ) : null}
              {(channel.boundAgents ?? []).length === 0 && !props.agentOptions?.length ? (
                <span className="ch-no-agents">No agents bound</span>
              ) : null}
            </div>
          </div>
          {recommendation ? (
            <div className="ch-recommendation-row">
              <span className={`ch-recommendation-icon severity-${priority}`}>
                {priority === 'high' ? '!' : priority === 'medium' ? '!' : 'i'}
              </span>
              <span>{recommendation}</span>
            </div>
          ) : null}
          <div className="ch-card-actions">
            <button
              className="btn-ghost"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCopy(`channels.${channel.id}`, `key-${channel.id}`);
              }}
            >
              {copiedKey === `key-${channel.id}` ? 'Copied' : 'Copy Key'}
            </button>
            {channel.lastMessageAt ? (
              <span className="ch-card-last-msg">
                Last msg {formatRelativeTime(channel.lastMessageAt)}
              </span>
            ) : null}
            {props.onConfigure ? (
              <button
                className="dialog-btn-primary ch-configure-btn"
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  props.onConfigure?.();
                }}
              >
                Configure
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function ChannelsView(props: ChannelsViewProps): JSX.Element {
  const targets = useMemo(
    () => props.openclawTargets.map((e) => e.target),
    [props.openclawTargets]
  );
  const selectedTargetId = props.selectedTargetId;
  const setSelectedTargetId = props.onSelectedTargetIdChange;
  const [channels, setChannels] = useState<OpenClawChannel[]>([]);
  const [configPath, setConfigPath] = useState<string | null>(null);
  const [configStatus, setConfigStatus] = useState<'found' | 'missing' | 'empty' | 'invalid'>(
    'missing'
  );
  const [configCandidates, setConfigCandidates] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [showOnlyAttention, setShowOnlyAttention] = useState(false);
  const [showOnlyConfigured, setShowOnlyConfigured] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [expandedCardId, setExpandedCardId] = useState<string | null>(null);
  const [configHintOpen, setConfigHintOpen] = useState(false);
  const [configDialogChannel, setConfigDialogChannel] = useState<OpenClawChannel | null>(null);
  const [pendingMutation, setPendingMutation] = useState(false);
  const [agentOptions, setAgentOptions] = useState<readonly { id: string; name: string }[]>([]);
  const [modelOptionsForDialog, setModelOptionsForDialog] = useState<
    readonly { id: string; name: string }[]
  >([]);
  const [activeSection, setActiveSection] = useState<'healthy' | 'attention'>('healthy');
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);

  const isConnected = props.status === 'connected' || props.status === 'degraded';
  const targetContext = useRequiredTarget({ connected: isConnected, selectedTargetId });
  const headers = useMemo(() => authHeaders(props.token), [props.token]);
  const fetchVersionRef = useRef(0);
  const fetchControllerRef = useRef<AbortController | null>(null);
  const hasLoadedRef = useRef(false);
  const healthySectionRef = useRef<HTMLElement | null>(null);
  const attentionSectionRef = useRef<HTMLElement | null>(null);
  const pauseOnHidden = shouldPausePollWhenHidden();

  const fetchChannels = useCallback(
    async (context?: { signal: AbortSignal }, showLoading = false): Promise<boolean> => {
      if (!isConnected) return false;
      if (!selectedTargetId) {
        setChannels([]);
        setConfigPath(null);
        setConfigStatus('missing');
        setConfigCandidates([]);
        setError(null);
        setLoading(false);
        return true;
      }
      const requestVersion = ++fetchVersionRef.current;
      if (!context?.signal) fetchControllerRef.current?.abort();
      const controller = context?.signal ? null : new AbortController();
      if (controller) fetchControllerRef.current = controller;
      const timeoutController = new AbortController();
      const parentSignal = context?.signal ?? controller?.signal ?? null;
      let abortRelay: (() => void) | null = null;
      if (parentSignal) {
        if (parentSignal.aborted) {
          timeoutController.abort();
        } else {
          const onAbort = () => timeoutController.abort();
          parentSignal.addEventListener('abort', onAbort, { once: true });
          abortRelay = () => parentSignal.removeEventListener('abort', onAbort);
        }
      }
      const timeoutId = window.setTimeout(() => timeoutController.abort(), 10_000);
      const signal = timeoutController.signal;
      if (showLoading || !hasLoadedRef.current) setLoading(true);
      setError(null);
      try {
        const res = await cachedFetch(
          `${props.baseUrl}/openclaw/channels?targetId=${encodeURIComponent(selectedTargetId)}`,
          {
            headers,
            signal,
            ttlMs: 10_000,
          }
        );
        if (signal.aborted || requestVersion !== fetchVersionRef.current) return false;
        if (!res.ok) {
          setError(`Failed to load channels (HTTP ${res.status})`);
          setChannels([]);
          return false;
        }
        const data = (await res.json()) as OpenClawChannelsResponse;
        const safeChannels = (data.channels ?? []).map((ch) => ({
          ...ch,
          boundAgents: ch.boundAgents ?? [],
          allowFrom: ch.allowFrom ?? [],
          accountSummary: ch.accountSummary ?? {
            total: 0,
            enabled: 0,
            configured: 0,
            connected: 0,
            runtimeKnown: 0,
          },
        }));
        setChannels(safeChannels);
        setConfigPath(data.configPath ?? null);
        setConfigStatus(data.configStatus ?? 'missing');
        setConfigCandidates(data.configCandidates ?? []);
        hasLoadedRef.current = true;

        cachedFetch(
          `${props.baseUrl}/openclaw/targets/${encodeURIComponent(selectedTargetId)}/agents`,
          {
            headers,
            ttlMs: 15_000,
          }
        )
          .then((r) => (r.ok ? r.json() : null))
          .then((d: unknown) => {
            const agData = d as { agents?: Array<{ id: string; name?: string }> } | null;
            if (agData?.agents) {
              setAgentOptions(agData.agents.map((a) => ({ id: a.id, name: a.name || a.id })));
            }
          })
          .catch(() => {});

        return true;
      } catch (err) {
        if (signal.aborted || requestVersion !== fetchVersionRef.current) return false;
        setError(err instanceof Error ? err.message : 'Failed to load channels');
        setChannels([]);
        return false;
      } finally {
        window.clearTimeout(timeoutId);
        abortRelay?.();
        if (controller && fetchControllerRef.current === controller)
          fetchControllerRef.current = null;
        if (requestVersion === fetchVersionRef.current) {
          setLoading(false);
        }
      }
    },
    [props.baseUrl, headers, isConnected, selectedTargetId]
  );

  useSmartPoll(fetchChannels, {
    enabled: isConnected && targetContext.state === 'ready',
    baseIntervalMs: 30_000,
    maxIntervalMs: 120_000,
    pauseOnHidden,
  });

  const fetchChannelsRef = useRef(fetchChannels);
  fetchChannelsRef.current = fetchChannels;

  useEffect(() => {
    return onConfigChanged(() => void fetchChannelsRef.current(undefined, false));
  }, []);

  useEffect(
    () => () => {
      fetchControllerRef.current?.abort();
    },
    []
  );

  useEffect(() => {
    fetchControllerRef.current?.abort();
    hasLoadedRef.current = false;
    setExpandedCardId(null);
    setConfigDialogChannel(null);
    setActiveSection('healthy');

    if (!isConnected) {
      setChannels([]);
      setConfigPath(null);
      setConfigStatus('missing');
      setConfigCandidates([]);
      setError(null);
      setLoading(false);
      return;
    }

    if (!selectedTargetId) {
      setChannels([]);
      setConfigPath(null);
      setConfigStatus('missing');
      setConfigCandidates([]);
      setError(null);
      setLoading(false);
      return;
    }

    setError(null);
  }, [isConnected, selectedTargetId]);

  const openConfigDialog = useCallback(
    async (channel: OpenClawChannel) => {
      setConfigDialogChannel(channel);
      if (!selectedTargetId) return;
      try {
        const [agRes, modRes] = await Promise.all([
          fetch(
            `${props.baseUrl}/openclaw/targets/${encodeURIComponent(selectedTargetId)}/agents`,
            { headers }
          ),
          fetch(
            `${props.baseUrl}/openclaw/targets/${encodeURIComponent(selectedTargetId)}/models`,
            { headers }
          ),
        ]);
        if (agRes.ok) {
          const data = (await agRes.json()) as { agents?: OpenClawAgent[] };
          setAgentOptions((data.agents ?? []).map((a) => ({ id: a.id, name: a.name || a.id })));
        }
        if (modRes.ok) {
          const data = (await modRes.json()) as { models?: OpenClawModelProfile[] };
          setModelOptionsForDialog(
            (data.models ?? []).map((m) => ({ id: m.id, name: m.name || m.id }))
          );
        }
      } catch {
        /* ignore */
      }
    },
    [props.baseUrl, headers, selectedTargetId]
  );

  const handleChannelConfig = useCallback(
    (data: {
      enabled?: boolean;
      dmPolicy?: string;
      groupPolicy?: string;
      modelOverride?: string;
    }) => {
      if (!configDialogChannel || !selectedTargetId) return;
      const cmds: { command: string; args: string[]; description: string }[] = [];
      if (data.enabled !== undefined)
        cmds.push({
          command: 'openclaw',
          args: [
            'config',
            'set',
            `channels.${configDialogChannel.id}.enabled`,
            String(data.enabled),
          ],
          description: `Toggle channel`,
        });
      if (data.dmPolicy)
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `channels.${configDialogChannel.id}.dmPolicy`, data.dmPolicy],
          description: `Set DM policy`,
        });
      if (data.groupPolicy)
        cmds.push({
          command: 'openclaw',
          args: [
            'config',
            'set',
            `channels.${configDialogChannel.id}.groupPolicy`,
            data.groupPolicy,
          ],
          description: `Set group policy`,
        });
      if (data.modelOverride)
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `channels.${configDialogChannel.id}.model`, data.modelOverride],
          description: `Set model override`,
        });
      if (cmds.length > 0) {
        const doQueue = (): void => {
          setPendingMutation(true);
          void fetch(`${props.baseUrl}/openclaw/queue`, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ targetId: selectedTargetId, commands: cmds }),
          }).finally(() => setPendingMutation(false));
        };
        if (pendingMutation) {
          setConfirmState({
            title: 'Queue Pending',
            message: 'A previous channel update is still pending. Queue another update anyway?',
            onConfirm: () => {
              setConfirmState(null);
              doQueue();
            },
          });
          return;
        }
        doQueue();
      }
      setConfigDialogChannel(null);
    },
    [configDialogChannel, selectedTargetId, props.baseUrl, headers, pendingMutation]
  );

  const handleChannelBind = useCallback(
    (agentId: string, modelOverride?: string) => {
      if (!configDialogChannel || !selectedTargetId) return;
      const cmds: { command: string; args: string[]; description: string }[] = [
        {
          command: 'openclaw',
          args: ['config', 'set', `channels.${configDialogChannel.id}.agents.+`, agentId],
          description: `Bind agent`,
        },
      ];
      if (modelOverride) {
        cmds.push({
          command: 'openclaw',
          args: ['config', 'set', `channels.${configDialogChannel.id}.model`, modelOverride],
          description: `Set model override`,
        });
      }
      const doQueue = (): void => {
        setPendingMutation(true);
        void fetch(`${props.baseUrl}/openclaw/queue`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetId: selectedTargetId, commands: cmds }),
        }).finally(() => setPendingMutation(false));
      };
      if (pendingMutation) {
        setConfirmState({
          title: 'Queue Pending',
          message: 'A previous channel binding is still pending. Queue another update anyway?',
          onConfirm: () => {
            setConfirmState(null);
            doQueue();
          },
        });
        return;
      }
      doQueue();
    },
    [configDialogChannel, selectedTargetId, props.baseUrl, headers, pendingMutation]
  );

  const handleChannelUnbind = useCallback(
    (channelId: string, agentId: string) => {
      if (!selectedTargetId) return;
      const doUnbind = (): void => {
        setPendingMutation(true);
        void fetch(
          `${props.baseUrl}/openclaw/targets/${encodeURIComponent(selectedTargetId)}/channels/${encodeURIComponent(channelId)}/unbind`,
          {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: JSON.stringify({ agentId }),
          }
        ).finally(() => setPendingMutation(false));
      };
      if (pendingMutation) {
        setConfirmState({
          title: 'Queue Pending',
          message: 'A previous channel update is still pending. Queue unbind anyway?',
          onConfirm: () => {
            setConfirmState(null);
            doUnbind();
          },
        });
        return;
      }
      doUnbind();
    },
    [selectedTargetId, props.baseUrl, headers, pendingMutation]
  );

  const summary = useMemo(() => {
    const configured = channels.filter((c) => c.configured).length;
    const connected = channels.filter((c) => c.connected).length;
    const riskyDm = channels.filter((c) => c.dmPolicy === 'open' && c.allowFromHasWildcard).length;
    return { total: channels.length, configured, connected, riskyDm };
  }, [channels]);

  const sortedChannels = useMemo(() => {
    return [...channels].sort((a, b) => {
      if (a.connected !== b.connected) return a.connected ? -1 : 1;
      if (a.configured !== b.configured) return a.configured ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }, [channels]);

  const filteredChannels = useMemo(() => {
    const q = search.trim().toLowerCase();
    return sortedChannels.filter((channel) => {
      if (showOnlyConfigured && !channel.configured) return false;
      if (showOnlyAttention && channelPriority(channel) === 'low') return false;
      if (!q) return true;
      return channel.name.toLowerCase().includes(q) || channel.id.toLowerCase().includes(q);
    });
  }, [search, showOnlyAttention, showOnlyConfigured, sortedChannels]);

  const groupedChannels = useMemo(() => {
    const attention = filteredChannels
      .filter((channel) => channelPriority(channel) !== 'low')
      .sort((a, b) => {
        const priorityDelta =
          channelPriorityRank(channelPriority(b)) - channelPriorityRank(channelPriority(a));
        if (priorityDelta !== 0) return priorityDelta;
        if (a.connected !== b.connected) return a.connected ? 1 : -1;
        if (a.configured !== b.configured) return a.configured ? 1 : -1;
        return a.name.localeCompare(b.name);
      });
    const healthy = filteredChannels
      .filter((channel) => channelPriority(channel) === 'low')
      .sort((a, b) => {
        if (a.connected !== b.connected) return a.connected ? -1 : 1;
        if (a.configured !== b.configured) return a.configured ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return { attention, healthy };
  }, [filteredChannels]);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') return;
    const healthyNode = healthySectionRef.current;
    const attentionNode = attentionSectionRef.current;
    if (!healthyNode || !attentionNode) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio);
        if (visible.length === 0) return;
        const section = visible[0]?.target.getAttribute('data-section');
        if (section === 'healthy' || section === 'attention') {
          setActiveSection(section);
        }
      },
      { threshold: [0.25, 0.5, 0.75], rootMargin: '-72px 0px -60% 0px' }
    );
    observer.observe(healthyNode);
    observer.observe(attentionNode);
    return () => observer.disconnect();
  }, [groupedChannels.healthy.length, groupedChannels.attention.length]);

  const handleCopy = (value: string, key: string): void => {
    void navigator.clipboard
      .writeText(value)
      .then(() => {
        setCopiedKey(key);
        window.setTimeout(() => {
          setCopiedKey((prev) => (prev === key ? null : prev));
        }, 1_200);
      })
      .catch(() => undefined);
  };

  const toggleCard = (id: string): void => {
    setExpandedCardId((prev) => (prev === id ? null : id));
  };

  if (targetContext.state === 'notReady') {
    return (
      <section className="view-panel">
        <div className="view-header">
          <h2 className="view-title">Channels</h2>
        </div>
        <OpenClawPageState kind="notReady" featureName="channels" />
      </section>
    );
  }

  if (targetContext.state === 'noTarget') {
    return (
      <section className="view-panel">
        <div className="view-header">
          <h2 className="view-title">Channels</h2>
          <TargetLockBadge targetId={selectedTargetId} />
        </div>
        <OpenClawPageState kind="noTarget" featureName="channels" />
      </section>
    );
  }

  const needsConfigHint =
    configStatus === 'missing' || configStatus === 'empty' || configStatus === 'invalid';

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Channels</h2>
        <div className="ch-header-actions">
          <TargetLockBadge targetId={selectedTargetId} />
          {pendingMutation ? <span className="badge tone-warn">queue pending</span> : null}
          {targets.length > 0 ? (
            <select
              value={selectedTargetId ?? ''}
              onChange={(e) => {
                setSelectedTargetId(e.target.value || null);
              }}
            >
              {targets.map((target) => (
                <option key={target.id} value={target.id}>
                  {target.label} ({target.type})
                </option>
              ))}
            </select>
          ) : null}
          <button
            className="btn-ghost"
            onClick={() => {
              void fetchChannels(undefined, true);
            }}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
      </div>
      <div className="ch-page-subtitle">
        Smart channel posture for OpenClaw providers, policies, and runtime readiness.
      </div>

      {/* Summary Strip */}
      {summary.total > 0 ? (
        <div className="ch-summary-strip">
          <SummaryGauge
            label="Connected"
            value={summary.connected}
            total={summary.total}
            color="var(--green)"
          />
          <SummaryGauge
            label="Configured"
            value={summary.configured}
            total={summary.total}
            color="var(--accent)"
          />
          {summary.riskyDm > 0 ? (
            <div className="ch-summary-alert">
              <span className="ch-summary-alert-dot" />
              {summary.riskyDm} DM risk
            </div>
          ) : null}
          {configPath ? <div className="ch-summary-config-path mono">{configPath}</div> : null}
        </div>
      ) : null}

      {/* Compact config hint */}
      {needsConfigHint ? (
        <div
          className={`ch-config-banner${configStatus === 'invalid' ? ' ch-config-banner-error' : ''}`}
        >
          <div className="ch-config-banner-row">
            <span className="ch-config-banner-icon">{configStatus === 'invalid' ? '!' : 'i'}</span>
            <span className="ch-config-banner-text">
              {configStatus === 'missing'
                ? 'Config not detected for this target'
                : configStatus === 'empty'
                  ? 'Config file is empty'
                  : 'Config file has invalid JSON'}
            </span>
            {configCandidates.length > 0 || configStatus !== 'invalid' ? (
              <button
                className="ch-config-banner-toggle"
                type="button"
                onClick={() => {
                  setConfigHintOpen((v) => !v);
                }}
              >
                {configHintOpen ? 'Hide' : 'Details'}
              </button>
            ) : null}
          </div>
          {configHintOpen ? (
            <div className="ch-config-banner-details">
              {configCandidates.length > 0 ? (
                <div className="ch-config-paths">
                  Expected: <span className="mono">{configCandidates.join(' / ')}</span>
                </div>
              ) : null}
              <div className="ch-config-actions">
                {configCandidates[0] ? (
                  <button
                    className="btn-ghost"
                    type="button"
                    onClick={() => {
                      handleCopy(configCandidates[0]!, 'copy-config-path');
                    }}
                  >
                    {copiedKey === 'copy-config-path' ? 'Copied' : 'Copy Path'}
                  </button>
                ) : null}
                <button
                  className="btn-ghost"
                  type="button"
                  onClick={() => {
                    handleCopy(
                      '{\n  "channels": {\n    "discord": {\n      "enabled": true,\n      "dmPolicy": "pairing",\n      "groupsEnabled": false\n    }\n  }\n}',
                      'copy-config-template'
                    );
                  }}
                >
                  {copiedKey === 'copy-config-template' ? 'Copied' : 'Copy Template'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Toolbar */}
      <div className="channels-toolbar">
        <input
          type="search"
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
          }}
          placeholder="Search channel name or id"
        />
        <div className="channels-toolbar-actions">
          <button
            className={`btn-ghost${showOnlyAttention ? ' is-active' : ''}`}
            onClick={() => {
              setShowOnlyAttention((v) => !v);
            }}
            type="button"
          >
            Attention Only
          </button>
          <button
            className={`btn-ghost${showOnlyConfigured ? ' is-active' : ''}`}
            onClick={() => {
              setShowOnlyConfigured((v) => !v);
            }}
            type="button"
          >
            Configured Only
          </button>
        </div>
      </div>
      {filteredChannels.length > 0 ? (
        <div className="channels-jumpbar" role="tablist" aria-label="Channel sections">
          <button
            type="button"
            className={`channels-jump-chip${activeSection === 'healthy' ? ' is-active' : ''}`}
            onClick={() => {
              setActiveSection('healthy');
              healthySectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            aria-selected={activeSection === 'healthy'}
          >
            Healthy <span>{groupedChannels.healthy.length}</span>
          </button>
          <button
            type="button"
            className={`channels-jump-chip channels-jump-chip-attention${activeSection === 'attention' ? ' is-active' : ''}`}
            onClick={() => {
              setActiveSection('attention');
              attentionSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }}
            aria-selected={activeSection === 'attention'}
          >
            Needs Attention <span>{groupedChannels.attention.length}</span>
          </button>
        </div>
      ) : null}

      {error && channels.length === 0 ? (
        <OpenClawPageState
          kind="error"
          featureName="channels"
          errorMessage={error}
          onRetry={() => void fetchChannels(undefined, true)}
        />
      ) : error ? (
        <div className="error-banner-smart" role="alert">
          <span className="error-banner-smart-icon">!</span>
          <span className="error-banner-smart-msg">{error}</span>
          <button
            type="button"
            className="error-banner-smart-retry"
            onClick={() => void fetchChannels(undefined, true)}
          >
            Retry
          </button>
        </div>
      ) : null}

      {loading ? (
        <ChannelSkeletonGrid count={7} />
      ) : channels.length === 0 ? (
        <div className="empty-state-smart">
          <div className="empty-state-smart-icon">
            <IconMessage width={24} height={24} />
          </div>
          <h4>No channels found</h4>
          <p>
            This target has no channel configuration yet. Configure OpenClaw channels to start
            managing your messaging providers.
          </p>
          <div className="empty-state-smart-actions">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => void fetchChannels(undefined, true)}
            >
              Refresh
            </button>
          </div>
        </div>
      ) : filteredChannels.length === 0 ? (
        <div className="empty-state-smart">
          <div className="empty-state-smart-icon">
            <IconMessage width={24} height={24} />
          </div>
          <h4>No matching channels</h4>
          <p>Try adjusting your search or filters.</p>
          <div className="empty-state-smart-actions">
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setSearch('');
                setShowOnlyAttention(false);
                setShowOnlyConfigured(false);
              }}
            >
              Clear Filters
            </button>
          </div>
        </div>
      ) : (
        <>
          <section ref={healthySectionRef} className="channels-section" data-section="healthy">
            <div className="channels-section-head channels-section-head-healthy">
              <div className="channels-section-head-copy">
                <h3>Healthy</h3>
                <p>Stable now — no urgent action required.</p>
              </div>
              <span>{groupedChannels.healthy.length} channels</span>
            </div>
            {groupedChannels.healthy.length > 0 ? (
              <div className="channels-grid">
                {groupedChannels.healthy.map((channel) => (
                  <ChannelCard
                    key={channel.id}
                    channel={channel}
                    expanded={expandedCardId === channel.id}
                    onToggle={() => {
                      toggleCard(channel.id);
                    }}
                    copiedKey={copiedKey}
                    onCopy={handleCopy}
                    onConfigure={() => void openConfigDialog(channel)}
                    agentOptions={agentOptions}
                    onBind={(agentId) => handleChannelBind(agentId)}
                    onUnbind={(agentId) => handleChannelUnbind(channel.id, agentId)}
                  />
                ))}
              </div>
            ) : (
              <div className="ch-section-empty">No healthy channels yet.</div>
            )}
          </section>

          <section ref={attentionSectionRef} className="channels-section" data-section="attention">
            <div className="channels-section-head channels-section-head-attention">
              <div className="channels-section-head-copy">
                <h3>Needs Attention</h3>
                <p>Prioritize these to reduce delivery and policy risk.</p>
              </div>
              <span>{groupedChannels.attention.length} channels</span>
            </div>
            {groupedChannels.attention.length > 0 ? (
              <div className="channels-grid">
                {groupedChannels.attention.map((channel) => (
                  <ChannelCard
                    key={channel.id}
                    channel={channel}
                    expanded={expandedCardId === channel.id}
                    onToggle={() => {
                      toggleCard(channel.id);
                    }}
                    copiedKey={copiedKey}
                    onCopy={handleCopy}
                    onConfigure={() => void openConfigDialog(channel)}
                    agentOptions={agentOptions}
                    onBind={(agentId) => handleChannelBind(agentId)}
                    onUnbind={(agentId) => handleChannelUnbind(channel.id, agentId)}
                  />
                ))}
              </div>
            ) : (
              <div className="ch-section-empty">No channels need attention.</div>
            )}
          </section>
        </>
      )}

      {configDialogChannel ? (
        <ChannelConfigDialog
          channelId={configDialogChannel.id}
          channelName={configDialogChannel.name}
          initialEnabled={configDialogChannel.configured}
          initialDmPolicy={
            configDialogChannel.dmPolicy !== 'unknown' ? configDialogChannel.dmPolicy : undefined
          }
          initialGroupPolicy={
            configDialogChannel.groupPolicy !== 'unknown'
              ? configDialogChannel.groupPolicy
              : undefined
          }
          boundAgents={configDialogChannel.boundAgents ?? []}
          agentOptions={agentOptions}
          modelOptions={modelOptionsForDialog}
          onSubmit={handleChannelConfig}
          onBind={handleChannelBind}
          onUnbind={(agentId) => handleChannelUnbind(configDialogChannel.id, agentId)}
          onClose={() => setConfigDialogChannel(null)}
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
