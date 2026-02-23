import type { ScheduledTask, TargetSyncStatusEntry, TaskFilter } from './types';

interface TaskStatsBarProps {
  readonly tasks: readonly ScheduledTask[];
  readonly targets: readonly TargetSyncStatusEntry[];
  readonly filter: TaskFilter;
}

export function TaskStatsBar(props: TaskStatsBarProps): JSX.Element {
  const activeCount = props.tasks.filter((t) => t.status === 'enabled').length;
  const errorCount = props.tasks.filter(
    (t) => t.status === 'error' || t.consecutiveErrors > 0
  ).length;
  const totalRuns = props.tasks.reduce((sum, t) => sum + t.totalRuns, 0);
  const healthyTargets = props.targets.filter(
    (e) => e.syncStatus.available && e.syncStatus.consecutiveFailures === 0
  ).length;
  const totalJobs = props.targets.reduce((sum, e) => sum + e.syncStatus.jobsCount, 0);

  if (props.filter === 'openclaw') {
    return (
      <div className="task-stats-bar">
        <div className="task-stat">
          <span className="task-stat-value" data-accent="cyan">
            {props.targets.length}
          </span>
          <span className="task-stat-label">Targets</span>
        </div>
        <div className="task-stat">
          <span className="task-stat-value" data-accent="green">
            {healthyTargets}
          </span>
          <span className="task-stat-label">Healthy</span>
        </div>
        <div className="task-stat">
          <span className="task-stat-value">{totalJobs}</span>
          <span className="task-stat-label">Total Jobs</span>
        </div>
        {props.targets.length - healthyTargets > 0 ? (
          <div className="task-stat">
            <span className="task-stat-value" data-accent="red">
              {props.targets.length - healthyTargets}
            </span>
            <span className="task-stat-label">Issues</span>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="task-stats-bar">
      <div className="task-stat">
        <span className="task-stat-value" data-accent="cyan">
          {props.tasks.length}
        </span>
        <span className="task-stat-label">Total</span>
      </div>
      <div className="task-stat">
        <span className="task-stat-value" data-accent="green">
          {activeCount}
        </span>
        <span className="task-stat-label">Active</span>
      </div>
      <div className="task-stat">
        <span className="task-stat-value">{totalRuns}</span>
        <span className="task-stat-label">Runs</span>
      </div>
      {errorCount > 0 ? (
        <div className="task-stat">
          <span className="task-stat-value" data-accent="red">
            {errorCount}
          </span>
          <span className="task-stat-label">Errors</span>
        </div>
      ) : null}
    </div>
  );
}
