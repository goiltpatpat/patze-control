export function ChannelSkeleton(): JSX.Element {
  return (
    <div className="channel-skeleton" aria-hidden="true">
      <div className="channel-skeleton-head">
        <div className="channel-skeleton-icon skeleton-pulse" />
        <div className="channel-skeleton-text">
          <div className="skeleton-line skeleton-pulse" style={{ width: '60%' }} />
          <div className="skeleton-line skeleton-line-sm skeleton-pulse" style={{ width: '40%' }} />
        </div>
      </div>
    </div>
  );
}

export function ChannelSkeletonGrid(props: { readonly count?: number }): JSX.Element {
  const count = props.count ?? 6;
  return (
    <div className="channels-grid">
      {Array.from({ length: count }, (_, i) => (
        <ChannelSkeleton key={i} />
      ))}
    </div>
  );
}
