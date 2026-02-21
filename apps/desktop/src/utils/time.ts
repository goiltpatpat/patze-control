const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export function formatRelativeTime(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  if (Number.isNaN(date.getTime())) {
    return isoTimestamp;
  }

  const diff = Date.now() - date.getTime();
  if (diff < 0) {
    return 'just now';
  }

  if (diff < MINUTE) {
    return 'just now';
  }
  if (diff < HOUR) {
    const mins = Math.floor(diff / MINUTE);
    return `${String(mins)}m ago`;
  }
  if (diff < DAY) {
    const hours = Math.floor(diff / HOUR);
    return `${String(hours)}h ago`;
  }
  const days = Math.floor(diff / DAY);
  return `${String(days)}d ago`;
}

export function formatDuration(startIso: string, endIso?: string): string {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) {
    return '—';
  }

  const end = endIso ? new Date(endIso) : new Date();
  if (Number.isNaN(end.getTime())) {
    return '—';
  }

  const diff = end.getTime() - start.getTime();
  if (diff < 0) {
    return '0s';
  }

  if (diff < MINUTE) {
    return `${String(Math.floor(diff / SECOND))}s`;
  }
  if (diff < HOUR) {
    const mins = Math.floor(diff / MINUTE);
    const secs = Math.floor((diff % MINUTE) / SECOND);
    return secs > 0 ? `${String(mins)}m ${String(secs)}s` : `${String(mins)}m`;
  }
  if (diff < DAY) {
    const hours = Math.floor(diff / HOUR);
    const mins = Math.floor((diff % HOUR) / MINUTE);
    return mins > 0 ? `${String(hours)}h ${String(mins)}m` : `${String(hours)}h`;
  }
  const days = Math.floor(diff / DAY);
  const hours = Math.floor((diff % DAY) / HOUR);
  return hours > 0 ? `${String(days)}d ${String(hours)}h` : `${String(days)}d`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${String(bytes)} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
