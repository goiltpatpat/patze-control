import type { MonitorState } from '../control-monitor';
import { HealthBadge } from '../components/badges/HealthBadge';
import { SeverityBadge, type SeverityLevel } from '../components/badges/SeverityBadge';
import type { OpenClawTargetsSummary } from '../hooks/useOpenClawTargets';
import { navigate } from './routes';

export interface StatusStripProps {
  readonly state: MonitorState;
  readonly bridgeCount: number;
  readonly openclawSummary: OpenClawTargetsSummary;
}

function formatLastUpdated(value: string | null): string {
  if (!value) {
    return '—';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) {
    return '—';
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
    case 'error':
      return 'error';
    case 'degraded':
      return 'warn';
    case 'connecting':
    case 'connected':
      return 'info';
    case 'idle':
      return 'debug';
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
  const rawHealth = snapshot?.health.overall ?? 'unknown';
  const overallHealth =
    rawHealth === 'unknown' && props.state.status === 'connected' ? 'healthy' : rawHealth;
  const { overallHealth: openclawHealth, count: openclawTargetCount } = props.openclawSummary;

  return (
    <footer className="status-strip">
      <span className="status-strip-item">
        <span className="status-strip-label">Connection</span>
        <SeverityBadge
          severity={toConnectionSeverity(props.state.status)}
          label={props.state.status}
        />
      </span>
      <span className="status-strip-item">
        <span className="status-strip-label">Health</span>
        <HealthBadge health={overallHealth} />
      </span>
      <span className="status-strip-item">
        <span className="status-strip-label">Active Runs</span>
        <span className={`status-strip-value${activeRunsCount > 0 ? ' metric-active' : ''}`}>
          {activeRunsCount}
        </span>
      </span>
      {props.bridgeCount > 0 ? (
        <span className="status-strip-item">
          <span className="status-strip-label">Bridges</span>
          <span className="status-strip-value metric-active">{props.bridgeCount}</span>
        </span>
      ) : null}
      <button
        className="status-strip-item status-strip-link"
        onClick={() => {
          navigate('tasks', { taskView: 'openclaw' });
        }}
        title="Open OpenClaw tasks"
      >
        <span className="status-strip-label">OpenClaw</span>
        <span
          className={`badge ${openclawHealth === 'healthy' ? 'tone-good' : openclawHealth === 'degraded' ? 'tone-warn' : 'tone-muted'}`}
        >
          {openclawHealth}
        </span>
        {openclawTargetCount > 0 ? (
          <span className="status-strip-value">{openclawTargetCount}</span>
        ) : null}
      </button>
      <span className="status-strip-item">
        <span className="status-strip-label">Updated</span>
        <span className="status-strip-value">{lastUpdated}</span>
      </span>
    </footer>
  );
}
