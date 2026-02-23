import { useCallback, useEffect, useMemo, useState } from 'react';
import { IconMessage } from '../components/Icons';
import type { TargetSyncStatusEntry } from '../hooks/useOpenClawTargets';
import type { ConnectionStatus } from '../types';
import { formatRelativeTime } from '../utils/time';
import type { OpenClawAgent, OpenClawModelProfile } from '@patze/telemetry-core';
import { ChannelConfigDialog } from './channels/ChannelConfigDialog';

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

type ChannelPriority = 'high' | 'medium' | 'low';

export interface ChannelsViewProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly status: ConnectionStatus;
  readonly openclawTargets: readonly TargetSyncStatusEntry[];
}

const PROVIDER_THEME: Readonly<Record<string, { letter: string; color: string; bg: string }>> = {
  discord: { letter: 'D', color: '#5865F2', bg: 'rgba(88,101,242,0.15)' },
  telegram: { letter: 'T', color: '#26A5E4', bg: 'rgba(38,165,228,0.15)' },
  whatsapp: { letter: 'W', color: '#25D366', bg: 'rgba(37,211,102,0.15)' },
  slack: { letter: 'S', color: '#E01E5A', bg: 'rgba(224,30,90,0.15)' },
  signal: { letter: 'Si', color: '#3A76F0', bg: 'rgba(58,118,240,0.15)' },
  imessage: { letter: 'iM', color: '#34C759', bg: 'rgba(52,199,89,0.15)' },
  teams: { letter: 'Te', color: '#6264A7', bg: 'rgba(98,100,167,0.15)' },
  matrix: { letter: 'M', color: '#0DBD8B', bg: 'rgba(13,189,139,0.15)' },
  irc: { letter: 'IR', color: '#8B8B8B', bg: 'rgba(139,139,139,0.15)' },
  line: { letter: 'L', color: '#06C755', bg: 'rgba(6,199,85,0.15)' },
};

function getProviderTheme(id: string): { letter: string; color: string; bg: string } {
  const key = id.toLowerCase();
  if (PROVIDER_THEME[key]) return PROVIDER_THEME[key];
  return {
    letter: id.charAt(0).toUpperCase(),
    color: 'var(--text-muted)',
    bg: 'var(--bg-elevated)',
  };
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

function dmBadgeTone(dmPolicy: OpenClawChannel['dmPolicy']): string {
  switch (dmPolicy) {
    case 'pairing':
      return 'tone-good';
    case 'allowlist':
      return 'tone-neutral';
    case 'open':
      return 'tone-warn';
    case 'disabled':
      return 'tone-muted';
    case 'unknown':
      return 'tone-muted';
    default: {
      const _exhaustive: never = dmPolicy;
      return _exhaustive;
    }
  }
}

function channelPriority(channel: OpenClawChannel): ChannelPriority {
  if (!channel.configured) return 'high';
  if (channel.dmPolicy === 'open' && channel.allowFromHasWildcard) return 'high';
  if (channel.dmPolicy === 'disabled') return 'medium';
  if (!channel.connected || channel.runtimeState === 'unknown') return 'medium';
  return 'low';
}

function channelRecommendation(channel: OpenClawChannel): string {
  if (!channel.configured) return 'Add channel config in openclaw.json to enable this provider.';
  if (!channel.connected && channel.runtimeState === 'disconnected')
    return 'Check credentials/session and reconnect this provider.';
  if (channel.runtimeState === 'unknown')
    return 'Runtime connectivity unknown. Verify with OpenClaw channels status.';
  if (channel.dmPolicy === 'open' && channel.allowFromHasWildcard)
    return 'DM open with wildcard allowFrom. Consider pairing/allowlist.';
  if (channel.dmPolicy === 'disabled') return 'DM disabled. Enable only if intentional.';
  if (channel.dmPolicy === 'allowlist') return 'Allowlist active. Keep allowFrom updated.';
  return '';
}

function statusLabel(channel: OpenClawChannel): string {
  if (!channel.configured) return 'Not Configured';
  if (channel.connected) return 'Connected';
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

function ChannelCard(props: {
  readonly channel: OpenClawChannel;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly copiedKey: string | null;
  readonly onCopy: (value: string, key: string) => void;
  readonly onConfigure?: (() => void) | undefined;
}): JSX.Element {
  const { channel, expanded, onToggle, copiedKey, onCopy } = props;
  const priority = channelPriority(channel);
  const theme = getProviderTheme(channel.id);
  const recommendation = channelRecommendation(channel);

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
          </div>
          <div className="ch-card-sub-row">
            <span className="ch-card-status-text">{statusLabel(channel)}</span>
            <span className="ch-card-dm-pill">
              <span className={`ch-dm-dot ${dmBadgeTone(channel.dmPolicy)}`} />
              DM: {channel.dmPolicy}
            </span>
          </div>
        </div>
        <span
          className={`ch-expand-chevron${expanded ? ' ch-expand-open' : ''}`}
          aria-hidden="true"
        >
          &#x25BE;
        </span>
      </header>

      {expanded ? (
        <div className="ch-card-details">
          <div className="ch-detail-grid">
            <div className="ch-detail-item">
              <span className="ch-detail-label">AllowFrom</span>
              <span className="ch-detail-value">
                {channel.allowFromCount}
                {channel.allowFromHasWildcard ? ' (wildcard)' : ''}
              </span>
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
                </span>
              </div>
            ) : null}
            <div className="ch-detail-item">
              <span className="ch-detail-label">Messages</span>
              <span className="ch-detail-value">{channel.messageCount ?? 0}</span>
            </div>
          </div>
          {recommendation ? <p className="channel-recommendation">{recommendation}</p> : null}
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
                className="dialog-btn-primary"
                type="button"
                style={{ fontSize: '0.72rem', padding: '3px 10px' }}
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
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
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
  const [agentOptions, setAgentOptions] = useState<readonly { id: string; name: string }[]>([]);
  const [modelOptionsForDialog, setModelOptionsForDialog] = useState<
    readonly { id: string; name: string }[]
  >([]);

  const isConnected = props.status === 'connected' || props.status === 'degraded';
  const headers = useMemo(() => authHeaders(props.token), [props.token]);

  useEffect(() => {
    if (targets.length > 0 && !selectedTargetId) {
      setSelectedTargetId(targets[0]!.id);
    }
  }, [targets, selectedTargetId]);

  const fetchChannels = useCallback(async () => {
    if (!isConnected) return;
    setLoading(true);
    setError(null);
    try {
      const params = selectedTargetId ? `?targetId=${encodeURIComponent(selectedTargetId)}` : '';
      const res = await fetch(`${props.baseUrl}/openclaw/channels${params}`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) {
        setError(`Failed to load channels (HTTP ${res.status})`);
        setChannels([]);
        return;
      }
      const data = (await res.json()) as OpenClawChannelsResponse;
      setChannels([...data.channels]);
      setConfigPath(data.configPath ?? null);
      setConfigStatus(data.configStatus ?? 'missing');
      setConfigCandidates(data.configCandidates ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load channels');
      setChannels([]);
    } finally {
      setLoading(false);
    }
  }, [props.baseUrl, headers, isConnected, selectedTargetId]);

  useEffect(() => {
    if (!isConnected) return;
    void fetchChannels();
    const interval = setInterval(() => {
      if (!document.hidden) void fetchChannels();
    }, 30_000);
    return () => {
      clearInterval(interval);
    };
  }, [isConnected, fetchChannels]);

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
          const data = (await agRes.json()) as { agents: OpenClawAgent[] };
          setAgentOptions(data.agents.map((a) => ({ id: a.id, name: a.name || a.id })));
        }
        if (modRes.ok) {
          const data = (await modRes.json()) as { models: OpenClawModelProfile[] };
          setModelOptionsForDialog(data.models.map((m) => ({ id: m.id, name: m.name || m.id })));
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
        void fetch(`${props.baseUrl}/openclaw/queue`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetId: selectedTargetId, commands: cmds }),
        });
      }
      setConfigDialogChannel(null);
    },
    [configDialogChannel, selectedTargetId, props.baseUrl, headers]
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
      void fetch(`${props.baseUrl}/openclaw/queue`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetId: selectedTargetId, commands: cmds }),
      });
    },
    [configDialogChannel, selectedTargetId, props.baseUrl, headers]
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
    const attention = filteredChannels.filter((channel) => channelPriority(channel) !== 'low');
    const healthy = filteredChannels.filter((channel) => channelPriority(channel) === 'low');
    return { attention, healthy };
  }, [filteredChannels]);

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

  if (!isConnected) {
    return (
      <section className="view-panel">
        <div className="view-header">
          <h2 className="view-title">Channels</h2>
        </div>
        <div className="empty-state">
          <div className="empty-state-icon">
            <IconMessage width={28} height={28} />
          </div>
          <p>Connect to the control plane to inspect OpenClaw channels.</p>
        </div>
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
              void fetchChannels();
            }}
            disabled={loading}
          >
            Refresh
          </button>
        </div>
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

      {error ? (
        <div className="task-error-banner" role="alert">
          {error}
        </div>
      ) : null}

      {loading ? (
        <div className="empty-state">
          <span className="inline-loading">
            <span className="mini-spinner" /> Loading channels...
          </span>
        </div>
      ) : channels.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <IconMessage width={28} height={28} />
          </div>
          <p>No channel configuration found for this target.</p>
        </div>
      ) : filteredChannels.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <IconMessage width={28} height={28} />
          </div>
          <p>No channels match current filters.</p>
        </div>
      ) : (
        <>
          {groupedChannels.attention.length > 0 ? (
            <section className="channels-section">
              <div className="channels-section-head">
                <h3>Needs Attention</h3>
                <span>{groupedChannels.attention.length} channels</span>
              </div>
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
                  />
                ))}
              </div>
            </section>
          ) : null}

          {groupedChannels.healthy.length > 0 ? (
            <section className="channels-section">
              <div className="channels-section-head">
                <h3>Healthy</h3>
                <span>{groupedChannels.healthy.length} channels</span>
              </div>
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
                  />
                ))}
              </div>
            </section>
          ) : null}
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
          agentOptions={agentOptions}
          modelOptions={modelOptionsForDialog}
          onSubmit={handleChannelConfig}
          onBind={handleChannelBind}
          onClose={() => setConfigDialogChannel(null)}
        />
      ) : null}
    </section>
  );
}
