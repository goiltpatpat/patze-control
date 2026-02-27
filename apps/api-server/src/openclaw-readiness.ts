export type ReadinessStatus = 'ok' | 'warn' | 'error';

export interface ReadinessCheckLike {
  readonly id: string;
  readonly status: ReadinessStatus;
  readonly detail: string;
}

export function computeReadinessScore(checks: readonly ReadinessCheckLike[]): number {
  let score = 100;
  for (const check of checks) {
    if (check.status === 'warn') score -= 12;
    if (check.status === 'error') score -= 25;
  }
  return Math.max(0, Math.min(100, score));
}

export function deriveReadinessRootCause(checks: readonly ReadinessCheckLike[]): {
  severity: 'error' | 'warn' | 'ok';
  detail: string;
} {
  const firstError = checks.find((check) => check.status === 'error');
  if (firstError) {
    return { severity: 'error', detail: firstError.detail };
  }
  const firstWarn = checks.find((check) => check.status === 'warn');
  if (firstWarn) {
    return { severity: 'warn', detail: firstWarn.detail };
  }
  return { severity: 'ok', detail: 'All readiness checks pass.' };
}
