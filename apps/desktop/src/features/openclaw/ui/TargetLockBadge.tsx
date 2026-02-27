interface TargetLockBadgeProps {
  readonly targetId: string | null;
}

export function TargetLockBadge(props: TargetLockBadgeProps): JSX.Element {
  if (!props.targetId) {
    return <span className="badge tone-muted">target: auto</span>;
  }
  return (
    <span className="badge tone-neutral" title={props.targetId}>
      target: {props.targetId}
    </span>
  );
}
