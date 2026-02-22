import { useMemo, useState } from 'react';
import { FilterTabs, type FilterTab } from '../components/FilterTabs';
import { IconClipboard } from '../components/Icons';
import { LiveDuration } from '../components/LiveDuration';
import { StateBadge } from '../components/badges/StateBadge';
import { navigate, type RouteFilter } from '../shell/routes';
import type { FrontendUnifiedSnapshot } from '../types';
import { parseSessionOrigin } from '../utils/openclaw';
import { ACTIVE_STATES, TERMINAL_BAD, TERMINAL_OK } from '../utils/lifecycle';
import { formatDuration, formatRelativeTime } from '../utils/time';

export interface SessionsViewProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly filter: RouteFilter;
}

type SessionFilter = 'all' | 'active' | 'completed' | 'failed';
type OriginFilter = 'all' | 'whatsapp' | 'telegram' | 'slack' | 'discord' | 'cron' | 'other';

function shortId(id: string): string {
  if (id.length <= 12) {
    return id;
  }
  return `${id.slice(0, 10)}…`;
}

function sessionLabel(agentId: string, sessionId: string): string {
  const shortAgent = agentId.length > 16 ? `${agentId.slice(0, 14)}…` : agentId;
  return `${shortAgent} / ${shortId(sessionId)}`;
}

export function SessionsView(props: SessionsViewProps): JSX.Element {
  const [filter, setFilter] = useState<SessionFilter>('all');
  const [originFilter, setOriginFilter] = useState<OriginFilter>('all');
  const allSessions = props.snapshot?.sessions ?? [];
  const runs = props.snapshot?.runs ?? [];

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

  const activeCount = routeFiltered.filter((s) => ACTIVE_STATES.has(s.state)).length;
  const completedCount = routeFiltered.filter((s) => TERMINAL_OK.has(s.state)).length;
  const failedCount = routeFiltered.filter((s) => TERMINAL_BAD.has(s.state)).length;

  const tabs: ReadonlyArray<FilterTab<SessionFilter>> = [
    { id: 'all', label: 'All', count: routeFiltered.length },
    { id: 'active', label: 'Active', count: activeCount },
    { id: 'completed', label: 'Completed', count: completedCount },
    { id: 'failed', label: 'Failed', count: failedCount },
  ];

  const originTabs: ReadonlyArray<FilterTab<OriginFilter>> = [
    { id: 'all', label: 'All', count: routeFiltered.length },
    {
      id: 'whatsapp',
      label: 'WhatsApp',
      count: routeFiltered.filter((s) => parseSessionOrigin(s.sessionId).channel === 'whatsapp')
        .length,
    },
    {
      id: 'telegram',
      label: 'Telegram',
      count: routeFiltered.filter((s) => parseSessionOrigin(s.sessionId).channel === 'telegram')
        .length,
    },
    {
      id: 'slack',
      label: 'Slack',
      count: routeFiltered.filter((s) => parseSessionOrigin(s.sessionId).channel === 'slack')
        .length,
    },
    {
      id: 'discord',
      label: 'Discord',
      count: routeFiltered.filter((s) => parseSessionOrigin(s.sessionId).channel === 'discord')
        .length,
    },
    {
      id: 'cron',
      label: 'Cron',
      count: routeFiltered.filter((s) => parseSessionOrigin(s.sessionId).channel === 'cron').length,
    },
    {
      id: 'other',
      label: 'Other',
      count: routeFiltered.filter((s) => {
        const channel = parseSessionOrigin(s.sessionId).channel;
        return !['whatsapp', 'telegram', 'slack', 'discord', 'cron'].includes(channel);
      }).length,
    },
  ];

  const filtered = routeFiltered.filter((s) => {
    const origin = parseSessionOrigin(s.sessionId).channel;
    const originMatch =
      originFilter === 'all' ||
      origin === originFilter ||
      (originFilter === 'other' &&
        !['whatsapp', 'telegram', 'slack', 'discord', 'cron'].includes(origin));
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

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Sessions</h2>
        <FilterTabs tabs={tabs} active={filter} onChange={setFilter} />
      </div>
      <div style={{ marginBottom: 10 }}>
        <FilterTabs tabs={originTabs} active={originFilter} onChange={setOriginFilter} />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <IconClipboard width={28} height={28} />
          </div>
          {routeFiltered.length === 0 && allSessions.length === 0 ? (
            <>
              <p style={{ margin: '4px 0 0' }}>No sessions recorded yet.</p>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
                Sessions are created when agents start working. They will appear here once telemetry
                data flows in.
              </p>
            </>
          ) : props.filter.machineId ? (
            `No sessions found for machine ${props.filter.machineId}.`
          ) : props.filter.agentId ? (
            `No sessions found for agent ${props.filter.agentId}.`
          ) : (
            'No sessions match the current filter.'
          )}
        </div>
      ) : (
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
      )}
    </section>
  );
}
