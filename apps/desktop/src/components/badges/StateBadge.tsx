export interface StateBadgeProps {
  readonly value: string;
}

function toTone(value: string): string {
  switch (value) {
    case 'running':
    case 'streaming':
    case 'online':
    case 'connected':
      return 'good';
    case 'queued':
    case 'waiting_tool':
    case 'created':
    case 'connecting':
    case 'degraded':
      return 'warn';
    case 'failed':
    case 'cancelled':
    case 'offline':
    case 'error':
      return 'bad';
    case 'completed':
      return 'muted';
    default:
      return 'neutral';
  }
}

export function StateBadge(props: StateBadgeProps): JSX.Element {
  const tone = toTone(props.value);
  return (
    <span className={`badge tone-${tone}`}>
      <span className="badge-dot" />
      {props.value}
    </span>
  );
}
