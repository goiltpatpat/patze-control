import { useCallback, useMemo, useRef, useState } from 'react';
import type { ConnectionStatus } from '../types';
import { cachedFetch } from './useApiCache';
import { useSmartPoll } from './useSmartPoll';
import { shouldPausePollWhenHidden } from '../utils/runtime';

export interface OpenClawTargetInfo {
  readonly id: string;
  readonly label: string;
  readonly type: 'local' | 'remote';
  readonly origin: 'user' | 'auto' | 'smoke';
  readonly purpose: 'production' | 'test';
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
  readonly loading: boolean;
  readonly lastError: string | null;
  readonly lastSuccessfulFetchAt: string | null;
  readonly consecutiveFailures: number;
  readonly refresh: () => Promise<void>;
}

export function useOpenClawTargets(
  baseUrl: string,
  token: string,
  status: ConnectionStatus
): UseOpenClawTargetsResult {
  const [entries, setEntries] = useState<readonly TargetSyncStatusEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);
  const [lastSuccessfulFetchAt, setLastSuccessfulFetchAt] = useState<string | null>(null);
  const [consecutiveFailures, setConsecutiveFailures] = useState(0);
  const isConnected = status === 'connected' || status === 'degraded';
  const headers = useMemo(() => (token ? { Authorization: `Bearer ${token}` } : {}), [token]);
  const requestVersionRef = useRef(0);
  const fetchControllerRef = useRef<AbortController | null>(null);

  const doFetch = useCallback(
    async (context?: { signal: AbortSignal }): Promise<boolean> => {
      if (!isConnected) {
        setEntries([]);
        setLoading(false);
        setLastError(null);
        setConsecutiveFailures(0);
        return true;
      }

      const requestVersion = ++requestVersionRef.current;
      if (!context?.signal) {
        fetchControllerRef.current?.abort();
        fetchControllerRef.current = new AbortController();
      }
      const timeoutController = new AbortController();
      const parentSignal = context?.signal ?? fetchControllerRef.current?.signal ?? null;
      let abortRelay: (() => void) | null = null;
      if (parentSignal) {
        if (parentSignal.aborted) {
          timeoutController.abort();
        } else {
          const onAbort = () => timeoutController.abort();
          parentSignal.addEventListener('abort', onAbort, { once: true });
          abortRelay = () => parentSignal.removeEventListener('abort', onAbort);
        }
      }
      const timeoutId = window.setTimeout(() => timeoutController.abort(), FETCH_TIMEOUT_MS);
      const signal = timeoutController.signal;

      if (requestVersion === requestVersionRef.current) {
        setLoading(true);
      }

      try {
        const res = await cachedFetch(`${baseUrl}/openclaw/targets`, {
          headers,
          signal,
          ttlMs: 8_000,
        });
        if (!res.ok) {
          if (!signal.aborted && requestVersion === requestVersionRef.current) {
            setLastError(`Failed to load OpenClaw targets (HTTP ${res.status}).`);
            setConsecutiveFailures((prev) => prev + 1);
          }
          return false;
        }
        const data = (await res.json()) as { targets: TargetSyncStatusEntry[] };
        if (!signal.aborted && requestVersion === requestVersionRef.current) {
          setEntries(data.targets);
          setLastError(null);
          setConsecutiveFailures(0);
          setLastSuccessfulFetchAt(new Date().toISOString());
        }
        return true;
      } catch (error) {
        if (!signal.aborted && requestVersion === requestVersionRef.current) {
          setLastError(error instanceof Error ? error.message : 'Failed to load OpenClaw targets.');
          setConsecutiveFailures((prev) => prev + 1);
        }
        return false;
      } finally {
        window.clearTimeout(timeoutId);
        abortRelay?.();
        if (requestVersion === requestVersionRef.current) {
          setLoading(false);
        }
      }
    },
    [baseUrl, headers, isConnected]
  );

  const pauseOnHidden = shouldPausePollWhenHidden();

  const refresh = useCallback(async () => {
    await doFetch();
  }, [doFetch]);

  useSmartPoll(doFetch, {
    enabled: isConnected,
    baseIntervalMs: POLL_INTERVAL_MS,
    pauseOnHidden,
  });

  const summary = useMemo(() => computeSummary(entries), [entries]);

  return {
    entries,
    summary,
    loading,
    lastError,
    lastSuccessfulFetchAt,
    consecutiveFailures,
    refresh,
  };
}
