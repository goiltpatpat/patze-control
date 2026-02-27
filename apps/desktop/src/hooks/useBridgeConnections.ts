import { useCallback, useRef, useState } from 'react';
import { useSmartPoll } from './useSmartPoll';
import { shouldPausePollWhenHidden } from '../utils/runtime';

const POLL_INTERVAL_MS = 30_000;

export interface BridgeConnection {
  readonly machineId: string;
  readonly machineLabel?: string;
  readonly bridgeVersion?: string;
  readonly lastSeenAt?: string;
}

function buildAuthHeaders(token: string): Record<string, string> {
  if (token.length > 0) return { Authorization: `Bearer ${token}` };
  return {};
}

export function useBridgeConnections(
  baseUrl: string,
  token: string,
  connected: boolean
): readonly BridgeConnection[] {
  const [bridges, setBridges] = useState<BridgeConnection[]>([]);
  const activeRef = useRef(true);
  const requestVersionRef = useRef(0);

  const fetcher = useCallback(
    async (context?: { signal: AbortSignal }): Promise<boolean> => {
      const requestVersion = ++requestVersionRef.current;
      try {
        const res = await fetch(`${baseUrl}/bridge/connections`, {
          headers: buildAuthHeaders(token),
          signal: context?.signal ?? AbortSignal.timeout(8_000),
        });
        if (!res.ok || !activeRef.current) return false;
        const data = (await res.json()) as { connections: BridgeConnection[] } | BridgeConnection[];
        const list = Array.isArray(data) ? data : data.connections;
        if (activeRef.current && requestVersion === requestVersionRef.current) setBridges(list);
        return true;
      } catch {
        return false;
      }
    },
    [baseUrl, token]
  );

  const pauseOnHidden = shouldPausePollWhenHidden();

  useSmartPoll(fetcher, {
    enabled: connected,
    baseIntervalMs: POLL_INTERVAL_MS,
    maxIntervalMs: 120_000,
    pauseOnHidden,
  });

  return bridges;
}
