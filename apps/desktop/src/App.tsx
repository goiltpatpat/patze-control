import { useEffect, useMemo, useRef, useState } from 'react';
import { useBridgeConnections } from './hooks/useBridgeConnections';
import { useEndpointManager } from './hooks/useEndpointManager';
import { useManagedBridges } from './hooks/useManagedBridges';
import { useSmartFleet } from './hooks/useSmartFleet';
import { useEventToasts } from './hooks/useEventToasts';
import { AppShell } from './shell/AppShell';
import type { TunnelEndpointRow } from './views/TunnelsView';
import { useControlMonitor } from './useControlMonitor';
import { buildEndpointFallbackCandidates, normalizeEndpoint } from './utils/endpoint-fallback';

function toForwardedPort(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    if (url.port.length > 0) {
      return url.port;
    }
    return url.protocol === 'https:' ? '443' : '80';
  } catch {
    return '-';
  }
}

async function detectSidecarPort(): Promise<number | null> {
  if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
    try {
      const { invoke } = await import('@tauri-apps/api/core');
      const port = await invoke<number>('get_api_port');
      return port;
    } catch {
      return null;
    }
  }
  return null;
}

const STORAGE_KEY_URL = 'patze_base_url';
const STORAGE_KEY_TOKEN = 'patze_token';
const DEFAULT_BASE_URL = 'http://localhost:9700';
const SMART_FLEET_V2_ENABLED = (import.meta.env.VITE_SMART_FLEET_V2_ENABLED ?? '1') !== '0';

function loadPersistedString(key: string, fallback: string): string {
  try {
    const v = localStorage.getItem(key);
    return v !== null && v.length > 0 ? v : fallback;
  } catch {
    return fallback;
  }
}

function persistString(key: string, value: string): void {
  try {
    if (value.length > 0) {
      localStorage.setItem(key, value);
    } else {
      localStorage.removeItem(key);
    }
  } catch {
    /* storage full / unavailable */
  }
}

let moduleAutoConnectDone = false;

export function App(): JSX.Element {
  const [baseUrl, setBaseUrl] = useState(() => {
    const saved = loadPersistedString(STORAGE_KEY_URL, DEFAULT_BASE_URL);
    return normalizeEndpoint(saved) ?? DEFAULT_BASE_URL;
  });
  const [token, setToken] = useState(() => loadPersistedString(STORAGE_KEY_TOKEN, ''));
  const [isTunnelTransitioning, setIsTunnelTransitioning] = useState(false);
  const transitionLockRef = useRef(false);
  const { state, connect, disconnect } = useControlMonitor();
  const normalizedToken = token.trim();

  const connectRef = useRef(connect);
  connectRef.current = connect;

  useEffect(() => {
    if (moduleAutoConnectDone) {
      return;
    }
    let cancelled = false;

    const sleep = (ms: number): Promise<void> =>
      new Promise((r) => {
        setTimeout(r, ms);
      });

    const poll = async (): Promise<void> => {
      const port = await detectSidecarPort();
      const seedUrl = port
        ? `http://127.0.0.1:${port}`
        : loadPersistedString(STORAGE_KEY_URL, DEFAULT_BASE_URL);
      const preferredPort = port ? String(port) : '9700';
      const candidateUrls = buildEndpointFallbackCandidates(seedUrl, preferredPort);
      if (candidateUrls.length === 0) {
        candidateUrls.push(DEFAULT_BASE_URL);
      }

      const savedToken = loadPersistedString(STORAGE_KEY_TOKEN, '').trim();

      while (!cancelled && !moduleAutoConnectDone) {
        for (const candidateUrl of candidateUrls) {
          try {
            const res = await fetch(`${candidateUrl}/health`, {
              signal: AbortSignal.timeout(2000),
            });
            if (res.ok && !cancelled && !moduleAutoConnectDone) {
              moduleAutoConnectDone = true;
              setBaseUrl(candidateUrl);
              persistString(STORAGE_KEY_URL, candidateUrl);
              // Auto-connect in background only; shell renders immediately.
              void connectRef.current({ baseUrl: candidateUrl, token: savedToken }).catch(() => {
                /* user can reconnect manually from shell */
              });
              return;
            }
          } catch {
            /* candidate unavailable, try next */
          }
        }

        if (!cancelled) await sleep(2000);
      }
    };

    void poll();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleBaseUrlChange = (value: string): void => {
    setBaseUrl(value);
    persistString(STORAGE_KEY_URL, value);
  };

  const handleTokenChange = (value: string): void => {
    const nextToken = value.trim();
    setToken(nextToken);
    persistString(STORAGE_KEY_TOKEN, nextToken);
  };

  const endpointManager = useEndpointManager(baseUrl, normalizedToken);
  const isConnected = state.status === 'connected' || state.status === 'degraded';
  const bridgeConnections = useBridgeConnections(baseUrl, normalizedToken, isConnected);
  const managedBridges = useManagedBridges(baseUrl, normalizedToken, isConnected);
  const smartFleet = useSmartFleet(baseUrl, normalizedToken, isConnected, SMART_FLEET_V2_ENABLED);
  useEventToasts(state.snapshot);

  const tunnelEndpoints = useMemo<readonly TunnelEndpointRow[]>(() => {
    return [
      {
        endpointId: 'primary-endpoint',
        baseUrl,
        connectionState: state.status,
        forwardedPort: toForwardedPort(baseUrl),
      },
    ];
  }, [baseUrl, state.status]);

  const withTunnelTransitionLock = (task: () => Promise<void>): void => {
    if (transitionLockRef.current) {
      return;
    }

    transitionLockRef.current = true;
    setIsTunnelTransitioning(true);

    void task().finally(() => {
      transitionLockRef.current = false;
      setIsTunnelTransitioning(false);
    });
  };

  const handleConnect = (): void => {
    withTunnelTransitionLock(async () => {
      const effectiveBaseUrl = normalizeEndpoint(baseUrl) ?? baseUrl.trim();
      if (effectiveBaseUrl !== baseUrl) {
        setBaseUrl(effectiveBaseUrl);
        persistString(STORAGE_KEY_URL, effectiveBaseUrl);
      }
      await connect({ baseUrl: effectiveBaseUrl, token: normalizedToken });
    });
  };

  const handleDisconnect = (): void => {
    withTunnelTransitionLock(async () => {
      await disconnect();
    });
  };

  const handleReconnect = (): void => {
    withTunnelTransitionLock(async () => {
      const effectiveBaseUrl = normalizeEndpoint(baseUrl) ?? baseUrl.trim();
      if (effectiveBaseUrl !== baseUrl) {
        setBaseUrl(effectiveBaseUrl);
        persistString(STORAGE_KEY_URL, effectiveBaseUrl);
      }
      await disconnect();
      await connect({ baseUrl: effectiveBaseUrl, token: normalizedToken });
    });
  };

  return (
    <AppShell
      baseUrl={baseUrl}
      token={normalizedToken}
      status={state.status}
      errorMessage={state.errorMessage}
      monitorState={state}
      tunnelEndpoints={tunnelEndpoints}
      isTunnelTransitioning={isTunnelTransitioning}
      onBaseUrlChange={handleBaseUrlChange}
      onTokenChange={handleTokenChange}
      onConnect={handleConnect}
      onDisconnect={handleDisconnect}
      onReconnect={handleReconnect}
      remoteEndpoints={endpointManager.endpoints}
      onAddEndpoint={endpointManager.addEndpoint}
      onRemoveEndpoint={endpointManager.removeEndpoint}
      onConnectEndpoint={endpointManager.connectEndpoint}
      onDisconnectEndpoint={endpointManager.disconnectEndpoint}
      bridgeConnections={bridgeConnections}
      managedBridges={managedBridges.bridges}
      onSetupBridge={managedBridges.setupBridge}
      onDisconnectBridge={managedBridges.disconnectBridge}
      onRemoveBridge={managedBridges.removeBridge}
      onSubmitSudoPassword={managedBridges.submitSudoPassword}
      onSkipSudo={managedBridges.skipSudo}
      managedBridgesLoading={managedBridges.loading}
      smartFleetTargets={smartFleet.targets}
      smartFleetViolations={smartFleet.violations}
      onReconcileFleetTarget={smartFleet.reconcileTarget}
      onRefreshSmartFleet={async () => {
        await smartFleet.refresh();
      }}
      smartFleetEnabled={SMART_FLEET_V2_ENABLED}
    />
  );
}
