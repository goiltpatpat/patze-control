export interface HealthBadgeProps {
  readonly health: string;
}

function toTone(health: string): string {
  switch (health) {
    case 'healthy':
      return 'good';
    case 'degraded':
      return 'warn';
    case 'critical':
      return 'bad';
    case 'unknown':
    case 'not connected':
      return 'muted';
    default:
      return 'neutral';
  }
}

export function HealthBadge(props: HealthBadgeProps): JSX.Element {
  const tone = toTone(props.health);
  return (
    <span className={`badge tone-${tone}`}>
      <span className="badge-dot" />
      {props.health}
    </span>
  );
}
