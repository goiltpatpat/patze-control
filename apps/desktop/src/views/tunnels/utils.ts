import type { ManagedBridgeState } from './types';
import { BRIDGE_STALE_THRESHOLD_MS, BRIDGE_PROGRESS_FLOW } from './types';

export function isBridgeRecent(lastSeenAt?: string): boolean {
  if (!lastSeenAt) return false;
  const ts = new Date(lastSeenAt).getTime();
  return Date.now() - ts < BRIDGE_STALE_THRESHOLD_MS;
}

export function formatBridgeLastSeen(lastSeenAt?: string): string {
  if (!lastSeenAt) return '—';
  const d = new Date(lastSeenAt);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}m ago`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

export function phaseLabel(status: ManagedBridgeState['status']): string {
  switch (status) {
    case 'connecting':
      return 'Connecting…';
    case 'ssh_test':
      return 'SSH Pre-flight…';
    case 'tunnel_open':
      return 'Tunnel Open';
    case 'installing':
      return 'Installing…';
    case 'running':
      return 'Running';
    case 'telemetry_active':
      return 'Telemetry Active';
    case 'error':
      return 'Error';
    case 'disconnected':
      return 'Disconnected';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function phaseTone(status: ManagedBridgeState['status']): string {
  switch (status) {
    case 'telemetry_active':
    case 'running':
      return 'tone-good';
    case 'ssh_test':
    case 'tunnel_open':
      return 'tone-neutral';
    case 'connecting':
    case 'installing':
      return 'tone-neutral';
    case 'error':
      return 'tone-bad';
    case 'disconnected':
      return 'tone-warn';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function isActivePhase(status: ManagedBridgeState['status']): boolean {
  return status === 'connecting' || status === 'ssh_test' || status === 'installing';
}

export function bridgeProgressPercent(status: ManagedBridgeState['status']): number {
  if (status === 'error') return 100;
  if (status === 'disconnected') return 0;
  const idx = BRIDGE_PROGRESS_FLOW.indexOf(status);
  if (idx < 0) return 0;
  return Math.round(((idx + 1) / BRIDGE_PROGRESS_FLOW.length) * 100);
}

export function bridgeErrorHint(error?: string): string | null {
  if (!error) return null;
  const lowered = error.toLowerCase();
  if (lowered.includes('pre-flight')) return 'Check SSH alias/key/path and retry.';
  if (lowered.includes('timed out')) return 'Check firewall, target port, and network stability.';
  if (lowered.includes('cannot read ssh key')) return 'Check key path and file permissions.';
  if (lowered.includes('reverse tunnel'))
    return 'Remote port may already be used by another service.';
  return 'Open Logs for full diagnostics.';
}

export function buildAuthHeaders(token: string): Record<string, string> {
  if (token.length > 0) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}
