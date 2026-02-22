import type { TaskSchedule } from './types.js';

export function computeNextRunMs(schedule: TaskSchedule, now: number = Date.now()): number | null {
  switch (schedule.kind) {
    case 'at': {
      const target = new Date(schedule.at).getTime();
      return Number.isNaN(target) || target <= now ? null : target;
    }

    case 'every': {
      const anchor = schedule.anchorMs ?? now;
      if (schedule.everyMs <= 0) return null;
      const elapsed = now - anchor;
      const periods = Math.ceil(elapsed / schedule.everyMs);
      const next = anchor + periods * schedule.everyMs;
      return next <= now ? now + schedule.everyMs : next;
    }

    case 'cron': {
      return computeCronNext(schedule.expr, schedule.tz, now);
    }
  }
}

function computeCronNext(expr: string, tz: string | undefined, now: number): number | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length < 5 || parts.length > 6) return null;

  const nowDate = tz ? toTzDate(now, tz) : new Date(now);
  const limit = now + 366 * 24 * 60 * 60 * 1000;

  let candidate = new Date(nowDate.getTime() + 60_000);
  candidate.setSeconds(0, 0);

  for (let i = 0; i < 525_960; i++) {
    if (candidate.getTime() > limit) return null;
    if (matchesCron(parts, candidate)) {
      return tz ? fromTzDate(candidate, tz) : candidate.getTime();
    }
    candidate = new Date(candidate.getTime() + 60_000);
  }

  return null;
}

function matchesCron(parts: string[], date: Date): boolean {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dayOfMonth = date.getDate();
  const month = date.getMonth() + 1;
  const dayOfWeek = date.getDay();

  return (
    matchField(parts[0]!, minute, 0, 59) &&
    matchField(parts[1]!, hour, 0, 23) &&
    matchField(parts[2]!, dayOfMonth, 1, 31) &&
    matchField(parts[3]!, month, 1, 12) &&
    matchField(parts[4]!, dayOfWeek, 0, 7)
  );
}

function matchField(field: string, value: number, min: number, max: number): boolean {
  if (field === '*') return true;

  for (const part of field.split(',')) {
    const stepSplit = part.split('/');
    const rangePart = stepSplit[0]!;
    const step = stepSplit[1] ? parseInt(stepSplit[1], 10) : 1;

    if (rangePart === '*') {
      if ((value - min) % step === 0) return true;
      continue;
    }

    const dashSplit = rangePart.split('-');
    if (dashSplit.length === 2) {
      const lo = parseInt(dashSplit[0]!, 10);
      const hi = parseInt(dashSplit[1]!, 10);
      if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
    } else {
      const exact = parseInt(rangePart, 10);
      if (exact === value) return true;
      if (max === 7 && exact === 7 && value === 0) return true;
    }
  }

  return false;
}

function toTzDate(epochMs: number, tz: string): Date {
  try {
    const str = new Date(epochMs).toLocaleString('en-US', { timeZone: tz });
    return new Date(str);
  } catch {
    return new Date(epochMs);
  }
}

function fromTzDate(localDate: Date, tz: string): number {
  try {
    const utcStr = localDate.toLocaleString('en-US', { timeZone: 'UTC' });
    const tzStr = new Date(localDate.getTime()).toLocaleString('en-US', { timeZone: tz });
    const diff = new Date(utcStr).getTime() - new Date(tzStr).getTime();
    return localDate.getTime() + diff;
  } catch {
    return localDate.getTime();
  }
}

export function formatScheduleDescription(schedule: TaskSchedule): string {
  switch (schedule.kind) {
    case 'at':
      return `Once at ${schedule.at}`;
    case 'every': {
      const ms = schedule.everyMs;
      if (ms >= 3_600_000) return `Every ${(ms / 3_600_000).toFixed(1)}h`;
      if (ms >= 60_000) return `Every ${(ms / 60_000).toFixed(0)}m`;
      return `Every ${(ms / 1000).toFixed(0)}s`;
    }
    case 'cron':
      return `Cron: ${schedule.expr}${schedule.tz ? ` (${schedule.tz})` : ''}`;
  }
}
