import { useCallback, useRef, useState } from 'react';
import { useSmartPoll } from './useSmartPoll';

const POLL_INTERVAL_MS = 30_000;

export interface BridgeConnection {
  readonly machineId: string;
  readonly machineLabel?: string;
  readonly bridgeVersion?: string;
  readonly lastSeenAt?: string;
}

export function useBridgeConnections(
  baseUrl: string,
  connected: boolean
): readonly BridgeConnection[] {
  const [bridges, setBridges] = useState<BridgeConnection[]>([]);
  const activeRef = useRef(true);

  const fetcher = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`${baseUrl}/bridge/connections`, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok || !activeRef.current) return false;
      const data = (await res.json()) as { connections: BridgeConnection[] } | BridgeConnection[];
      const list = Array.isArray(data) ? data : data.connections;
      if (activeRef.current) setBridges(list);
      return true;
    } catch {
      return false;
    }
  }, [baseUrl]);

  useSmartPoll(fetcher, {
    enabled: connected,
    baseIntervalMs: POLL_INTERVAL_MS,
    maxIntervalMs: 120_000,
  });

  return bridges;
}
