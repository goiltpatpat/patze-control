import { Fragment, useMemo, useState } from 'react';
import { FilterTabs, type FilterTab } from '../components/FilterTabs';
import { IconActivity } from '../components/Icons';
import { LiveDuration } from '../components/LiveDuration';
import { RunDetail } from '../components/RunDetail';
import { StateBadge } from '../components/badges/StateBadge';
import type { RouteFilter } from '../shell/routes';
import type { FrontendUnifiedSnapshot } from '../types';
import { ACTIVE_STATES, TERMINAL_BAD, TERMINAL_OK } from '../utils/lifecycle';
import { formatDuration, formatRelativeTime } from '../utils/time';

export interface RunsViewProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly filter: RouteFilter;
}

type RunFilter = 'all' | 'active' | 'completed' | 'failed';

export function RunsView(props: RunsViewProps): JSX.Element {
  const [filter, setFilter] = useState<RunFilter>('all');
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const allRuns = props.snapshot?.runs ?? [];
  const runDetails = props.snapshot?.runDetails ?? {};
  const machineCount = props.snapshot?.machines.length ?? 0;

  const routeFiltered = useMemo(() => {
    const rf = props.filter;
    return allRuns.filter((r) => {
      if (rf.sessionId && r.sessionId !== rf.sessionId) return false;
      if (rf.agentId && r.agentId !== rf.agentId) return false;
      if (rf.machineId && r.machineId !== rf.machineId) return false;
      return true;
    });
  }, [allRuns, props.filter]);

  const activeCount = routeFiltered.filter((r) => ACTIVE_STATES.has(r.state)).length;
  const completedCount = routeFiltered.filter((r) => TERMINAL_OK.has(r.state)).length;
  const failedCount = routeFiltered.filter((r) => TERMINAL_BAD.has(r.state)).length;

  const tabs: ReadonlyArray<FilterTab<RunFilter>> = [
    { id: 'all', label: 'All', count: routeFiltered.length },
    { id: 'active', label: 'Active', count: activeCount },
    { id: 'completed', label: 'Completed', count: completedCount },
    { id: 'failed', label: 'Failed', count: failedCount },
  ];

  const filtered = routeFiltered.filter((r) => {
    switch (filter) {
      case 'active':
        return ACTIVE_STATES.has(r.state);
      case 'completed':
        return TERMINAL_OK.has(r.state);
      case 'failed':
        return TERMINAL_BAD.has(r.state);
      case 'all':
        return true;
      default:
        return true;
    }
  });

  const toggleExpand = (runId: string): void => {
    setExpandedRunId((prev) => (prev === runId ? null : runId));
  };

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Runs</h2>
        <FilterTabs tabs={tabs} active={filter} onChange={setFilter} />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <IconActivity width={28} height={28} />
          </div>
          {routeFiltered.length === 0 && allRuns.length === 0 ? (
            <>
              <p style={{ margin: '4px 0 0' }}>No runs recorded yet.</p>
              <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '6px 0 0' }}>
                Runs represent individual agent executions. They will appear here as agents complete
                work.
              </p>
              {machineCount > 0 ? (
                <p style={{ fontSize: '0.74rem', color: 'var(--text-dim)', margin: '6px 0 0' }}>
                  {`Machines connected: ${String(machineCount)}. Waiting for telemetry events of type run.state.changed.`}
                </p>
              ) : null}
              <p style={{ fontSize: '0.72rem', color: 'var(--text-dim)', margin: '6px 0 0' }}>
                OpenClaw cron run history is shown in Tasks view (OpenClaw Jobs panel), not in this
                telemetry run timeline.
              </p>
            </>
          ) : props.filter.sessionId ? (
            `No runs found for session ${props.filter.sessionId}.`
          ) : props.filter.agentId ? (
            `No runs found for agent ${props.filter.agentId}.`
          ) : props.filter.machineId ? (
            `No runs found for machine ${props.filter.machineId}.`
          ) : (
            'No runs match the current filter.'
          )}
        </div>
      ) : (
        <div className="panel">
          <div className="table-scroll" style={{ maxHeight: expandedRunId ? 'none' : undefined }}>
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Run ID</th>
                  <th>Agent</th>
                  <th>Machine</th>
                  <th>State</th>
                  <th>Duration</th>
                  <th>Updated</th>
                  <th>Failure</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((run) => {
                  const isActive = ACTIVE_STATES.has(run.state);
                  const isExpanded = expandedRunId === run.runId;
                  const detail = runDetails[run.runId];
                  return (
                    <Fragment key={run.runId}>
                      <tr
                        data-active={isActive ? 'true' : undefined}
                        style={{ cursor: 'pointer' }}
                        onClick={() => {
                          toggleExpand(run.runId);
                        }}
                      >
                        <td className="mono">{run.runId}</td>
                        <td className="mono">{run.agentId}</td>
                        <td className="mono">{run.machineId}</td>
                        <td>
                          <StateBadge value={run.state} />
                          {isActive ? (
                            <span className="inline-loading">
                              <span className="mini-spinner" />
                            </span>
                          ) : null}
                        </td>
                        <td className="mono">
                          {isActive ? (
                            <LiveDuration startIso={run.createdAt} />
                          ) : (
                            formatDuration(run.createdAt, run.endedAt ?? run.updatedAt)
                          )}
                        </td>
                        <td>{formatRelativeTime(run.updatedAt)}</td>
                        <td>
                          {run.failureReason ? (
                            <span className="error" title={run.failureReason}>
                              {run.failureReason.length > 40
                                ? `${run.failureReason.slice(0, 40)}…`
                                : run.failureReason}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                      </tr>
                      {isExpanded && detail ? (
                        <tr key={`${run.runId}-detail`}>
                          <td colSpan={7} style={{ padding: 0 }}>
                            <RunDetail detail={detail} />
                          </td>
                        </tr>
                      ) : null}
                    </Fragment>
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
