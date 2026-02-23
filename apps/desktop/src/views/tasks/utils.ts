import type { TargetSyncStatusEntry } from './types';

export const RECENT_HISTORY_LIMIT = 20;
export const HISTORY_GROUP_PREVIEW_LIMIT = 8;

export function authHeaders(token: string): Record<string, string> {
  if (token.length === 0) return {};
  return { Authorization: `Bearer ${token}` };
}

export function formatSchedule(s: {
  kind: string;
  expr?: string;
  everyMs?: number;
  at?: string;
  tz?: string;
}): string {
  switch (s.kind) {
    case 'at':
      return `Once at ${s.at ?? '—'}`;
    case 'every': {
      const ms = s.everyMs ?? 0;
      if (ms >= 86_400_000) return `Every ${(ms / 86_400_000).toFixed(1)}d`;
      if (ms >= 3_600_000) return `Every ${(ms / 3_600_000).toFixed(1)}h`;
      if (ms >= 60_000) return `Every ${Math.round(ms / 60_000)}m`;
      return `Every ${Math.round(ms / 1000)}s`;
    }
    case 'cron':
      return `${s.expr ?? '—'}${s.tz ? ` (${s.tz})` : ''}`;
    default:
      return s.kind;
  }
}

export function formatNextRun(ms?: number): string {
  if (ms === undefined || ms === null) return '—';
  const diff = ms - Date.now();
  if (diff <= 0) return 'due now';
  if (diff < 60_000) return `${Math.ceil(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.ceil(diff / 60_000)}m`;
  return `${(diff / 3_600_000).toFixed(1)}h`;
}

export function formatDurationMs(ms?: number): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

export function formatCompactMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
  return `${(ms / 3_600_000).toFixed(1)}h`;
}

export function statusTone(status: string): string {
  switch (status) {
    case 'enabled':
    case 'ok':
      return 'tone-good';
    case 'running':
      return 'tone-neutral';
    case 'error':
    case 'timeout':
      return 'tone-bad';
    case 'skipped':
      return 'tone-warn';
    case 'disabled':
      return 'tone-muted';
    default:
      return 'tone-muted';
  }
}

export function actionLabel(action: string): string {
  return action.replace(/_/g, ' ');
}

export function createTimedAbortController(timeoutMs: number): {
  controller: AbortController;
  timeoutId: ReturnType<typeof setTimeout>;
} {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeoutId };
}

export function targetHealthTone(entry: TargetSyncStatusEntry): string {
  if (entry.syncStatus.consecutiveFailures >= 3 || entry.syncStatus.stale) return 'tone-bad';
  if (entry.syncStatus.consecutiveFailures > 0) return 'tone-warn';
  if (!entry.syncStatus.available) return 'tone-muted';
  return 'tone-good';
}

export function targetHealthLabel(entry: TargetSyncStatusEntry): string {
  if (entry.syncStatus.consecutiveFailures >= 3) return 'failing';
  if (entry.syncStatus.stale) return 'stale';
  if (entry.syncStatus.consecutiveFailures > 0) return 'degraded';
  if (!entry.syncStatus.available) return 'standby';
  return 'healthy';
}
