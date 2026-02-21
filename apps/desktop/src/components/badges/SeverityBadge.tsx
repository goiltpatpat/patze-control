export type SeverityLevel = 'debug' | 'info' | 'warn' | 'error' | 'critical';

export interface SeverityBadgeProps {
  readonly severity: SeverityLevel;
  readonly label?: string;
}

function toTone(severity: SeverityLevel): string {
  switch (severity) {
    case 'debug': return 'muted';
    case 'info': return 'neutral';
    case 'warn': return 'warn';
    case 'error':
    case 'critical': return 'bad';
    default: return 'muted';
  }
}

export function SeverityBadge(props: SeverityBadgeProps): JSX.Element {
  const tone = toTone(props.severity);
  return (
    <span className={`badge tone-${tone}`}>
      <span className="badge-dot" />
      {props.label ?? props.severity}
    </span>
  );
}
