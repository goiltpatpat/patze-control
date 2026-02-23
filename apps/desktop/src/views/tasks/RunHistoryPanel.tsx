import { Fragment, useMemo, useState } from 'react';
import { formatRelativeTime } from '../../utils/time';
import type { ScheduledTask, TaskRunRecord } from './types';
import { formatDurationMs, HISTORY_GROUP_PREVIEW_LIMIT, statusTone } from './utils';

interface RunGroup {
  taskId: string;
  taskName: string;
  latestRun: TaskRunRecord;
  count: number;
  okCount: number;
  errCount: number;
  runs: TaskRunRecord[];
}

interface RunHistoryPanelProps {
  readonly history: readonly TaskRunRecord[];
  readonly tasks: readonly ScheduledTask[];
}

export function RunHistoryPanel(props: RunHistoryPanelProps): JSX.Element {
  const [filterTaskId, setFilterTaskId] = useState<string | null>(null);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  const taskNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of props.tasks) m.set(t.id, t.name);
    return m;
  }, [props.tasks]);

  const groups = useMemo((): RunGroup[] => {
    const map = new Map<string, RunGroup>();
    for (const r of props.history) {
      const existing = map.get(r.taskId);
      if (existing) {
        existing.count++;
        if (r.status === 'ok') existing.okCount++;
        else existing.errCount++;
        existing.runs.push(r);
      } else {
        map.set(r.taskId, {
          taskId: r.taskId,
          taskName: taskNameMap.get(r.taskId) ?? r.taskId,
          latestRun: r,
          count: 1,
          okCount: r.status === 'ok' ? 1 : 0,
          errCount: r.status !== 'ok' ? 1 : 0,
          runs: [r],
        });
      }
    }
    return [...map.values()]
      .map((group) => ({
        ...group,
        runs: [...group.runs].sort(
          (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
        ),
      }))
      .sort(
        (a, b) =>
          new Date(b.latestRun.startedAt).getTime() - new Date(a.latestRun.startedAt).getTime()
      );
  }, [props.history, taskNameMap]);

  const uniqueTaskIds = useMemo(() => {
    const seen = new Set<string>();
    for (const r of props.history) seen.add(r.taskId);
    return [...seen];
  }, [props.history]);

  const filteredHistory = useMemo(() => {
    if (!filterTaskId) return [];
    return props.history
      .filter((r) => r.taskId === filterTaskId)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }, [props.history, filterTaskId]);

  if (filterTaskId) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h3 className="settings-section-title" style={{ margin: 0, border: 0, padding: 0 }}>
            Run History
          </h3>
          <span className="badge tone-neutral">
            {taskNameMap.get(filterTaskId) ?? filterTaskId}
          </span>
          <button
            className="btn-ghost"
            style={{ fontSize: 11 }}
            onClick={() => {
              setFilterTaskId(null);
            }}
          >
            Clear filter
          </button>
        </div>
        <div className="panel" style={{ padding: 0 }}>
          <div className="table-scroll" style={{ maxHeight: 260 }}>
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {filteredHistory.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                      No runs found for this task yet.
                    </td>
                  </tr>
                ) : null}
                {filteredHistory.map((r) => (
                  <tr key={r.runId}>
                    <td>
                      <span className={`badge ${statusTone(r.status)}`}>{r.status}</span>
                    </td>
                    <td style={{ fontSize: 12 }}>{formatRelativeTime(r.startedAt)}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {formatDurationMs(r.durationMs)}
                    </td>
                    <td
                      title={r.error ?? ''}
                      style={{
                        fontSize: 11,
                        maxWidth: 240,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        color: r.error ? 'var(--red)' : undefined,
                      }}
                    >
                      {r.error ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <h3 className="settings-section-title" style={{ margin: 0, border: 0, padding: 0 }}>
          Run History
        </h3>
        {uniqueTaskIds.length > 1 ? (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Click a row to filter</span>
        ) : null}
      </div>
      <div className="panel" style={{ padding: 0 }}>
        <div className="table-scroll" style={{ maxHeight: 260 }}>
          <table className="data-table compact">
            <thead>
              <tr>
                <th>Task</th>
                <th>Last Status</th>
                <th>Last Run</th>
                <th>Runs</th>
                <th>Success Rate</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.taskId}>
                  <tr
                    className="clickable-row"
                    role="button"
                    tabIndex={0}
                    aria-expanded={expandedGroup === g.taskId}
                    onClick={() => {
                      if (g.count <= 1) {
                        setFilterTaskId(g.taskId);
                        return;
                      }
                      setExpandedGroup(expandedGroup === g.taskId ? null : g.taskId);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        if (g.count <= 1) {
                          setFilterTaskId(g.taskId);
                          return;
                        }
                        setExpandedGroup(expandedGroup === g.taskId ? null : g.taskId);
                      }
                    }}
                  >
                    <td>
                      {g.count > 1 ? (
                        <span style={{ marginRight: 4, fontSize: 10, color: 'var(--text-dim)' }}>
                          {expandedGroup === g.taskId ? '▾' : '▸'}
                        </span>
                      ) : null}
                      <span className="mono" style={{ fontSize: 12 }}>
                        {g.taskName}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${statusTone(g.latestRun.status)}`}>
                        {g.latestRun.status}
                      </span>
                    </td>
                    <td style={{ fontSize: 12 }}>{formatRelativeTime(g.latestRun.startedAt)}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {g.count}
                    </td>
                    <td>
                      {g.count > 0 ? (
                        <span style={{ fontSize: 12 }} title={`${g.okCount}/${g.count} successful`}>
                          <span style={{ color: 'var(--green)' }}>
                            {Math.round((g.okCount / g.count) * 100)}%
                          </span>
                          {g.errCount > 0 ? (
                            <span style={{ color: 'var(--red)', marginLeft: 4 }}>
                              / {g.errCount} err
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                  {expandedGroup === g.taskId ? (
                    <tr>
                      <td colSpan={5} style={{ padding: 0, background: 'var(--bg-elevated)' }}>
                        <div style={{ padding: '4px 0' }}>
                          <table
                            className="data-table compact"
                            style={{ margin: 0, background: 'transparent' }}
                          >
                            <tbody>
                              {g.runs.slice(0, HISTORY_GROUP_PREVIEW_LIMIT).map((r) => (
                                <tr key={r.runId}>
                                  <td style={{ paddingLeft: 28, fontSize: 12, width: '30%' }}>
                                    <span className={`badge ${statusTone(r.status)}`}>
                                      {r.status}
                                    </span>
                                  </td>
                                  <td style={{ fontSize: 12 }}>
                                    {formatRelativeTime(r.startedAt)}
                                  </td>
                                  <td className="mono" style={{ fontSize: 12 }}>
                                    {formatDurationMs(r.durationMs)}
                                  </td>
                                  <td
                                    title={r.error ?? ''}
                                    style={{
                                      fontSize: 11,
                                      color: r.error ? 'var(--red)' : 'var(--text-dim)',
                                    }}
                                  >
                                    {r.error ?? '—'}
                                  </td>
                                </tr>
                              ))}
                              {g.runs.length > HISTORY_GROUP_PREVIEW_LIMIT ? (
                                <tr>
                                  <td
                                    colSpan={4}
                                    style={{
                                      paddingLeft: 28,
                                      fontSize: 11,
                                      color: 'var(--text-dim)',
                                    }}
                                  >
                                    <button
                                      className="btn-ghost"
                                      style={{ fontSize: 11, height: 24 }}
                                      onClick={() => {
                                        setFilterTaskId(g.taskId);
                                      }}
                                    >
                                      View all {g.runs.length} runs
                                    </button>
                                  </td>
                                </tr>
                              ) : null}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
