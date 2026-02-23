import type { ManagedEndpoint } from '../hooks/useEndpointManager';

export interface SourceBadgeProps {
  readonly machineId: string;
  readonly remoteEndpoints: readonly ManagedEndpoint[];
}

export function SourceBadge(props: SourceBadgeProps): JSX.Element {
  const connectedRemotes = props.remoteEndpoints.filter(
    (ep) => ep.status === 'connected' && ep.attachmentId
  );

  if (connectedRemotes.length > 0) {
    return <span className="source-badge source-badge-remote">remote</span>;
  }

  return <span className="source-badge source-badge-local">local</span>;
}
