import { useCallback, useRef, useState } from 'react';
import { useSmartPoll } from './useSmartPoll';
import { shouldPausePollWhenHidden } from '../utils/runtime';

const POLL_ACTIVE_MS = 5_000;
const POLL_IDLE_MS = 20_000;

export type FleetRiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type FleetViolationSeverity = 'warning' | 'high' | 'critical';

export interface FleetDriftRecord {
  readonly targetId: string;
  readonly category: 'version' | 'config' | 'sync' | 'runtime';
  readonly severity: 'minor' | 'major' | 'critical';
  readonly expected: string;
  readonly actual: string;
  readonly detectedAt: string;
}

export interface FleetPolicyViolation {
  readonly id: string;
  readonly targetId: string;
  readonly code: string;
  readonly severity: FleetViolationSeverity;
  readonly message: string;
  readonly createdAt: string;
}

export interface FleetTargetStatus {
  readonly targetId: string;
  readonly targetLabel: string;
  readonly targetType: 'local' | 'remote';
  readonly reported?: {
    readonly machineId?: string;
    readonly bridgeVersion?: string;
    readonly configHash?: string;
    readonly syncLagMs?: number;
    readonly heartbeatAt?: string;
  };
  readonly healthScore: number;
  readonly riskLevel: FleetRiskLevel;
  readonly drifts: readonly FleetDriftRecord[];
  readonly violations: readonly FleetPolicyViolation[];
  readonly updatedAt: string;
}

function buildHeaders(token: string): Record<string, string> {
  if (token.length > 0) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
}

export function useSmartFleet(
  baseUrl: string,
  token: string,
  connected: boolean,
  enabled: boolean
) {
  const [targets, setTargets] = useState<FleetTargetStatus[]>([]);
  const [violations, setViolations] = useState<FleetPolicyViolation[]>([]);
  const requestVersionRef = useRef(0);

  const fetchTargets = useCallback(
    async (context?: { signal: AbortSignal }): Promise<boolean> => {
      if (!enabled) {
        setTargets([]);
        setViolations([]);
        return true;
      }

      const requestVersion = ++requestVersionRef.current;
      try {
        const [targetsRes, violationsRes] = await Promise.all([
          fetch(`${baseUrl}/fleet/targets`, {
            headers: buildHeaders(token),
            signal: context?.signal ?? AbortSignal.timeout(10_000),
          }),
          fetch(`${baseUrl}/fleet/violations`, {
            headers: buildHeaders(token),
            signal: context?.signal ?? AbortSignal.timeout(10_000),
          }),
        ]);
        if (!targetsRes.ok) return false;
        const targetsData = (await targetsRes.json()) as { targets?: FleetTargetStatus[] };
        const violationsData = violationsRes.ok
          ? ((await violationsRes.json()) as { violations?: FleetPolicyViolation[] })
          : { violations: [] as FleetPolicyViolation[] };
        if (requestVersion === requestVersionRef.current) {
          setTargets(targetsData.targets ?? []);
          setViolations(violationsData.violations ?? []);
        }
        return true;
      } catch {
        return false;
      }
    },
    [baseUrl, enabled, token]
  );

  const hasIssues = targets.some(
    (target) => target.drifts.length > 0 || target.violations.length > 0
  );
  const pauseOnHidden = shouldPausePollWhenHidden();
  useSmartPoll(fetchTargets, {
    enabled: connected && enabled,
    baseIntervalMs: hasIssues ? POLL_ACTIVE_MS : POLL_IDLE_MS,
    maxIntervalMs: 60_000,
    pauseOnHidden,
  });

  const reconcileTarget = useCallback(
    async (targetId: string): Promise<boolean> => {
      if (!enabled) return false;
      try {
        const res = await fetch(
          `${baseUrl}/fleet/targets/${encodeURIComponent(targetId)}/reconcile`,
          {
            method: 'POST',
            headers: buildHeaders(token),
            signal: AbortSignal.timeout(15_000),
          }
        );
        void fetchTargets();
        return res.ok;
      } catch {
        return false;
      }
    },
    [baseUrl, enabled, fetchTargets, token]
  );

  return {
    targets,
    violations,
    reconcileTarget,
    refresh: fetchTargets,
  } as const;
}
