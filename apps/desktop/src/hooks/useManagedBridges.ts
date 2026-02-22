import { useCallback, useRef, useState } from 'react';
import { useSmartPoll } from './useSmartPoll';

const POLL_ACTIVE_MS = 3_000;
const POLL_IDLE_MS = 15_000;

export type BridgeSetupPhase =
  | 'connecting'
  | 'ssh_test'
  | 'tunnel_open'
  | 'installing'
  | 'running'
  | 'telemetry_active'
  | 'error'
  | 'disconnected';

export interface ManagedBridgeState {
  readonly id: string;
  readonly label: string;
  readonly sshHost: string;
  readonly sshUser: string;
  readonly sshPort: number;
  readonly remotePort: number;
  readonly status: BridgeSetupPhase;
  readonly error: string | undefined;
  readonly logs: readonly string[];
  readonly machineId: string | undefined;
  readonly connectedAt: string | undefined;
}

export interface BridgeSetupInput {
  readonly label: string;
  readonly sshHost: string;
  readonly sshPort: number;
  readonly sshUser: string;
  readonly sshKeyPath: string;
  readonly sshMode?: 'alias' | 'explicit' | undefined;
  readonly authToken: string;
  readonly remotePort: number;
  readonly expiresIn?: string | undefined;
  readonly openclawHome?: string | undefined;
}

const ACTIVE_STATUSES = new Set<BridgeSetupPhase>([
  'connecting',
  'ssh_test',
  'tunnel_open',
  'installing',
]);

function buildHeaders(token: string, json?: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token.length > 0) headers.Authorization = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

export function useManagedBridges(baseUrl: string, token: string, connected: boolean) {
  const [bridges, setBridges] = useState<ManagedBridgeState[]>([]);
  const [loading, setLoading] = useState(false);
  const bridgesRef = useRef(bridges);
  bridgesRef.current = bridges;

  const fetchBridges = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`${baseUrl}/bridge/managed`, {
        headers: buildHeaders(token),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) return false;
      const data = (await res.json()) as { bridges: ManagedBridgeState[] };
      setBridges(data.bridges ?? []);
      return true;
    } catch {
      return false;
    }
  }, [baseUrl, token]);

  const hasActive = bridgesRef.current.some((b) => ACTIVE_STATUSES.has(b.status));

  useSmartPoll(fetchBridges, {
    enabled: connected,
    baseIntervalMs: hasActive ? POLL_ACTIVE_MS : POLL_IDLE_MS,
    maxIntervalMs: 60_000,
  });

  const setupBridge = useCallback(
    async (input: BridgeSetupInput): Promise<ManagedBridgeState | null> => {
      setLoading(true);
      try {
        const res = await fetch(`${baseUrl}/bridge/setup`, {
          method: 'POST',
          headers: buildHeaders(token, true),
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) return null;
        const state = (await res.json()) as ManagedBridgeState;
        void fetchBridges();
        return state;
      } catch {
        return null;
      } finally {
        setLoading(false);
      }
    },
    [baseUrl, fetchBridges, token]
  );

  const disconnectBridge = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const res = await fetch(`${baseUrl}/bridge/managed/${encodeURIComponent(id)}/disconnect`, {
          method: 'POST',
          headers: buildHeaders(token),
          signal: AbortSignal.timeout(8_000),
        });
        void fetchBridges();
        return res.ok;
      } catch {
        return false;
      }
    },
    [baseUrl, fetchBridges, token]
  );

  const removeBridge = useCallback(
    async (id: string): Promise<boolean> => {
      try {
        const res = await fetch(`${baseUrl}/bridge/managed/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: buildHeaders(token),
          signal: AbortSignal.timeout(8_000),
        });
        void fetchBridges();
        return res.ok;
      } catch {
        return false;
      }
    },
    [baseUrl, fetchBridges, token]
  );

  return {
    bridges,
    loading,
    setupBridge,
    disconnectBridge,
    removeBridge,
    refresh: fetchBridges,
  } as const;
}
