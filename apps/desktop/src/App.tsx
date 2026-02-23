import { useEffect, useMemo, useRef, useState } from 'react';
import { useBridgeConnections } from './hooks/useBridgeConnections';
import { useEndpointManager } from './hooks/useEndpointManager';
import { useManagedBridges } from './hooks/useManagedBridges';
import { useEventToasts } from './hooks/useEventToasts';
import { AppShell } from './shell/AppShell';
import type { TunnelEndpointRow } from './views/TunnelsView';
import { useControlMonitor } from './useControlMonitor';

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
const DEFAULT_BASE_URL = 'http://127.0.0.1:9700';

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
  const [baseUrl, setBaseUrl] = useState(() =>
    loadPersistedString(STORAGE_KEY_URL, DEFAULT_BASE_URL)
  );
  const [token, setToken] = useState(() => loadPersistedString(STORAGE_KEY_TOKEN, ''));
  const [isTunnelTransitioning, setIsTunnelTransitioning] = useState(false);
  const [appReady, setAppReady] = useState(moduleAutoConnectDone);
  const transitionLockRef = useRef(false);
  const { state, connect, disconnect } = useControlMonitor();

  const connectRef = useRef(connect);
  connectRef.current = connect;

  useEffect(() => {
    if (moduleAutoConnectDone) {
      setAppReady(true);
      return;
    }
    let cancelled = false;

    const sleep = (ms: number): Promise<void> =>
      new Promise((r) => {
        setTimeout(r, ms);
      });

    const poll = async (): Promise<void> => {
      const port = await detectSidecarPort();
      const url = port ? `http://127.0.0.1:${port}` : 'http://127.0.0.1:9700';
      if (port && !cancelled) setBaseUrl(url);

      const savedToken = loadPersistedString(STORAGE_KEY_TOKEN, '');

      while (!cancelled && !moduleAutoConnectDone) {
        try {
          const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
          if (res.ok && !cancelled && !moduleAutoConnectDone) {
            moduleAutoConnectDone = true;
            await connectRef.current({ baseUrl: url, token: savedToken });
            if (!cancelled) setAppReady(true);
            return;
          }
        } catch {
          /* server not ready */
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
    setToken(value);
    persistString(STORAGE_KEY_TOKEN, value);
  };

  const endpointManager = useEndpointManager(baseUrl, token);
  const isConnected = state.status === 'connected' || state.status === 'degraded';
  const bridgeConnections = useBridgeConnections(baseUrl, token, isConnected);
  const managedBridges = useManagedBridges(baseUrl, token, isConnected);
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
      await connect({ baseUrl, token });
    });
  };

  const handleDisconnect = (): void => {
    withTunnelTransitionLock(async () => {
      await disconnect();
    });
  };

  const handleReconnect = (): void => {
    withTunnelTransitionLock(async () => {
      await disconnect();
      await connect({ baseUrl, token });
    });
  };

  if (!appReady) {
    return (
      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          height: '100vh',
          gap: 12,
          color: 'var(--text-muted)',
          fontSize: '0.88rem',
        }}
      >
        <span className="mini-spinner" style={{ width: 20, height: 20 }} />
        <span>Connecting to API server…</span>
      </div>
    );
  }

  return (
    <AppShell
      baseUrl={baseUrl}
      token={token}
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
    />
  );
}
