import { useMemo, useState } from 'react';
import { FilterTabs, type FilterTab } from '../components/FilterTabs';
import { IconClipboard } from '../components/Icons';
import { LiveDuration } from '../components/LiveDuration';
import { StateBadge } from '../components/badges/StateBadge';
import { navigate, type RouteFilter } from '../shell/routes';
import type { FrontendUnifiedSnapshot } from '../types';
import { formatDuration, formatRelativeTime } from '../utils/time';

export interface SessionsViewProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly filter: RouteFilter;
}

type SessionFilter = 'all' | 'active' | 'completed' | 'failed';

const ACTIVE_STATES = new Set(['created', 'queued', 'running', 'waiting_tool', 'streaming']);
const TERMINAL_OK = new Set(['completed']);
const TERMINAL_BAD = new Set(['failed', 'cancelled']);

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
  const allSessions = props.snapshot?.sessions ?? [];
  const runs = props.snapshot?.runs ?? [];

  const routeFiltered = useMemo(() => {
    const rf = props.filter;
    return allSessions.filter((s) => {
      if (rf.machineId && s.machineId !== rf.machineId) return false;
      if (rf.agentId && s.agentId !== rf.agentId) return false;
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

  const filtered = routeFiltered.filter((s) => {
    switch (filter) {
      case 'active': return ACTIVE_STATES.has(s.state);
      case 'completed': return TERMINAL_OK.has(s.state);
      case 'failed': return TERMINAL_BAD.has(s.state);
      case 'all': return true;
      default: return true;
    }
  });

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Sessions</h2>
        <FilterTabs tabs={tabs} active={filter} onChange={setFilter} />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><IconClipboard width={28} height={28} /></div>
          {routeFiltered.length === 0 && allSessions.length === 0
            ? 'No sessions recorded yet.'
            : props.filter.machineId
              ? `No sessions found for machine ${props.filter.machineId}.`
              : props.filter.agentId
                ? `No sessions found for agent ${props.filter.agentId}.`
                : 'No sessions match the current filter.'}
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
                      onClick={() => { navigate('runs', { sessionId: session.sessionId }); }}
                    >
                      <td className="mono" title={session.sessionId}>
                        <span className="session-label">{sessionLabel(session.agentId, session.sessionId)}</span>
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
                      <td className={runCount > 0 ? 'metric-active' : ''}>{String(runCount)}</td>
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
