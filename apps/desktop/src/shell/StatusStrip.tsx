import type { MonitorState } from '../control-monitor';
import { HealthBadge } from '../components/badges/HealthBadge';
import { SeverityBadge, type SeverityLevel } from '../components/badges/SeverityBadge';

export interface StatusStripProps {
  readonly state: MonitorState;
}

function formatLastUpdated(value: string | null): string {
  if (!value) {
    return '—';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

function toConnectionSeverity(status: MonitorState['status']): SeverityLevel {
  switch (status) {
    case 'error': return 'error';
    case 'degraded': return 'warn';
    case 'connecting':
    case 'connected': return 'info';
    case 'idle': return 'debug';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function StatusStrip(props: StatusStripProps): JSX.Element {
  const snapshot = props.state.snapshot;
  const activeRunsCount = snapshot?.activeRuns.length ?? 0;
  const lastUpdated = formatLastUpdated(snapshot?.lastUpdated ?? null);
  const overallHealth = snapshot?.health.overall ?? 'unknown';

  return (
    <footer className="status-strip">
      <span className="status-strip-item">
        <span className="status-strip-label">Connection</span>
        <SeverityBadge severity={toConnectionSeverity(props.state.status)} label={props.state.status} />
      </span>
      <span className="status-strip-item">
        <span className="status-strip-label">Health</span>
        <HealthBadge health={overallHealth} />
      </span>
      <span className="status-strip-item">
        <span className="status-strip-label">Active Runs</span>
        <span className={`status-strip-value${activeRunsCount > 0 ? ' metric-active' : ''}`}>
          {String(activeRunsCount)}
        </span>
      </span>
      <span className="status-strip-item">
        <span className="status-strip-label">Updated</span>
        <span className="status-strip-value">{lastUpdated}</span>
      </span>
    </footer>
  );
}
