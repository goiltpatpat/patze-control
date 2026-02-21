import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from './components/Toast';
import { useEndpointManager } from './hooks/useEndpointManager';
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

export function App(): JSX.Element {
  const [baseUrl, setBaseUrl] = useState('http://127.0.0.1:8080');
  const [token, setToken] = useState('');
  const [isTunnelTransitioning, setIsTunnelTransitioning] = useState(false);
  const transitionLockRef = useRef(false);
  const { state, connect, disconnect } = useControlMonitor();
  const { addToast } = useToast();
  const prevStatusRef = useRef(state.status);

  useEffect(() => {
    const prev = prevStatusRef.current;
    const next = state.status;
    prevStatusRef.current = next;
    if (prev === next) return;

    switch (next) {
      case 'connected':
        addToast('success', 'Connected to control plane');
        break;
      case 'error':
        addToast('error', state.errorMessage ?? 'Connection failed');
        break;
      case 'idle':
        if (prev === 'connected' || prev === 'degraded') {
          addToast('warn', 'Disconnected from control plane');
        }
        break;
      case 'degraded':
        addToast('warn', 'Connection degraded');
        break;
    }
  }, [state.status, state.errorMessage, addToast]);

  const endpointManager = useEndpointManager(baseUrl);
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

  return (
    <AppShell
      baseUrl={baseUrl}
      token={token}
      status={state.status}
      errorMessage={state.errorMessage}
      monitorState={state}
      tunnelEndpoints={tunnelEndpoints}
      isTunnelTransitioning={isTunnelTransitioning}
      onBaseUrlChange={setBaseUrl}
      onTokenChange={setToken}
      onConnect={handleConnect}
      onDisconnect={handleDisconnect}
      onReconnect={handleReconnect}
      remoteEndpoints={endpointManager.endpoints}
      onAddEndpoint={endpointManager.addEndpoint}
      onRemoveEndpoint={endpointManager.removeEndpoint}
      onConnectEndpoint={endpointManager.connectEndpoint}
      onDisconnectEndpoint={endpointManager.disconnectEndpoint}
    />
  );
}
