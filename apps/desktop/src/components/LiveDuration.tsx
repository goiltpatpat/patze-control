import { useElapsedTicker } from '../useElapsedTicker';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

function formatElapsed(diffMs: number): string {
  if (diffMs < 0) {
    return '0s';
  }
  if (diffMs < MINUTE) {
    return `${String(Math.floor(diffMs / SECOND))}s`;
  }
  if (diffMs < HOUR) {
    const mins = Math.floor(diffMs / MINUTE);
    const secs = Math.floor((diffMs % MINUTE) / SECOND);
    return secs > 0 ? `${String(mins)}m ${String(secs)}s` : `${String(mins)}m`;
  }
  const hours = Math.floor(diffMs / HOUR);
  const mins = Math.floor((diffMs % HOUR) / MINUTE);
  return mins > 0 ? `${String(hours)}h ${String(mins)}m` : `${String(hours)}h`;
}

export interface LiveDurationProps {
  readonly startIso: string;
  readonly endIso?: string;
}

export function LiveDuration(props: LiveDurationProps): JSX.Element {
  const now = useElapsedTicker(props.endIso ? 0 : 1000);

  const start = new Date(props.startIso).getTime();
  if (Number.isNaN(start)) {
    return <span className="tone-muted">—</span>;
  }

  const end = props.endIso ? new Date(props.endIso).getTime() : now;
  if (Number.isNaN(end)) {
    return <span className="tone-muted">—</span>;
  }

  const isLive = !props.endIso;

  return (
    <span className={isLive ? 'live-duration' : undefined}>
      {formatElapsed(end - start)}
    </span>
  );
}
