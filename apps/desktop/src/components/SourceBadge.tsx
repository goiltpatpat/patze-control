import type { ManagedEndpoint } from '../hooks/useEndpointManager';

export interface SourceBadgeProps {
  readonly machineId: string;
  readonly remoteEndpoints: readonly ManagedEndpoint[];
}

/**
 * Shows whether a machine is local or from a remote endpoint.
 * Currently relies on convention: server includes sourceEndpointId in
 * the machine registration event. Until that is implemented, this falls
 * back to "local" when no remote endpoints are connected.
 */
export function SourceBadge(props: SourceBadgeProps): JSX.Element {
  const connectedRemotes = props.remoteEndpoints.filter(
    (ep) => ep.status === 'connected' && ep.attachmentId
  );

  if (connectedRemotes.length === 0) {
    return <span className="source-badge source-badge-local">local</span>;
  }

  return <span className="source-badge source-badge-local">local</span>;
}
