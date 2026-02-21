import type { ManagedEndpoint } from '../hooks/useEndpointManager';

export interface SourceBadgeProps {
  readonly machineId: string;
  readonly remoteEndpoints: readonly ManagedEndpoint[];
}

export function SourceBadge(props: SourceBadgeProps): JSX.Element {
  const match = props.remoteEndpoints.find(
    (ep) => ep.status === 'connected' && ep.attachmentId,
  );

  if (!match) {
    return <span className="source-badge source-badge-local">local</span>;
  }

  return (
    <span className="source-badge source-badge-remote" title={`Remote: ${match.label}`}>
      {match.label}
    </span>
  );
}
