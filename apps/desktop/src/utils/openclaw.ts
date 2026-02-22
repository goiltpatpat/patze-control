export type OpenClawChannelId =
  | 'whatsapp'
  | 'telegram'
  | 'slack'
  | 'discord'
  | 'signal'
  | 'imessage'
  | 'teams'
  | 'cron'
  | 'main'
  | 'other';

export interface SessionOriginInfo {
  readonly channel: OpenClawChannelId;
  readonly label: string;
  readonly icon: string;
}

const CHANNEL_META: Readonly<Record<OpenClawChannelId, { label: string; icon: string }>> = {
  whatsapp: { label: 'WhatsApp', icon: 'WA' },
  telegram: { label: 'Telegram', icon: 'TG' },
  slack: { label: 'Slack', icon: 'SL' },
  discord: { label: 'Discord', icon: 'DS' },
  signal: { label: 'Signal', icon: 'SG' },
  imessage: { label: 'iMessage', icon: 'IM' },
  teams: { label: 'Teams', icon: 'TM' },
  cron: { label: 'Cron', icon: 'CR' },
  main: { label: 'Main', icon: 'MN' },
  other: { label: 'Other', icon: 'OT' },
};

export function getOpenClawChannelMeta(channel: OpenClawChannelId): SessionOriginInfo {
  const meta = CHANNEL_META[channel];
  return { channel, label: meta.label, icon: meta.icon };
}

export function parseSessionOrigin(sessionKey: string): SessionOriginInfo {
  const key = sessionKey.trim().toLowerCase();
  if (!key) return getOpenClawChannelMeta('other');

  if (key === 'main' || key.startsWith('main:')) return getOpenClawChannelMeta('main');
  if (key.startsWith('whatsapp:') || key.startsWith('wa:'))
    return getOpenClawChannelMeta('whatsapp');
  if (key.startsWith('telegram:') || key.startsWith('tg:'))
    return getOpenClawChannelMeta('telegram');
  if (key.startsWith('slack:')) return getOpenClawChannelMeta('slack');
  if (key.startsWith('discord:')) return getOpenClawChannelMeta('discord');
  if (key.startsWith('signal:')) return getOpenClawChannelMeta('signal');
  if (key.startsWith('imessage:') || key.startsWith('iosmsg:'))
    return getOpenClawChannelMeta('imessage');
  if (key.startsWith('teams:')) return getOpenClawChannelMeta('teams');
  if (key.startsWith('cron:')) return getOpenClawChannelMeta('cron');

  const prefix = key.split(':')[0] ?? '';
  if (prefix in CHANNEL_META) {
    return getOpenClawChannelMeta(prefix as OpenClawChannelId);
  }

  return getOpenClawChannelMeta('other');
}

export function formatPollInterval(intervalMs: number): string {
  if (intervalMs < 1_000) return `${intervalMs}ms`;
  if (intervalMs < 60_000) return `${Math.round(intervalMs / 1_000)}s`;
  if (intervalMs < 3_600_000) return `${Math.round(intervalMs / 60_000)}m`;
  return `${(intervalMs / 3_600_000).toFixed(1)}h`;
}
