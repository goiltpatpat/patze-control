export interface SmokeTargetCandidate {
  readonly label: string;
  readonly openclawDir?: string | undefined;
  readonly origin?: 'user' | 'auto' | 'smoke' | undefined;
  readonly purpose?: 'production' | 'test' | undefined;
}

const SMOKE_LABEL_PATTERNS: readonly RegExp[] = [
  /^ui smoke target/i,
  /^smoke target/i,
  /^ui target alpha\b/i,
  /^ui target beta\b/i,
];

const SMOKE_DIR_PATTERNS: readonly RegExp[] = [
  /patze-smoke/i,
  /patze-ui-smoke/i,
  /patze-ui-multi/i,
  /patze-ui-target-edit-smoke/i,
];

export function isSmokeTarget(candidate: SmokeTargetCandidate): boolean {
  if (candidate.purpose !== undefined) {
    return candidate.purpose === 'test';
  }
  if (candidate.origin === 'smoke') {
    return true;
  }
  const label = candidate.label.trim();
  if (SMOKE_LABEL_PATTERNS.some((pattern) => pattern.test(label))) {
    return true;
  }
  const dir = candidate.openclawDir?.trim() ?? '';
  if (dir.length === 0) return false;
  return SMOKE_DIR_PATTERNS.some((pattern) => pattern.test(dir));
}
