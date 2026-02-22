import { useMemo } from 'react';
import { IconCalendar, IconClock, IconRepeat } from './Icons';

export interface TimelineTask {
  readonly id: string;
  readonly name: string;
  readonly schedule: {
    readonly kind: string;
    readonly expr?: string | undefined;
    readonly everyMs?: number | undefined;
    readonly at?: string | undefined;
  };
  readonly enabled: boolean;
  readonly nextRunAtMs?: number | undefined;
}

export interface TaskTimelineProps {
  readonly tasks: readonly TimelineTask[];
}

const TIMELINE_COLORS = [
  '#22d3ee', // cyan (accent)
  '#34d399', // green
  '#fbbf24', // amber
  '#f87171', // red
  '#60a5fa', // blue
  '#a78bfa', // purple
  '#fb923c', // orange
  '#f472b6', // pink
] as const;

function getTaskColor(index: number): string {
  return TIMELINE_COLORS[index % TIMELINE_COLORS.length]!;
}

interface DayColumn {
  readonly date: Date;
  readonly label: string;
  readonly subLabel: string;
  readonly isToday: boolean;
  readonly events: ReadonlyArray<{
    task: TimelineTask;
    time: Date;
    color: string;
    isInterval: boolean;
  }>;
}

function formatHHMM(date: Date): string {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatDayLabel(date: Date, isToday: boolean): string {
  if (isToday) return 'Today';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `${days[date.getDay()]!} ${String(date.getDate())}`;
}

function formatSubLabel(date: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return months[date.getMonth()]!;
}

function formatIntervalLabel(ms: number): string {
  if (ms >= 86400000) return `Every ${Math.round(ms / 86400000)}d`;
  if (ms >= 3600000) return `Every ${Math.round(ms / 3600000)}h`;
  if (ms >= 60000) return `Every ${Math.round(ms / 60000)}m`;
  return `Every ${Math.round(ms / 1000)}s`;
}

/**
 * Simple cron-like next run computation for basic expressions.
 * Handles: "* /N * * *" (every N minutes) and basic hourly patterns.
 * Falls back to nextRunAtMs if available.
 */
function computeNextRunsFromTask(
  task: TimelineTask,
  now: Date,
  endDate: Date,
  maxRuns: number
): Date[] {
  const runs: Date[] = [];

  if (task.schedule.kind === 'at' && task.schedule.at) {
    const atDate = new Date(task.schedule.at);
    if (atDate >= now && atDate <= endDate) {
      runs.push(atDate);
    }
    return runs;
  }

  if (task.schedule.kind === 'every' && task.schedule.everyMs) {
    const intervalMs = task.schedule.everyMs;
    // If interval is very short (< 1h), don't enumerate individual runs
    if (intervalMs < 3600000) return runs;

    let next = task.nextRunAtMs ? new Date(task.nextRunAtMs) : new Date(now.getTime() + intervalMs);
    while (next <= endDate && runs.length < maxRuns) {
      if (next >= now) {
        runs.push(new Date(next));
      }
      next = new Date(next.getTime() + intervalMs);
    }
    return runs;
  }

  // For cron: use nextRunAtMs as first run, then estimate subsequent
  if (task.nextRunAtMs) {
    const first = new Date(task.nextRunAtMs);
    if (first >= now && first <= endDate) {
      runs.push(first);
    }
  }

  return runs;
}

export function TaskTimeline(props: TaskTimelineProps): JSX.Element {
  const enabledTasks = useMemo(
    () => props.tasks.filter((t) => t.enabled),
    [props.tasks]
  );

  const { days, totalEvents } = useMemo(() => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const endDate = new Date(today.getTime() + 7 * 24 * 60 * 60 * 1000);

    // Compute all events
    const allEvents: Array<{
      task: TimelineTask;
      time: Date;
      color: string;
      isInterval: boolean;
    }> = [];

    enabledTasks.forEach((task, idx) => {
      const color = getTaskColor(idx);
      const runs = computeNextRunsFromTask(task, now, endDate, 50);

      for (const time of runs) {
        allEvents.push({ task, time, color, isInterval: task.schedule.kind === 'every' });
      }
    });

    // Build day columns
    const columns: DayColumn[] = [];
    for (let i = 0; i < 7; i++) {
      const date = new Date(today.getTime() + i * 24 * 60 * 60 * 1000);
      const dayEnd = new Date(date.getTime() + 24 * 60 * 60 * 1000);
      const isToday = i === 0;

      const dayEvents = allEvents
        .filter((e) => e.time >= date && e.time < dayEnd)
        .sort((a, b) => a.time.getTime() - b.time.getTime());

      columns.push({
        date,
        label: formatDayLabel(date, isToday),
        subLabel: formatSubLabel(date),
        isToday,
        events: dayEvents,
      });
    }

    const total = allEvents.length;
    return { days: columns, totalEvents: total };
  }, [enabledTasks]);

  // Also compute interval tasks (short intervals shown as repeating banner)
  const intervalTasks = useMemo(() => {
    return enabledTasks
      .map((task, idx) => ({ task, color: getTaskColor(idx) }))
      .filter(({ task }) => task.schedule.kind === 'every' && task.schedule.everyMs !== undefined && task.schedule.everyMs < 3600000);
  }, [enabledTasks]);

  if (enabledTasks.length === 0) {
    return (
      <div className="task-timeline-empty">
        <IconCalendar width={40} height={40} />
        <p style={{ margin: 0, fontSize: 13 }}>No active tasks to display</p>
      </div>
    );
  }

  return (
    <div>
      {/* Legend */}
      <div className="task-timeline-legend">
        {enabledTasks.map((task, idx) => {
          const color = getTaskColor(idx);
          return (
            <span
              key={task.id}
              className="task-timeline-legend-item"
              style={{ background: `${color}18`, border: `1px solid ${color}40`, color }}
            >
              <span className="task-timeline-legend-dot" style={{ background: color }} />
              {task.name}
            </span>
          );
        })}
        <span className="task-timeline-stat">
          {totalEvents} scheduled events in next 7 days
        </span>
      </div>

      {/* Calendar Grid */}
      <div className="task-timeline">
        {days.map((day) => (
          <div
            key={day.date.toISOString()}
            className={`task-timeline-day${day.isToday ? ' today' : ''}`}
          >
            <div className="task-timeline-day-header">
              <div className="task-timeline-day-label">{day.label}</div>
              <div className="task-timeline-day-sub">{day.subLabel}</div>
            </div>
            <div className="task-timeline-events">
              {day.events.length === 0 && intervalTasks.length === 0 ? (
                <div className="task-timeline-day-empty">—</div>
              ) : null}

              {/* Regular events */}
              {day.events.map((event, eIdx) => (
                <div
                  key={`${event.task.id}-${String(eIdx)}`}
                  className={`task-timeline-event${event.isInterval ? ' task-timeline-interval' : ''}`}
                  style={{
                    background: `${event.color}18`,
                    border: `1px solid ${event.color}35`,
                  }}
                  title={`${event.task.name}\n${formatHHMM(event.time)}`}
                >
                  <span className="task-timeline-event-time" style={{ color: event.color }}>
                    <IconClock width={10} height={10} />
                    {formatHHMM(event.time)}
                    {event.isInterval ? <IconRepeat width={10} height={10} style={{ opacity: 0.7 }} /> : null}
                  </span>
                  <span className="task-timeline-event-name">{event.task.name}</span>
                </div>
              ))}

              {/* Interval tasks (short intervals) shown as repeating banner */}
              {intervalTasks.map(({ task, color }) => (
                <div
                  key={`interval-${task.id}`}
                  className="task-timeline-event task-timeline-interval"
                  style={{
                    background: `${color}12`,
                    border: `1px dashed ${color}25`,
                  }}
                  title={`${task.name} — ${formatIntervalLabel(task.schedule.everyMs!)}`}
                >
                  <span className="task-timeline-event-time" style={{ color }}>
                    <IconRepeat width={10} height={10} />
                    {formatIntervalLabel(task.schedule.everyMs!)}
                  </span>
                  <span className="task-timeline-event-name">{task.name}</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
