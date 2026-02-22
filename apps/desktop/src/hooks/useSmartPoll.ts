import { useCallback, useEffect, useRef } from 'react';

interface SmartPollOptions {
  readonly enabled: boolean;
  readonly baseIntervalMs: number;
  readonly maxIntervalMs?: number;
  readonly pauseOnHidden?: boolean;
}

/**
 * Generic smart polling hook with:
 * - Exponential backoff on consecutive errors
 * - Pause when tab is hidden (optional, default true)
 * - Reset backoff on success
 */
export function useSmartPoll(fetcher: () => Promise<boolean>, options: SmartPollOptions): void {
  const {
    enabled,
    baseIntervalMs,
    maxIntervalMs = baseIntervalMs * 8,
    pauseOnHidden = true,
  } = options;
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const consecutiveErrorsRef = useRef(0);
  const activeRef = useRef(true);
  const visibleRef = useRef(!document.hidden);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const getNextInterval = useCallback((): number => {
    if (consecutiveErrorsRef.current === 0) return baseIntervalMs;
    const backoff = baseIntervalMs * Math.pow(2, Math.min(consecutiveErrorsRef.current, 5));
    return Math.min(backoff, maxIntervalMs);
  }, [baseIntervalMs, maxIntervalMs]);

  const schedule = useCallback((): void => {
    if (!activeRef.current) return;
    if (pauseOnHidden && !visibleRef.current) return;

    clearTimer();
    timerRef.current = setTimeout(() => {
      if (!activeRef.current) return;

      void fetcher().then((success) => {
        if (!activeRef.current) return;
        if (success) {
          consecutiveErrorsRef.current = 0;
        } else {
          consecutiveErrorsRef.current += 1;
        }
        schedule();
      });
    }, getNextInterval());
  }, [fetcher, clearTimer, getNextInterval, pauseOnHidden]);

  useEffect(() => {
    if (!enabled) {
      activeRef.current = false;
      clearTimer();
      return;
    }

    activeRef.current = true;
    consecutiveErrorsRef.current = 0;

    void fetcher().then((success) => {
      if (!activeRef.current) return;
      if (!success) consecutiveErrorsRef.current = 1;
      schedule();
    });

    return () => {
      activeRef.current = false;
      clearTimer();
    };
  }, [enabled, fetcher, clearTimer, schedule]);

  useEffect(() => {
    if (!pauseOnHidden) return;

    function handleVisibility(): void {
      visibleRef.current = !document.hidden;
      if (visibleRef.current && activeRef.current) {
        schedule();
      } else {
        clearTimer();
      }
    }

    document.addEventListener('visibilitychange', handleVisibility);
    return () => {
      document.removeEventListener('visibilitychange', handleVisibility);
    };
  }, [pauseOnHidden, schedule, clearTimer]);
}
