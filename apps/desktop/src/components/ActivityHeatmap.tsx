import { Fragment, useMemo, useState } from 'react';

export interface HeatmapEvent {
  readonly ts: string;
  readonly type: string;
}

export interface ActivityHeatmapProps {
  readonly events: readonly HeatmapEvent[];
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const HOURS = Array.from({ length: 24 }, (_, i) => i);

function getColor(count: number, max: number): string {
  if (count === 0) return 'var(--bg-elevated)';
  const ratio = count / Math.max(max, 1);
  if (ratio < 0.25) return 'rgba(34, 211, 238, 0.2)';
  if (ratio < 0.5) return 'rgba(34, 211, 238, 0.4)';
  if (ratio < 0.75) return 'rgba(34, 211, 238, 0.65)';
  return 'rgba(34, 211, 238, 0.9)';
}

interface TooltipState {
  readonly day: string;
  readonly hour: number;
  readonly count: number;
  readonly x: number;
  readonly y: number;
}

export function ActivityHeatmap(props: ActivityHeatmapProps): JSX.Element {
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);

  const { grid, maxCount, totalCount } = useMemo(() => {
    // Build 7×24 grid
    const g: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
    let total = 0;

    for (const event of props.events) {
      const date = new Date(event.ts);
      if (Number.isNaN(date.getTime())) continue;
      const dayIndex = date.getDay(); // 0=Sun
      const hour = date.getHours();
      g[dayIndex]![hour]!++;
      total++;
    }

    let max = 0;
    for (const row of g) {
      for (const cell of row) {
        if (cell > max) max = cell;
      }
    }

    return { grid: g, maxCount: max, totalCount: total };
  }, [props.events]);

  if (props.events.length === 0) {
    return (
      <div className="heatmap-panel">
        <div className="heatmap-header">
          <div>
            <h3 className="heatmap-title">Activity Heatmap</h3>
            <p className="heatmap-subtitle">No events recorded yet</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="heatmap-panel">
      <div className="heatmap-header">
        <div>
          <h3 className="heatmap-title">Activity Heatmap</h3>
          <p className="heatmap-subtitle">{totalCount} events · by day and hour</p>
        </div>
      </div>

      <div className="heatmap-container">
        <div className="heatmap-grid">
          {/* Empty top-left corner */}
          <div />
          {/* Hour labels (every 3 hours) */}
          {HOURS.map((hour) => (
            <div key={`h${String(hour)}`} className="heatmap-hour-label">
              {hour % 3 === 0 ? `${String(hour)}` : ''}
            </div>
          ))}

          {/* Day rows */}
          {DAYS.map((day, dayIndex) => (
            <Fragment key={day}>
              <div className="heatmap-day-label">
                {day}
              </div>
              {HOURS.map((hour) => {
                const count = grid[dayIndex]?.[hour] ?? 0;
                return (
                  <div
                    key={`${day}-${String(hour)}`}
                    className="heatmap-cell"
                    style={{ background: getColor(count, maxCount) }}
                    onMouseEnter={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setTooltip({
                        day,
                        hour,
                        count,
                        x: rect.left + rect.width / 2,
                        y: rect.top - 8,
                      });
                    }}
                    onMouseLeave={() => {
                      setTooltip(null);
                    }}
                  />
                );
              })}
            </Fragment>
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="heatmap-legend">
        <span className="heatmap-legend-label">Less</span>
        {[0, 0.25, 0.5, 0.75, 1].map((ratio) => (
          <div
            key={String(ratio)}
            className="heatmap-legend-cell"
            style={{ background: getColor(Math.ceil(ratio * Math.max(maxCount, 1)), maxCount) }}
          />
        ))}
        <span className="heatmap-legend-label">More</span>
      </div>

      {/* Tooltip */}
      {tooltip ? (
        <div className="heatmap-tooltip" style={{ left: tooltip.x, top: tooltip.y }}>
          <strong>{tooltip.count}</strong> events · {tooltip.day}{' '}
          {String(tooltip.hour).padStart(2, '0')}:00
        </div>
      ) : null}
    </div>
  );
}
