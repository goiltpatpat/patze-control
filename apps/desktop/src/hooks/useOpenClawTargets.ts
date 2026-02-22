import { useCallback, useMemo, useRef, useState } from 'react';
import type { ConnectionStatus } from '../types';
import { useSmartPoll } from './useSmartPoll';

export interface OpenClawTargetInfo {
  readonly id: string;
  readonly label: string;
  readonly type: 'local' | 'remote';
  readonly openclawDir: string;
  readonly pollIntervalMs: number;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface OpenClawSyncStatusInfo {
  readonly running: boolean;
  readonly available: boolean;
  readonly pollIntervalMs: number;
  readonly jobsCount: number;
  readonly lastAttemptAt?: string;
  readonly lastSuccessfulSyncAt?: string;
  readonly consecutiveFailures: number;
  readonly lastError?: string;
  readonly stale: boolean;
}

export interface TargetSyncStatusEntry {
  readonly target: OpenClawTargetInfo;
  readonly syncStatus: OpenClawSyncStatusInfo;
}

export interface OpenClawTargetsSummary {
  readonly count: number;
  readonly totalJobs: number;
  readonly healthy: number;
  readonly unhealthy: number;
  readonly lastSyncAt: string | null;
  readonly overallHealth: 'healthy' | 'degraded' | 'none';
}

const FETCH_TIMEOUT_MS = 8_000;
const POLL_INTERVAL_MS = 30_000;

function computeSummary(entries: readonly TargetSyncStatusEntry[]): OpenClawTargetsSummary {
  if (entries.length === 0) {
    return {
      count: 0,
      totalJobs: 0,
      healthy: 0,
      unhealthy: 0,
      lastSyncAt: null,
      overallHealth: 'none',
    };
  }

  const totalJobs = entries.reduce((sum, e) => sum + e.syncStatus.jobsCount, 0);

  const healthy = entries.filter(
    (e) => e.syncStatus.available && e.syncStatus.consecutiveFailures === 0 && !e.syncStatus.stale
  ).length;

  const unhealthy = Math.max(0, entries.length - healthy);

  const lastSyncAt =
    entries
      .map((e) => e.syncStatus.lastSuccessfulSyncAt ?? null)
      .filter((v): v is string => v !== null)
      .sort((a, b) => b.localeCompare(a))[0] ?? null;

  const overallHealth: 'healthy' | 'degraded' | 'none' = unhealthy === 0 ? 'healthy' : 'degraded';

  return { count: entries.length, totalJobs, healthy, unhealthy, lastSyncAt, overallHealth };
}

export interface UseOpenClawTargetsResult {
  readonly entries: readonly TargetSyncStatusEntry[];
  readonly summary: OpenClawTargetsSummary;
  readonly refresh: () => Promise<void>;
}

export function useOpenClawTargets(
  baseUrl: string,
  token: string,
  status: ConnectionStatus
): UseOpenClawTargetsResult {
  const [entries, setEntries] = useState<readonly TargetSyncStatusEntry[]>([]);
  const entriesRef = useRef(entries);

  const isConnected = status === 'connected' || status === 'degraded';
  const headers = useMemo(() => (token ? { Authorization: `Bearer ${token}` } : {}), [token]);

  const doFetch = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`${baseUrl}/openclaw/targets`, {
        headers,
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { targets: TargetSyncStatusEntry[] };
      entriesRef.current = data.targets;
      setEntries(data.targets);
      return true;
    } catch {
      return false;
    }
  }, [baseUrl, headers]);

  const refresh = useCallback(async () => {
    await doFetch();
  }, [doFetch]);

  useSmartPoll(doFetch, {
    enabled: isConnected,
    baseIntervalMs: POLL_INTERVAL_MS,
  });

  const summary = useMemo(() => computeSummary(entries), [entries]);

  return { entries, summary, refresh };
}
