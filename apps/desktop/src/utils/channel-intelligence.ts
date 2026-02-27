export type ChannelPriority = 'high' | 'medium' | 'low';

export type DmPolicy = 'pairing' | 'allowlist' | 'open' | 'disabled' | 'unknown';
export type GroupPolicy = 'open' | 'allowlist' | 'disabled' | 'unknown';
export type RuntimeState = 'connected' | 'disconnected' | 'unknown';

export interface ChannelIntelligenceInput {
  readonly configured: boolean;
  readonly connected: boolean;
  readonly dmPolicy: DmPolicy | string;
  readonly groupPolicy: GroupPolicy | string;
  readonly allowFromHasWildcard: boolean;
  readonly runtimeState: RuntimeState | string;
  readonly boundAgents: readonly (string | { readonly agentId: string })[];
  readonly accountSummary: {
    readonly total: number;
    readonly enabled: number;
    readonly configured: number;
    readonly connected: number;
  };
}

export function channelPriority(ch: ChannelIntelligenceInput): ChannelPriority {
  if (!ch.configured) return 'high';
  if (ch.dmPolicy === 'open' && ch.allowFromHasWildcard) return 'high';
  if (ch.dmPolicy === 'disabled') return 'medium';
  if (!ch.connected || ch.runtimeState === 'unknown') return 'medium';
  return 'low';
}

export function channelRecommendation(ch: ChannelIntelligenceInput): string {
  if (!ch.configured) return 'Add channel config in openclaw.json to enable this provider.';
  if (!ch.connected && ch.runtimeState === 'disconnected')
    return 'Check credentials/session and reconnect this provider.';
  if (ch.runtimeState === 'unknown')
    return 'Runtime connectivity unknown. Verify with OpenClaw channels status.';
  if (ch.dmPolicy === 'open' && ch.allowFromHasWildcard)
    return 'DM open with wildcard allowFrom. Consider pairing/allowlist.';
  if (ch.dmPolicy === 'disabled') return 'DM disabled. Enable only if intentional.';
  if (ch.dmPolicy === 'allowlist') return 'Allowlist active. Keep allowFrom updated.';
  return '';
}

export function priorityBadgeTone(p: ChannelPriority): string {
  switch (p) {
    case 'high':
      return 'tone-bad';
    case 'medium':
      return 'tone-warn';
    case 'low':
      return 'tone-good';
  }
}

export function priorityLabel(p: ChannelPriority): string {
  switch (p) {
    case 'high':
      return 'High Risk';
    case 'medium':
      return 'Medium';
    case 'low':
      return 'Healthy';
  }
}

export function runtimeStateDotClass(state: string, configured: boolean): string {
  if (!configured) return 'ci-dot-off';
  switch (state) {
    case 'connected':
      return 'ci-dot-on';
    case 'disconnected':
      return 'ci-dot-bad';
    default:
      return 'ci-dot-warn';
  }
}

export function runtimeStateLabel(state: string, configured: boolean): string {
  if (!configured) return 'Not configured';
  switch (state) {
    case 'connected':
      return 'Connected';
    case 'disconnected':
      return 'Disconnected';
    default:
      return 'Unknown';
  }
}

export function dmBadgeTone(dmPolicy: string): string {
  switch (dmPolicy) {
    case 'pairing':
      return 'tone-good';
    case 'allowlist':
      return 'tone-neutral';
    case 'open':
      return 'tone-warn';
    case 'disabled':
      return 'tone-muted';
    default:
      return 'tone-muted';
  }
}

export const CHANNEL_META: Readonly<
  Record<string, { icon: string; color: string; letter: string; bg: string }>
> = {
  telegram: { icon: '✈️', color: '#2AABEE', letter: 'T', bg: 'rgba(38,165,228,0.15)' },
  discord: { icon: '🎮', color: '#5865F2', letter: 'D', bg: 'rgba(88,101,242,0.15)' },
  whatsapp: { icon: '💬', color: '#25D366', letter: 'W', bg: 'rgba(37,211,102,0.15)' },
  slack: { icon: '🔧', color: '#E01E5A', letter: 'S', bg: 'rgba(224,30,90,0.15)' },
  signal: { icon: '🔒', color: '#3A76F0', letter: 'Si', bg: 'rgba(58,118,240,0.15)' },
  imessage: { icon: '🍎', color: '#34C759', letter: 'iM', bg: 'rgba(52,199,89,0.15)' },
  line: { icon: '💚', color: '#06C755', letter: 'L', bg: 'rgba(6,199,85,0.15)' },
  teams: { icon: '🟣', color: '#6264A7', letter: 'Te', bg: 'rgba(98,100,167,0.15)' },
  matrix: { icon: '🟢', color: '#0DBD8B', letter: 'M', bg: 'rgba(13,189,139,0.15)' },
  irc: { icon: '📟', color: '#8B8B8B', letter: 'IR', bg: 'rgba(139,139,139,0.15)' },
};

export function getChannelMeta(id: string | undefined | null): {
  icon: string;
  color: string;
  letter: string;
  bg: string;
} {
  if (!id) return { icon: '📡', color: '#888', letter: '?', bg: 'var(--bg-elevated)' };
  return (
    CHANNEL_META[id.toLowerCase()] ?? {
      icon: '📡',
      color: '#888',
      letter: id.charAt(0).toUpperCase(),
      bg: 'var(--bg-elevated)',
    }
  );
}
