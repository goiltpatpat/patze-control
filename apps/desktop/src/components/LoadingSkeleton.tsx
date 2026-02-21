export type SkeletonVariant = 'lines' | 'cards';

interface LoadingSkeletonProps {
  readonly variant?: SkeletonVariant;
  readonly count?: number;
}

export function LoadingSkeleton(props: LoadingSkeletonProps): JSX.Element {
  const variant = props.variant ?? 'lines';
  const count = props.count ?? 5;
  const items = Array.from({ length: count }, (_, i) => i);

  return (
    <div className="skeleton-container">
      {items.map((i) => (
        <div key={i} className={variant === 'cards' ? 'skeleton-card' : 'skeleton-line'} />
      ))}
    </div>
  );
}
