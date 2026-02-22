import { useCallback, useEffect, useMemo, useState } from 'react';
import { IconMessage } from '../components/Icons';
import type { TargetSyncStatusEntry } from '../hooks/useOpenClawTargets';
import type { ConnectionStatus } from '../types';
import { formatRelativeTime } from '../utils/time';

interface OpenClawChannel {
  readonly id: string;
  readonly name: string;
  readonly configured: boolean;
  readonly dmPolicy: 'pairing' | 'open' | 'unknown';
  readonly hasGroups: boolean;
  readonly connected: boolean;
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

function authHeaders(token: string): Record<string, string> {
  if (!token) return {};
  return { Authorization: `Bearer ${token}` };
}

function channelBadgeTone(channel: OpenClawChannel): string {
  if (!channel.configured) return 'tone-muted';
  if (channel.connected) return 'tone-good';
  return 'tone-warn';
}

function dmBadgeTone(dmPolicy: OpenClawChannel['dmPolicy']): string {
  switch (dmPolicy) {
    case 'pairing':
      return 'tone-good';
    case 'open':
      return 'tone-warn';
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
  if (!channel.connected || channel.dmPolicy === 'open') return 'medium';
  return 'low';
}

function channelPriorityTone(priority: ChannelPriority): string {
  switch (priority) {
    case 'high':
      return 'tone-warn';
    case 'medium':
      return 'tone-neutral';
    case 'low':
      return 'tone-good';
    default: {
      const _exhaustive: never = priority;
      return _exhaustive;
    }
  }
}

function channelRecommendation(channel: OpenClawChannel): string {
  if (!channel.configured) return 'Add channel config in openclaw.json to enable this provider.';
  if (!channel.connected) return 'Check credentials/session and reconnect this provider.';
  if (channel.dmPolicy === 'open')
    return 'DM policy is open. Consider pairing mode for safer operation.';
  return 'Channel is healthy and ready.';
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
      void fetchChannels();
    }, 30_000);
    return () => {
      clearInterval(interval);
    };
  }, [isConnected, fetchChannels]);

  const summary = useMemo(() => {
    const configured = channels.filter((c) => c.configured).length;
    const connected = channels.filter((c) => c.connected).length;
    const dmOpen = channels.filter((c) => c.dmPolicy === 'open').length;
    return { total: channels.length, configured, connected, dmOpen };
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
      if (
        showOnlyAttention &&
        channel.configured &&
        channel.connected &&
        channel.dmPolicy !== 'open'
      )
        return false;
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

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Channels</h2>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {targets.length > 0 ? (
            <select
              value={selectedTargetId ?? ''}
              onChange={(e) => {
                setSelectedTargetId(e.target.value || null);
              }}
              style={{ maxWidth: 260 }}
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

      <div className="task-stats-bar" style={{ marginBottom: 12 }}>
        <div className="task-stat">
          <span className="task-stat-label">Total</span>
          <span className="status-strip-value mono">{summary.total}</span>
        </div>
        <div className="task-stat">
          <span className="task-stat-label">Configured</span>
          <span className="status-strip-value mono">{summary.configured}</span>
        </div>
        <div className="task-stat">
          <span className="task-stat-label">Connected</span>
          <span className="status-strip-value mono">{summary.connected}</span>
        </div>
        <div className="task-stat">
          <span className="task-stat-label">DM Open</span>
          <span className="status-strip-value mono">{summary.dmOpen}</span>
        </div>
      </div>

      {configPath ? (
        <div className="task-stats-bar" style={{ marginBottom: 12 }}>
          <div className="task-stat">
            <span className="task-stat-label">Config</span>
            <span className="status-strip-value mono">{configPath}</span>
          </div>
        </div>
      ) : null}

      {configStatus === 'missing' ? (
        <div className="channels-config-hint">
          Config file is currently empty/not detected for this target. Run OpenClaw setup on the
          selected target to generate the correct path.
          {configCandidates.length > 0 ? (
            <div style={{ marginTop: 6, fontSize: '0.72rem' }}>
              Expected paths: <span className="mono">{configCandidates.join('  •  ')}</span>
            </div>
          ) : null}
          <div style={{ marginTop: 8, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {configCandidates[0] ? (
              <button
                className="btn-ghost"
                type="button"
                onClick={() => {
                  handleCopy(configCandidates[0]!, 'copy-config-path');
                }}
              >
                {copiedKey === 'copy-config-path' ? 'Path Copied' : 'Copy Config Path'}
              </button>
            ) : null}
            <button
              className="btn-ghost"
              type="button"
              onClick={() => {
                handleCopy(
                  `{\n  "channels": {\n    "discord": {\n      "enabled": true,\n      "dmPolicy": "pairing",\n      "groupsEnabled": false\n    }\n  }\n}`,
                  'copy-config-template'
                );
              }}
            >
              {copiedKey === 'copy-config-template' ? 'Template Copied' : 'Copy Starter Template'}
            </button>
          </div>
        </div>
      ) : null}

      {configStatus === 'empty' ? (
        <div className="channels-config-hint">
          Config file exists but is empty. Add valid JSON channel configuration before runtime
          checks can pass.
          {configPath ? (
            <div style={{ marginTop: 6, fontSize: '0.72rem' }}>
              Detected path: <span className="mono">{configPath}</span>
            </div>
          ) : null}
        </div>
      ) : null}

      {configStatus === 'invalid' ? (
        <div className="channels-config-hint channels-config-hint-warn" role="alert">
          Config file exists but is invalid JSON. Fix `openclaw.json` before channel status can be
          trusted.
        </div>
      ) : null}

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
                {groupedChannels.attention.map((channel) => {
                  const priority = channelPriority(channel);
                  return (
                    <article
                      key={channel.id}
                      className={`channel-card channel-card-smart channel-priority-${priority}`}
                    >
                      <header className="channel-card-head">
                        <div>
                          <strong className="channel-card-title">{channel.name}</strong>
                          <div className="tone-muted channel-card-subtitle">{channel.id}</div>
                        </div>
                        <div className="channel-card-badges">
                          <span className={`badge ${channelBadgeTone(channel)}`}>
                            {channel.configured
                              ? channel.connected
                                ? 'connected'
                                : 'configured'
                              : 'not configured'}
                          </span>
                          <span className={`badge ${channelPriorityTone(priority)}`}>
                            {priority === 'high' ? 'setup first' : 'needs review'}
                          </span>
                        </div>
                      </header>
                      <div className="channel-card-meta">
                        <span className={`badge ${dmBadgeTone(channel.dmPolicy)}`}>
                          DM: {channel.dmPolicy}
                        </span>
                        <span
                          className={`badge ${channel.hasGroups ? 'tone-neutral' : 'tone-muted'}`}
                        >
                          {channel.hasGroups ? 'groups enabled' : 'groups off'}
                        </span>
                      </div>
                      <p className="channel-recommendation">{channelRecommendation(channel)}</p>
                      <div className="channel-quick-actions">
                        <button
                          className="btn-ghost"
                          type="button"
                          onClick={() => {
                            handleCopy(`channels.${channel.id}`, `key-${channel.id}`);
                          }}
                        >
                          {copiedKey === `key-${channel.id}` ? 'Key Copied' : 'Copy Channel Key'}
                        </button>
                      </div>
                      <div className="channel-card-footer">
                        {channel.lastMessageAt ? (
                          <span>Last message {formatRelativeTime(channel.lastMessageAt)}</span>
                        ) : (
                          <span>No recent messages</span>
                        )}
                        <span className="mono">{channel.messageCount ?? 0} msgs</span>
                      </div>
                    </article>
                  );
                })}
              </div>
            </section>
          ) : null}

          {groupedChannels.healthy.length > 0 ? (
            <section className="channels-section">
              <div className="channels-section-head">
                <h3>Healthy Channels</h3>
                <span>{groupedChannels.healthy.length} channels</span>
              </div>
              <div className="channels-grid">
                {groupedChannels.healthy.map((channel) => (
                  <article
                    key={channel.id}
                    className="channel-card channel-card-smart channel-priority-low"
                  >
                    <header className="channel-card-head">
                      <div>
                        <strong className="channel-card-title">{channel.name}</strong>
                        <div className="tone-muted channel-card-subtitle">{channel.id}</div>
                      </div>
                      <div className="channel-card-badges">
                        <span className={`badge ${channelBadgeTone(channel)}`}>connected</span>
                        <span className={`badge ${channelPriorityTone('low')}`}>healthy</span>
                      </div>
                    </header>
                    <div className="channel-card-meta">
                      <span className={`badge ${dmBadgeTone(channel.dmPolicy)}`}>
                        DM: {channel.dmPolicy}
                      </span>
                      <span
                        className={`badge ${channel.hasGroups ? 'tone-neutral' : 'tone-muted'}`}
                      >
                        {channel.hasGroups ? 'groups enabled' : 'groups off'}
                      </span>
                    </div>
                    <p className="channel-recommendation">{channelRecommendation(channel)}</p>
                    <div className="channel-quick-actions">
                      <button
                        className="btn-ghost"
                        type="button"
                        onClick={() => {
                          handleCopy(`channels.${channel.id}`, `key-${channel.id}`);
                        }}
                      >
                        {copiedKey === `key-${channel.id}` ? 'Key Copied' : 'Copy Channel Key'}
                      </button>
                    </div>
                    <div className="channel-card-footer">
                      {channel.lastMessageAt ? (
                        <span>Last message {formatRelativeTime(channel.lastMessageAt)}</span>
                      ) : (
                        <span>No recent messages</span>
                      )}
                      <span className="mono">{channel.messageCount ?? 0} msgs</span>
                    </div>
                  </article>
                ))}
              </div>
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}
