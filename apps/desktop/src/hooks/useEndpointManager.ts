import { useCallback, useEffect, useRef, useState } from 'react';

const STORAGE_KEY = 'patze_endpoints';
const POLL_INTERVAL_MS = 15_000;

export interface PersistedEndpoint {
  readonly id: string;
  readonly label: string;
  readonly host: string;
  readonly port: number;
  readonly sshUser: string;
  readonly remoteBaseUrl: string;
  readonly hasToken: boolean;
  readonly hasSshKeyPath: boolean;
}

export type EndpointStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface ManagedEndpoint extends PersistedEndpoint {
  readonly status: EndpointStatus;
  readonly attachmentId?: string;
  readonly errorMessage?: string;
  readonly lastConnectedAt?: number;
}

export interface ConnectCredentials {
  readonly authToken?: string;
  readonly sshKeyPath?: string;
}

interface ServerAttachment {
  id: string;
  host: string;
  port: number;
  sshUser: string;
  status: string;
}

function loadPersistedEndpoints(): PersistedEndpoint[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as PersistedEndpoint[];
  } catch {
    return [];
  }
}

function savePersistedEndpoints(endpoints: PersistedEndpoint[]): void {
  const persisted: PersistedEndpoint[] = endpoints.map((ep) => ({
    id: ep.id,
    label: ep.label,
    host: ep.host,
    port: ep.port,
    sshUser: ep.sshUser,
    remoteBaseUrl: ep.remoteBaseUrl,
    hasToken: ep.hasToken,
    hasSshKeyPath: ep.hasSshKeyPath,
  }));
  localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
}

function toManaged(ep: PersistedEndpoint): ManagedEndpoint {
  return { ...ep, status: 'disconnected' };
}

function generateId(): string {
  return `ep_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function patchEndpoint(ep: ManagedEndpoint, patch: Partial<Pick<ManagedEndpoint, 'status' | 'errorMessage'>> & {
  attachmentId?: string;
  lastConnectedAt?: number;
  clearAttachmentId?: boolean;
  clearErrorMessage?: boolean;
}): ManagedEndpoint {
  const result: Record<string, unknown> = { ...ep };
  if (patch.status !== undefined) result.status = patch.status;
  if (patch.attachmentId !== undefined) result.attachmentId = patch.attachmentId;
  if (patch.lastConnectedAt !== undefined) result.lastConnectedAt = patch.lastConnectedAt;
  if (patch.errorMessage !== undefined) result.errorMessage = patch.errorMessage;
  if (patch.clearAttachmentId) delete result.attachmentId;
  if (patch.clearErrorMessage) delete result.errorMessage;
  return result as unknown as ManagedEndpoint;
}

export interface UseEndpointManagerResult {
  readonly endpoints: readonly ManagedEndpoint[];
  readonly addEndpoint: (config: Omit<PersistedEndpoint, 'id'>) => void;
  readonly removeEndpoint: (id: string) => void;
  readonly connectEndpoint: (id: string, credentials: ConnectCredentials) => Promise<void>;
  readonly disconnectEndpoint: (id: string) => Promise<void>;
}

export function useEndpointManager(primaryBaseUrl: string): UseEndpointManagerResult {
  const [endpoints, setEndpoints] = useState<ManagedEndpoint[]>(() =>
    loadPersistedEndpoints().map(toManaged),
  );
  const endpointsRef = useRef(endpoints);
  endpointsRef.current = endpoints;

  const persist = useCallback((next: ManagedEndpoint[]) => {
    setEndpoints(next);
    savePersistedEndpoints(next);
  }, []);

  const addEndpoint = useCallback((config: Omit<PersistedEndpoint, 'id'>) => {
    const ep: ManagedEndpoint = { ...config, id: generateId(), status: 'disconnected' };
    persist([...endpointsRef.current, ep]);
  }, [persist]);

  const removeEndpoint = useCallback((id: string) => {
    persist(endpointsRef.current.filter((ep) => ep.id !== id));
  }, [persist]);

  const updateEndpoint = useCallback((id: string, updater: (ep: ManagedEndpoint) => ManagedEndpoint) => {
    setEndpoints((prev) =>
      prev.map((ep) => (ep.id === id ? updater(ep) : ep)),
    );
  }, []);

  const connectEndpoint = useCallback(async (id: string, credentials: ConnectCredentials) => {
    const ep = endpointsRef.current.find((e) => e.id === id);
    if (!ep) return;

    updateEndpoint(id, (e) => patchEndpoint(e, { status: 'connecting', clearErrorMessage: true }));

    try {
      const body: Record<string, unknown> = {
        host: ep.host,
        port: ep.port,
        sshUser: ep.sshUser,
        remoteBaseUrl: ep.remoteBaseUrl,
      };
      if (credentials.authToken) body.authToken = credentials.authToken;
      if (credentials.sshKeyPath) body.sshKeyPath = credentials.sshKeyPath;

      const res = await fetch(`${primaryBaseUrl}/remote/attach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => 'Unknown error');
        throw new Error(`${String(res.status)}: ${text}`);
      }

      const data = (await res.json()) as { attachmentId?: string };
      const patch: Parameters<typeof patchEndpoint>[1] = {
        status: 'connected',
        lastConnectedAt: Date.now(),
        clearErrorMessage: true,
      };
      if (data.attachmentId) patch.attachmentId = data.attachmentId;
      updateEndpoint(id, (e) => patchEndpoint(e, patch));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Connection failed';
      updateEndpoint(id, (e) => patchEndpoint(e, { status: 'error', errorMessage: message }));
    }
  }, [primaryBaseUrl, updateEndpoint]);

  const disconnectEndpoint = useCallback(async (id: string) => {
    const ep = endpointsRef.current.find((e) => e.id === id);
    if (!ep?.attachmentId) {
      updateEndpoint(id, (e) => patchEndpoint(e, { status: 'disconnected', clearAttachmentId: true }));
      return;
    }

    try {
      await fetch(`${primaryBaseUrl}/remote/detach`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ attachmentId: ep.attachmentId }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Best-effort detach
    }

    updateEndpoint(id, (e) => patchEndpoint(e, { status: 'disconnected', clearAttachmentId: true }));
  }, [primaryBaseUrl, updateEndpoint]);

  useEffect(() => {
    let active = true;

    async function syncAttachments(): Promise<void> {
      try {
        const res = await fetch(`${primaryBaseUrl}/remote/attachments`, {
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) return;
        const data = (await res.json()) as ServerAttachment[];
        if (!active) return;

        setEndpoints((prev) =>
          prev.map((ep): ManagedEndpoint => {
            const match = data.find(
              (a) => a.host === ep.host && a.port === ep.port && a.sshUser === ep.sshUser,
            );
            if (match) {
              const status: EndpointStatus = match.status === 'connected' ? 'connected' : 'disconnected';
              return patchEndpoint(ep, { attachmentId: match.id, status });
            }
            if (ep.status === 'connected') {
              return patchEndpoint(ep, { status: 'disconnected', clearAttachmentId: true });
            }
            return ep;
          }),
        );
      } catch {
        // Polling failure is silent
      }
    }

    const timer = setInterval(syncAttachments, POLL_INTERVAL_MS);
    void syncAttachments();

    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [primaryBaseUrl]);

  return { endpoints, addEndpoint, removeEndpoint, connectEndpoint, disconnectEndpoint };
}
