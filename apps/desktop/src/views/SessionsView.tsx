import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilterTabs, type FilterTab } from '../components/FilterTabs';
import { IconClipboard, IconClock, IconActivity } from '../components/Icons';
import { LiveDuration } from '../components/LiveDuration';
import { SessionAnalysisPanel } from '../components/SessionAnalysisPanel';
import { StateBadge } from '../components/badges/StateBadge';
import { cachedFetch } from '../hooks/useApiCache';
import { navigate, type RouteFilter } from '../shell/routes';
import type { FrontendUnifiedSnapshot } from '../types';
import {
  channelPriority,
  channelRecommendation,
  priorityBadgeTone,
  priorityLabel,
  runtimeStateDotClass,
  runtimeStateLabel,
  getChannelMeta,
} from '../utils/channel-intelligence';
import { parseSessionOrigin } from '../utils/openclaw';
import { ACTIVE_STATES, TERMINAL_BAD, TERMINAL_OK } from '../utils/lifecycle';
import { formatDuration, formatRelativeTime } from '../utils/time';

export interface SessionsViewProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly filter: RouteFilter;
  readonly baseUrl: string;
  readonly token: string;
  readonly selectedTargetId: string | null;
}

type SessionFilter = 'all' | 'active' | 'completed' | 'failed';
type OriginFilter =
  | 'all'
  | 'whatsapp'
  | 'telegram'
  | 'slack'
  | 'discord'
  | 'line'
  | 'cron'
  | 'other';

interface OpenClawJob {
  readonly jobId: string;
  readonly name: string;
  readonly schedule: { readonly kind: string; readonly expr: string; readonly tz?: string };
  readonly execution: { readonly style: string };
  readonly payload: { readonly kind: string; readonly message?: string };
}

interface OpenClawChannel {
  readonly id: string;
  readonly name: string;
  readonly configured: boolean;
  readonly connected: boolean;
  readonly runtimeState: string;
  readonly dmPolicy: string;
  readonly groupPolicy: string;
  readonly boundAgents: readonly string[];
  readonly hasGroups: boolean;
  readonly allowFromCount: number;
  readonly allowFromHasWildcard: boolean;
  readonly accountSummary: {
    readonly total: number;
    readonly enabled: number;
    readonly configured: number;
    readonly connected: number;
    readonly runtimeKnown: number;
  };
}

interface RawChannelConfig {
  readonly enabled?: boolean;
  readonly dmPolicy?: string;
  readonly groupPolicy?: string;
  readonly streaming?: string;
  readonly guilds?: Record<
    string,
    {
      readonly channels?: Record<
        string,
        { readonly allow?: boolean; readonly requireMention?: boolean }
      >;
      readonly users?: readonly string[];
      readonly requireMention?: boolean;
    }
  >;
  readonly voice?: { readonly enabled?: boolean };
  readonly threadBindings?: { readonly enabled?: boolean; readonly ttlHours?: number };
  readonly ackReaction?: string;
  readonly commands?: { readonly native?: boolean; readonly nativeSkills?: boolean };
  readonly slashCommand?: { readonly ephemeral?: boolean };
  readonly actions?: Record<string, unknown>;
}

function shortId(id: string): string {
  if (id.length <= 12) return id;
  return `${id.slice(0, 10)}…`;
}

function sessionLabel(agentId: string, sessionId: string): string {
  const shortAgent = agentId.length > 16 ? `${agentId.slice(0, 14)}…` : agentId;
  return `${shortAgent} / ${shortId(sessionId)}`;
}

function ChannelCard(props: {
  readonly channel: OpenClawChannel;
  readonly rawConfig: RawChannelConfig | null;
}): JSX.Element {
  const { channel: ch, rawConfig } = props;
  const meta = getChannelMeta(ch.id);
  const priority = channelPriority(ch);
  const recommendation = channelRecommendation(ch);
  const features: string[] = [];

  if (ch.dmPolicy && ch.dmPolicy !== 'unknown') features.push(`DM: ${ch.dmPolicy}`);
  if (ch.groupPolicy && ch.groupPolicy !== 'unknown') features.push(`Group: ${ch.groupPolicy}`);
  if (rawConfig?.streaming) features.push(`Stream: ${rawConfig.streaming}`);
  if (rawConfig?.voice?.enabled) features.push('Voice');
  if (rawConfig?.threadBindings?.enabled)
    features.push(`Threads (${rawConfig.threadBindings.ttlHours ?? '?'}h)`);
  if (rawConfig?.commands?.native) features.push('Slash commands');
  if (rawConfig?.ackReaction) features.push(`Ack: ${rawConfig.ackReaction}`);

  const guildEntries = rawConfig?.guilds ? Object.entries(rawConfig.guilds) : [];
  const totalGuildChannels = guildEntries.reduce(
    (sum, [, g]) => sum + Object.keys(g.channels ?? {}).length,
    0
  );

  const acct = ch.accountSummary;
  const hasAccounts = acct.total > 0;

  return (
    <div
      className={`session-channel-card ${priority !== 'low' ? 'ci-attention' : ''}`}
      style={{ borderLeftColor: meta.color, cursor: 'pointer' }}
      onClick={() => {
        navigate('channels', {});
      }}
      title="Click to manage this channel"
    >
      <div className="session-channel-header">
        <span className="session-channel-icon" style={{ background: meta.color }}>
          {meta.icon}
        </span>
        <div className="session-channel-title">
          <strong>{ch.name}</strong>
          <span
            className={`ci-runtime-dot ${runtimeStateDotClass(ch.runtimeState, ch.configured)}`}
            title={runtimeStateLabel(ch.runtimeState, ch.configured)}
          />
          <span
            className={`badge ${ch.configured ? 'tone-good' : 'tone-neutral'}`}
            style={{ marginLeft: 4 }}
          >
            {ch.configured ? 'enabled' : 'disabled'}
          </span>
          {priority !== 'low' ? (
            <span className={`badge ${priorityBadgeTone(priority)} ci-risk-badge`}>
              {priorityLabel(priority)}
            </span>
          ) : null}
        </div>
      </div>

      {features.length > 0 ? (
        <div className="session-channel-features">
          {features.map((f) => (
            <span key={f} className="badge tone-neutral session-channel-feature">
              {f}
            </span>
          ))}
          {ch.allowFromHasWildcard ? (
            <span className="badge tone-warn session-channel-feature ci-wildcard-badge">
              Wildcard allowFrom
            </span>
          ) : null}
        </div>
      ) : ch.allowFromHasWildcard ? (
        <div className="session-channel-features">
          <span className="badge tone-warn session-channel-feature ci-wildcard-badge">
            Wildcard allowFrom
          </span>
        </div>
      ) : null}

      {hasAccounts ? (
        <div className="ci-account-bar">
          <span className="session-channel-detail-label">
            Accounts: {acct.connected}/{acct.total} connected
          </span>
          <div className="ci-account-track">
            <div
              className="ci-account-fill"
              style={{
                width: `${String(Math.min(100, acct.total > 0 ? (acct.connected / acct.total) * 100 : 0))}%`,
              }}
            />
          </div>
        </div>
      ) : null}

      {guildEntries.length > 0 ? (
        <div className="session-channel-guilds">
          <span className="session-channel-detail-label">
            {guildEntries.length} guild{guildEntries.length !== 1 ? 's' : ''} · {totalGuildChannels}{' '}
            channel{totalGuildChannels !== 1 ? 's' : ''}
          </span>
          {guildEntries.map(([guildId, guild]) => {
            const guildChannels = Object.entries(guild.channels ?? {});
            return (
              <div key={guildId} className="session-guild-row">
                <span className="mono session-guild-id" title={guildId}>
                  Guild {guildId.slice(-6)}
                </span>
                <span className="session-guild-channels">
                  {guildChannels.map(([chId]) => (
                    <span key={chId} className="badge tone-neutral session-guild-ch" title={chId}>
                      #{chId.slice(-4)}
                    </span>
                  ))}
                </span>
                {guild.users && guild.users.length > 0 ? (
                  <span className="session-guild-users">
                    {guild.users.length} user{guild.users.length !== 1 ? 's' : ''}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : null}

      {ch.boundAgents.length > 0 ? (
        <div className="session-channel-agents">
          <span className="session-channel-detail-label">Bound agents:</span>
          {ch.boundAgents.map((a) => (
            <span key={typeof a === 'string' ? a : a} className="badge tone-accent">
              {a}
            </span>
          ))}
        </div>
      ) : null}

      {recommendation ? (
        <div className="ci-recommendation">
          <span className="ci-recommendation-icon">{priority === 'high' ? '!' : 'i'}</span>
          <span>{recommendation}</span>
        </div>
      ) : null}
    </div>
  );
}

const KNOWN_ORIGINS = ['whatsapp', 'telegram', 'slack', 'discord', 'line', 'cron'] as const;

function channelMatchesOrigin(channelId: string, origin: OriginFilter): boolean {
  if (origin === 'all') return true;
  if (origin === 'other')
    return !KNOWN_ORIGINS.includes(channelId as (typeof KNOWN_ORIGINS)[number]);
  return channelId === origin;
}

export function SessionsView(props: SessionsViewProps): JSX.Element {
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all');
  const allSessions = props.snapshot?.sessions ?? [];
  const runs = props.snapshot?.runs ?? [];

  const [jobs, setJobs] = useState<readonly OpenClawJob[]>([]);
  const [channels, setChannels] = useState<readonly OpenClawChannel[]>([]);
  const [rawChannels, setRawChannels] = useState<Record<string, RawChannelConfig>>({});
  const fetchVersionRef = useRef(0);

  const fetchOpenClawData = useCallback(async () => {
    if (!props.baseUrl || !props.selectedTargetId) {
      setJobs([]);
      setChannels([]);
      setRawChannels({});
      return;
    }
    const version = ++fetchVersionRef.current;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (props.token) headers['Authorization'] = `Bearer ${props.token}`;
    const targetId = encodeURIComponent(props.selectedTargetId);

    const [jobsRes, channelsRes, configRes] = await Promise.all([
      cachedFetch(`${props.baseUrl}/openclaw/targets/${targetId}/jobs`, {
        headers,
        signal: AbortSignal.timeout(8000),
        ttlMs: 15_000,
      }).catch(() => null),
      cachedFetch(`${props.baseUrl}/openclaw/channels?targetId=${targetId}`, {
        headers,
        signal: AbortSignal.timeout(8000),
        ttlMs: 10_000,
      }).catch(() => null),
      cachedFetch(`${props.baseUrl}/openclaw/targets/${targetId}/config`, {
        headers,
        signal: AbortSignal.timeout(8000),
      }).catch(() => null),
    ]);

    if (version !== fetchVersionRef.current) return;

    if (jobsRes?.ok) {
      const data = (await jobsRes.json()) as { jobs?: OpenClawJob[] };
      if (version === fetchVersionRef.current) setJobs(data.jobs ?? []);
    }
    if (channelsRes?.ok) {
      const data = (await channelsRes.json()) as { channels?: OpenClawChannel[] };
      if (version === fetchVersionRef.current) setChannels(data.channels ?? []);
    }
    if (configRes?.ok) {
      const data = (await configRes.json()) as {
        config?: { raw?: { channels?: Record<string, RawChannelConfig> } };
      };
      if (version === fetchVersionRef.current) {
        setRawChannels(data.config?.raw?.channels ?? {});
      }
    }
  }, [props.baseUrl, props.token, props.selectedTargetId]);

  useEffect(() => {
    void fetchOpenClawData();
    const interval = setInterval(() => void fetchOpenClawData(), 30_000);
    return () => clearInterval(interval);
  }, [fetchOpenClawData]);

  const enabledChannels = useMemo(() => {
    const apiEnabled = channels.filter((ch) => ch.configured);
    const rawEnabled = Object.entries(rawChannels)
      .filter(([, v]) => v.enabled)
      .map(([k]) => k);
    const apiIds = new Set(apiEnabled.map((ch) => ch.id));
    const extra: OpenClawChannel[] = rawEnabled
      .filter((id) => !apiIds.has(id))
      .map((id) => ({
        id,
        name: id.charAt(0).toUpperCase() + id.slice(1),
        configured: true,
        connected: false,
        runtimeState: 'unknown',
        dmPolicy: rawChannels[id]?.dmPolicy ?? 'unknown',
        groupPolicy: rawChannels[id]?.groupPolicy ?? 'unknown',
        boundAgents: [],
        hasGroups: false,
        allowFromCount: 0,
        allowFromHasWildcard: false,
        accountSummary: { total: 0, enabled: 0, configured: 0, connected: 0, runtimeKnown: 0 },
      }));
    return [...apiEnabled, ...extra];
  }, [channels, rawChannels]);

  const routeFiltered = useMemo(() => {
    const rf = props.filter;
    return allSessions.filter((s) => {
      if (rf.machineId && s.machineId !== rf.machineId) return false;
      if (rf.agentId && s.agentId !== rf.agentId) return false;
      if (rf.sessionId && s.sessionId !== rf.sessionId) return false;
      return true;
    });
  }, [allSessions, props.filter]);

  const runCountBySession = new Map<string, number>();
  for (const run of runs) {
    runCountBySession.set(run.sessionId, (runCountBySession.get(run.sessionId) ?? 0) + 1);
  }

  const hasSessions = routeFiltered.length > 0;
  const activeCount = routeFiltered.filter((s) => ACTIVE_STATES.has(s.state)).length;
  const completedCount = routeFiltered.filter((s) => TERMINAL_OK.has(s.state)).length;
  const failedCount = routeFiltered.filter((s) => TERMINAL_BAD.has(s.state)).length;

  const tabs: ReadonlyArray<FilterTab<SessionFilter>> = [
    { id: 'all', label: 'All', count: routeFiltered.length },
    { id: 'active', label: 'Active', count: activeCount },
    { id: 'completed', label: 'Completed', count: completedCount },
    { id: 'failed', label: 'Failed', count: failedCount },
  ];

  const originTabs: ReadonlyArray<FilterTab<OriginFilter>> = useMemo(() => {
    const sessionCountFor = (origin: string) =>
      routeFiltered.filter((s) => parseSessionOrigin(s.sessionId).channel === origin).length;
    const channelCountFor = (origin: string) =>
      enabledChannels.filter((ch) => channelMatchesOrigin(ch.id, origin as OriginFilter)).length;

    const totalChannels = enabledChannels.length;
    const totalSessions = routeFiltered.length;

    return [
      { id: 'all' as const, label: 'All', count: totalSessions + totalChannels },
      {
        id: 'telegram' as const,
        label: 'Telegram',
        count: sessionCountFor('telegram') + channelCountFor('telegram'),
      },
      {
        id: 'discord' as const,
        label: 'Discord',
        count: sessionCountFor('discord') + channelCountFor('discord'),
      },
      {
        id: 'whatsapp' as const,
        label: 'WhatsApp',
        count: sessionCountFor('whatsapp') + channelCountFor('whatsapp'),
      },
      {
        id: 'slack' as const,
        label: 'Slack',
        count: sessionCountFor('slack') + channelCountFor('slack'),
      },
      {
        id: 'line' as const,
        label: 'LINE',
        count: sessionCountFor('line') + channelCountFor('line'),
      },
      { id: 'cron' as const, label: 'Cron', count: sessionCountFor('cron') },
      {
        id: 'other' as const,
        label: 'Other',
        count:
          routeFiltered.filter((s) => {
            const c = parseSessionOrigin(s.sessionId).channel;
            return !KNOWN_ORIGINS.includes(c as (typeof KNOWN_ORIGINS)[number]);
          }).length +
          enabledChannels.filter(
            (ch) => !KNOWN_ORIGINS.includes(ch.id as (typeof KNOWN_ORIGINS)[number])
          ).length,
      },
    ];
  }, [routeFiltered, enabledChannels]);

  const filtered = routeFiltered.filter((s) => {
    const origin = parseSessionOrigin(s.sessionId).channel;
    const originMatch =
      originFilter === 'all' ||
      origin === originFilter ||
      (originFilter === 'other' &&
        !KNOWN_ORIGINS.includes(origin as (typeof KNOWN_ORIGINS)[number]));
    if (!originMatch) return false;
    switch (filter) {
      case 'active':
        return ACTIVE_STATES.has(s.state);
      case 'completed':
        return TERMINAL_OK.has(s.state);
      case 'failed':
        return TERMINAL_BAD.has(s.state);
      case 'all':
        return true;
      default:
        return true;
    }
  });

  const filteredChannels = useMemo(
    () => enabledChannels.filter((ch) => channelMatchesOrigin(ch.id, originFilter)),
    [enabledChannels, originFilter]
  );

  const filteredJobs = useMemo(() => {
    if (originFilter === 'all' || originFilter === 'cron') return jobs;
    return [];
  }, [jobs, originFilter]);

  const hasOpenClawData = filteredChannels.length > 0 || filteredJobs.length > 0;

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Sessions</h2>
        {hasSessions ? <FilterTabs tabs={tabs} active={filter} onChange={setFilter} /> : null}
      </div>
      <div style={{ marginBottom: 10 }}>
        <FilterTabs tabs={originTabs} active={originFilter} onChange={setOriginFilter} />
      </div>

      <SessionAnalysisPanel snapshot={props.snapshot} />

      {/* Live telemetry sessions */}
      {filtered.length > 0 ? (
        <div className="panel">
          <div className="table-scroll">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Machine</th>
                  <th>State</th>
                  <th>Runs</th>
                  <th>Duration</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((session) => {
                  const isActive = ACTIVE_STATES.has(session.state);
                  const runCount = runCountBySession.get(session.sessionId) ?? 0;
                  return (
                    <tr
                      key={session.sessionId}
                      data-active={isActive ? 'true' : undefined}
                      className="clickable-row"
                      onClick={() => {
                        navigate('runs', { sessionId: session.sessionId });
                      }}
                    >
                      <td className="mono" title={session.sessionId}>
                        <span className="session-label">
                          {sessionLabel(session.agentId, session.sessionId)}
                        </span>
                        <span className="badge tone-neutral" style={{ marginLeft: 8 }}>
                          {parseSessionOrigin(session.sessionId).icon}
                        </span>
                      </td>
                      <td className="mono">{session.machineId}</td>
                      <td>
                        <StateBadge value={session.state} />
                        {isActive ? (
                          <span className="inline-loading">
                            <span className="mini-spinner" />
                          </span>
                        ) : null}
                      </td>
                      <td className={runCount > 0 ? 'metric-active' : ''}>{runCount}</td>
                      <td className="mono">
                        {isActive ? (
                          <LiveDuration startIso={session.createdAt} />
                        ) : (
                          formatDuration(session.createdAt, session.endedAt ?? session.updatedAt)
                        )}
                      </td>
                      <td>{formatRelativeTime(session.updatedAt)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {filtered.length === 0 && !hasOpenClawData ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <IconClipboard width={28} height={28} />
          </div>
          <p style={{ margin: '4px 0 0' }}>
            {originFilter === 'all'
              ? 'No sessions recorded yet.'
              : `No ${originFilter} data found.`}
          </p>
          <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
            {originFilter === 'all'
              ? 'Sessions are created when agents start working. They will appear here once telemetry data flows in.'
              : 'Try selecting "All" to see everything.'}
          </p>
        </div>
      ) : null}

      {/* Connected Channels */}
      {filteredChannels.length > 0 ? (
        <div style={{ marginTop: 16 }}>
          <div className="panel-header">
            <h3 className="panel-title">
              <IconActivity
                width={14}
                height={14}
                style={{ marginRight: 6, verticalAlign: 'middle' }}
              />
              Connected Channels
              <span className="badge tone-accent" style={{ marginLeft: 8 }}>
                {filteredChannels.length}
              </span>
            </h3>
          </div>
          <div className="session-channels-grid">
            {filteredChannels.map((ch) => (
              <ChannelCard key={ch.id} channel={ch} rawConfig={rawChannels[ch.id] ?? null} />
            ))}
          </div>
        </div>
      ) : null}

      {/* Scheduled Jobs */}
      {filteredJobs.length > 0 ? (
        <div className="panel" style={{ marginTop: 16 }}>
          <div className="panel-header">
            <h3 className="panel-title">
              <IconClock
                width={14}
                height={14}
                style={{ marginRight: 6, verticalAlign: 'middle' }}
              />
              Scheduled Jobs
              <span className="badge tone-accent" style={{ marginLeft: 8 }}>
                {filteredJobs.length}
              </span>
            </h3>
          </div>
          <div className="table-scroll">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Agent</th>
                  <th>Schedule</th>
                  <th>Timezone</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.map((job) => (
                  <tr key={job.jobId}>
                    <td>{job.name}</td>
                    <td className="mono">{job.execution.style}</td>
                    <td className="mono">{job.schedule.expr}</td>
                    <td>{job.schedule.tz ?? '—'}</td>
                    <td>
                      <span className="badge tone-neutral">{job.payload.kind}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}
    </section>
  );
}
