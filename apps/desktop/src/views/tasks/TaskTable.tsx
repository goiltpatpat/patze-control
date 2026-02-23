import { IconClock } from '../../components/Icons';
import { formatRelativeTime } from '../../utils/time';
import type { ScheduledTask } from './types';
import { actionLabel, formatNextRun, formatSchedule, statusTone } from './utils';

interface TaskTableProps {
  readonly tasks: readonly ScheduledTask[];
  readonly runningTaskId: string | null;
  readonly onRunNow: (id: string) => void;
  readonly onToggle: (task: ScheduledTask) => void;
  readonly onDelete: (id: string) => void;
}

export function TaskTable(props: TaskTableProps): JSX.Element {
  if (props.tasks.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">
          <IconClock width={28} height={28} />
        </div>
        <p>No scheduled tasks yet. Click "+ New" to create one.</p>
      </div>
    );
  }

  return (
    <div className="panel" style={{ padding: 0 }}>
      <div className="table-scroll" style={{ maxHeight: 420 }}>
        <table className="data-table compact">
          <thead>
            <tr>
              <th>Name</th>
              <th>Action</th>
              <th>Schedule</th>
              <th>Status</th>
              <th>Next Run</th>
              <th>Last Run</th>
              <th>Runs</th>
              <th style={{ width: 140 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {props.tasks.map((task) => (
              <tr key={task.id}>
                <td>
                  <span className="mono" title={task.id}>
                    {task.name}
                  </span>
                  {task.description ? (
                    <span
                      className="tone-muted"
                      style={{ display: 'block', fontSize: 11, marginTop: 2 }}
                    >
                      {task.description}
                    </span>
                  ) : null}
                </td>
                <td>
                  <span className={`badge tone-neutral`}>{actionLabel(task.action.action)}</span>
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {formatSchedule(task.schedule)}
                </td>
                <td>
                  <span className={`badge ${statusTone(task.status)}`}>{task.status}</span>
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {formatNextRun(task.nextRunAtMs)}
                </td>
                <td>
                  {task.lastRunAt ? (
                    <>
                      <span className={`badge ${statusTone(task.lastRunStatus ?? 'error')}`}>
                        {task.lastRunStatus ?? '?'}
                      </span>
                      <span className="tone-muted" style={{ marginLeft: 6, fontSize: 11 }}>
                        {formatRelativeTime(task.lastRunAt)}
                      </span>
                    </>
                  ) : (
                    <span className="tone-muted">—</span>
                  )}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {task.totalRuns}
                  {task.consecutiveErrors > 0 ? (
                    <span style={{ color: 'var(--red)', marginLeft: 4 }}>
                      ({task.consecutiveErrors}err)
                    </span>
                  ) : null}
                </td>
                <td>
                  <div className="actions">
                    <button
                      className="btn-secondary"
                      disabled={props.runningTaskId === task.id}
                      onClick={() => {
                        props.onRunNow(task.id);
                      }}
                    >
                      {props.runningTaskId === task.id ? <span className="mini-spinner" /> : 'Run'}
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => {
                        props.onToggle(task);
                      }}
                    >
                      {task.status === 'enabled' ? 'Pause' : 'Start'}
                    </button>
                    <button
                      className="btn-danger"
                      onClick={() => {
                        props.onDelete(task.id);
                      }}
                    >
                      Del
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
