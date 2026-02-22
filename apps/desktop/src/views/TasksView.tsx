import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilterTabs, type FilterTab } from '../components/FilterTabs';
import { IconClock } from '../components/Icons';
import type { UseOpenClawTargetsResult } from '../hooks/useOpenClawTargets';
import { navigate } from '../shell/routes';
import type { ConnectionStatus } from '../types';
import { formatPollInterval, parseSessionOrigin } from '../utils/openclaw';
import { formatRelativeTime } from '../utils/time';

interface ScheduledTask {
  id: string;
  name: string;
  description?: string;
  schedule: { kind: string; expr?: string; everyMs?: number; at?: string; tz?: string };
  action: { action: string; params?: Record<string, unknown> };
  status: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  lastRunStatus?: string;
  lastRunError?: string;
  nextRunAtMs?: number;
  consecutiveErrors: number;
  totalRuns: number;
  timeoutMs: number;
}

interface TaskRunRecord {
  taskId: string;
  runId: string;
  startedAt: string;
  endedAt?: string;
  status: string;
  error?: string;
  durationMs?: number;
}

interface OpenClawCronJob {
  jobId: string;
  name?: string;
  schedule: { kind: string; expr?: string; everyMs?: number; at?: string; tz?: string };
  execution: { style: string; agentId?: string; sessionTag?: string };
  delivery: { mode: string; webhookUrl?: string; webhookMethod?: string; channelId?: string };
  enabled: boolean;
  createdAt: string;
  updatedAt?: string;
  lastRunAt?: string;
  lastStatus?: string;
  consecutiveErrors?: number;
}

interface OpenClawRunRecord {
  jobId: string;
  runId: string;
  startedAt: string;
  endedAt?: string;
  status: string;
  error?: string;
  durationMs?: number;
  sessionId?: string;
}

interface OpenClawSyncStatus {
  running: boolean;
  available: boolean;
  pollIntervalMs: number;
  jobsCount: number;
  lastAttemptAt?: string;
  lastSuccessfulSyncAt?: string;
  consecutiveFailures: number;
  lastError?: string;
  stale: boolean;
}

interface OpenClawHealthCheck {
  readonly ok: boolean;
  readonly target: string;
  readonly checks: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: 'ok' | 'warn' | 'error';
    readonly message: string;
    readonly details?: string;
  }[];
  readonly syncStatus: OpenClawSyncStatus;
}

interface OpenClawTarget {
  id: string;
  label: string;
  type: 'local' | 'remote';
  openclawDir: string;
  pollIntervalMs: number;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface TargetSyncStatusEntry {
  target: OpenClawTarget;
  syncStatus: OpenClawSyncStatus;
}

interface TaskSnapshot {
  id: string;
  createdAt: string;
  source: string;
  description: string;
  taskCount: number;
}

export interface TasksViewProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly status: ConnectionStatus;
  readonly openclawTargets: UseOpenClawTargetsResult;
  readonly initialFilter?: 'openclaw';
}

type TaskFilter = 'all' | 'enabled' | 'disabled' | 'error' | 'openclaw';
const RECENT_HISTORY_LIMIT = 20;
const HISTORY_GROUP_PREVIEW_LIMIT = 8;

function authHeaders(token: string): Record<string, string> {
  if (token.length === 0) return {};
  return { Authorization: `Bearer ${token}` };
}

function formatSchedule(s: {
  kind: string;
  expr?: string;
  everyMs?: number;
  at?: string;
  tz?: string;
}): string {
  switch (s.kind) {
    case 'at':
      return `Once at ${s.at ?? '—'}`;
    case 'every': {
      const ms = s.everyMs ?? 0;
      if (ms >= 86_400_000) return `Every ${(ms / 86_400_000).toFixed(1)}d`;
      if (ms >= 3_600_000) return `Every ${(ms / 3_600_000).toFixed(1)}h`;
      if (ms >= 60_000) return `Every ${Math.round(ms / 60_000)}m`;
      return `Every ${Math.round(ms / 1000)}s`;
    }
    case 'cron':
      return `${s.expr ?? '—'}${s.tz ? ` (${s.tz})` : ''}`;
    default:
      return s.kind;
  }
}

function formatNextRun(ms?: number): string {
  if (ms === undefined || ms === null) return '—';
  const diff = ms - Date.now();
  if (diff <= 0) return 'due now';
  if (diff < 60_000) return `${Math.ceil(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.ceil(diff / 60_000)}m`;
  return `${(diff / 3_600_000).toFixed(1)}h`;
}

function formatDurationMs(ms?: number): string {
  if (ms === undefined) return '—';
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

function statusTone(status: string): string {
  switch (status) {
    case 'enabled':
    case 'ok':
      return 'tone-good';
    case 'running':
      return 'tone-neutral';
    case 'error':
    case 'timeout':
      return 'tone-bad';
    case 'disabled':
      return 'tone-muted';
    default:
      return 'tone-muted';
  }
}

function actionLabel(action: string): string {
  return action.replace(/_/g, ' ');
}

function createTimedAbortController(timeoutMs: number): {
  controller: AbortController;
  timeoutId: ReturnType<typeof setTimeout>;
} {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  return { controller, timeoutId };
}

function targetHealthTone(entry: TargetSyncStatusEntry): string {
  if (entry.syncStatus.consecutiveFailures >= 3 || entry.syncStatus.stale) return 'tone-bad';
  if (entry.syncStatus.consecutiveFailures > 0) return 'tone-warn';
  if (!entry.syncStatus.available) return 'tone-muted';
  return 'tone-good';
}

function targetHealthLabel(entry: TargetSyncStatusEntry): string {
  if (entry.syncStatus.consecutiveFailures >= 3) return 'failing';
  if (entry.syncStatus.stale) return 'stale';
  if (entry.syncStatus.consecutiveFailures > 0) return 'degraded';
  if (!entry.syncStatus.available) return 'standby';
  return 'healthy';
}

export function TasksView(props: TasksViewProps): JSX.Element {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [history, setHistory] = useState<TaskRunRecord[]>([]);
  const [openclawJobs, setOpenclawJobs] = useState<OpenClawCronJob[]>([]);
  const [openclawSyncStatus, setOpenclawSyncStatus] = useState<OpenClawSyncStatus | null>(null);
  const [openclawHealth, setOpenclawHealth] = useState<OpenClawHealthCheck | null>(null);
  const openclawTargets = props.openclawTargets.entries;
  const refreshTargets = props.openclawTargets.refresh;
  const [selectedTargetId, setSelectedTargetId] = useState<string | null>(null);
  const [snapshots, setSnapshots] = useState<TaskSnapshot[]>([]);
  const [filter, setFilter] = useState<TaskFilter>(
    props.initialFilter === 'openclaw' ? 'openclaw' : 'all'
  );
  const [showCreate, setShowCreate] = useState(false);
  const [showAddTarget, setShowAddTarget] = useState(false);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const sseConnectedRef = useRef(false);
  const fetchTasksRef = useRef<(() => Promise<void>) | null>(null);
  const fetchHistoryRef = useRef<(() => Promise<void>) | null>(null);
  const fetchOpenClawJobsRef = useRef<(() => Promise<void>) | null>(null);
  const fetchControllersRef = useRef<{
    tasks: AbortController | null;
    history: AbortController | null;
    openclawJobs: AbortController | null;
  }>({
    tasks: null,
    history: null,
    openclawJobs: null,
  });
  const fetchVersionsRef = useRef({
    tasks: 0,
    history: 0,
    openclawJobs: 0,
  });

  const isConnected = props.status === 'connected' || props.status === 'degraded';
  const headers = useMemo(() => authHeaders(props.token), [props.token]);

  useEffect(() => {
    if (props.initialFilter === 'openclaw') {
      setFilter('openclaw');
    }
  }, [props.initialFilter]);

  const fetchTasks = useCallback(async () => {
    if (!isConnected) return;
    const requestVersion = ++fetchVersionsRef.current.tasks;
    fetchControllersRef.current.tasks?.abort();
    const { controller, timeoutId } = createTimedAbortController(10_000);
    fetchControllersRef.current.tasks = controller;
    try {
      const res = await fetch(`${props.baseUrl}/tasks`, { headers, signal: controller.signal });
      if (!res.ok || controller.signal.aborted) return;
      const data = (await res.json()) as ScheduledTask[];
      if (!controller.signal.aborted && requestVersion === fetchVersionsRef.current.tasks) {
        setTasks(data);
      }
    } catch {
      /* connection lost */
    } finally {
      clearTimeout(timeoutId);
      if (fetchControllersRef.current.tasks === controller) {
        fetchControllersRef.current.tasks = null;
      }
    }
  }, [props.baseUrl, isConnected, headers]);

  const fetchHistory = useCallback(async () => {
    if (!isConnected) return;
    const requestVersion = ++fetchVersionsRef.current.history;
    fetchControllersRef.current.history?.abort();
    const { controller, timeoutId } = createTimedAbortController(10_000);
    fetchControllersRef.current.history = controller;
    try {
      const res = await fetch(`${props.baseUrl}/tasks/history`, {
        headers,
        signal: controller.signal,
      });
      if (!res.ok || controller.signal.aborted) return;
      const data = (await res.json()) as TaskRunRecord[];
      if (!controller.signal.aborted && requestVersion === fetchVersionsRef.current.history) {
        setHistory(data);
      }
    } catch {
      /* connection lost */
    } finally {
      clearTimeout(timeoutId);
      if (fetchControllersRef.current.history === controller) {
        fetchControllersRef.current.history = null;
      }
    }
  }, [props.baseUrl, isConnected, headers]);

  const fetchOpenClawJobs = useCallback(async () => {
    if (!isConnected) return;
    const requestVersion = ++fetchVersionsRef.current.openclawJobs;
    fetchControllersRef.current.openclawJobs?.abort();
    const { controller, timeoutId } = createTimedAbortController(10_000);
    fetchControllersRef.current.openclawJobs = controller;
    const jobsUrl = selectedTargetId
      ? `${props.baseUrl}/openclaw/targets/${selectedTargetId}/jobs`
      : `${props.baseUrl}/openclaw/cron/jobs`;
    try {
      const res = await fetch(jobsUrl, { headers, signal: controller.signal });
      if (!res.ok || controller.signal.aborted) return;
      const data = (await res.json()) as {
        available: boolean;
        jobs: OpenClawCronJob[];
        syncStatus?: OpenClawSyncStatus;
      };
      if (!controller.signal.aborted && requestVersion === fetchVersionsRef.current.openclawJobs) {
        setOpenclawJobs(data.jobs);
        setOpenclawSyncStatus(data.syncStatus ?? null);
      }
    } catch {
      /* connection lost */
    } finally {
      clearTimeout(timeoutId);
      if (fetchControllersRef.current.openclawJobs === controller) {
        fetchControllersRef.current.openclawJobs = null;
      }
    }
  }, [props.baseUrl, isConnected, headers, selectedTargetId]);

  useEffect(() => {
    if (openclawTargets.length > 0 && !selectedTargetId) {
      setSelectedTargetId(openclawTargets[0]!.target.id);
    }
  }, [openclawTargets, selectedTargetId]);

  const fetchOpenClawHealth = useCallback(async () => {
    if (!isConnected) return;
    const healthUrl = selectedTargetId
      ? `${props.baseUrl}/openclaw/targets/${selectedTargetId}/health`
      : `${props.baseUrl}/openclaw/health`;
    try {
      const res = await fetch(healthUrl, { headers, signal: AbortSignal.timeout(8_000) });
      if (!res.ok) return;
      const data = (await res.json()) as OpenClawHealthCheck;
      setOpenclawHealth(data);
    } catch {
      /* connection lost */
    }
  }, [props.baseUrl, isConnected, headers, selectedTargetId]);

  const fetchSnapshots = useCallback(async () => {
    if (!isConnected) return;
    try {
      const res = await fetch(`${props.baseUrl}/tasks/snapshots?limit=10`, {
        headers,
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) setSnapshots((await res.json()) as TaskSnapshot[]);
    } catch {
      /* connection lost */
    }
  }, [props.baseUrl, isConnected, headers]);

  useEffect(() => {
    fetchTasksRef.current = fetchTasks;
    fetchHistoryRef.current = fetchHistory;
  }, [fetchTasks, fetchHistory]);

  useEffect(() => {
    fetchOpenClawJobsRef.current = fetchOpenClawJobs;
    return () => {
      if (fetchOpenClawJobsRef.current === fetchOpenClawJobs) {
        fetchOpenClawJobsRef.current = null;
      }
    };
  }, [fetchOpenClawJobs]);

  useEffect(() => {
    if (!isConnected) return;

    const abortController = new AbortController();
    sseConnectedRef.current = false;

    const sseHeaders: Record<string, string> = { Accept: 'text/event-stream' };
    if (props.token) sseHeaders['Authorization'] = `Bearer ${props.token}`;

    const connectSse = async (): Promise<void> => {
      try {
        const res = await fetch(`${props.baseUrl}/tasks/events`, {
          headers: sseHeaders,
          signal: abortController.signal,
        }).catch(() => null);

        if (abortController.signal.aborted || !res?.ok || !res.body) return;
        sseConnectedRef.current = true;

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (!abortController.signal.aborted) {
          const { done, value } = await reader.read();
          if (done || abortController.signal.aborted) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          let eventType = '';
          let eventData = '';

          for (const line of lines) {
            if (line.startsWith('event:')) {
              eventType = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              eventData += line.slice(5).trim();
            } else if (line === '') {
              if (eventType === 'task') {
                if (fetchTasksRef.current) void fetchTasksRef.current();
                if (fetchHistoryRef.current) void fetchHistoryRef.current();
              } else if (eventType === 'openclaw-sync' && eventData) {
                try {
                  const nextStatus = JSON.parse(eventData) as OpenClawSyncStatus;
                  setOpenclawSyncStatus((previous) => {
                    const shouldRefresh =
                      !previous ||
                      previous.available !== nextStatus.available ||
                      previous.consecutiveFailures !== nextStatus.consecutiveFailures ||
                      previous.lastSuccessfulSyncAt !== nextStatus.lastSuccessfulSyncAt ||
                      previous.lastError !== nextStatus.lastError ||
                      previous.stale !== nextStatus.stale;
                    if (shouldRefresh) {
                      void fetchOpenClawJobsRef.current?.();
                      void fetchOpenClawHealth();
                    }
                    return nextStatus;
                  });
                } catch {
                  /* ignore malformed SSE payload */
                }
              }
              eventType = '';
              eventData = '';
            }
          }
        }
      } catch {
        if (!abortController.signal.aborted) sseConnectedRef.current = false;
      }
    };

    void connectSse();

    return () => {
      abortController.abort();
      sseConnectedRef.current = false;
    };
  }, [props.baseUrl, isConnected, fetchOpenClawHealth, props.token]);

  useEffect(() => {
    if (!isConnected) return;
    Promise.allSettled([
      fetchTasks(),
      fetchHistory(),
      fetchOpenClawJobs(),
      fetchOpenClawHealth(),
    ]).then(() => {
      setInitialLoading(false);
    });
    const iv = setInterval(() => {
      if (!sseConnectedRef.current) {
        void fetchTasks();
        void fetchHistory();
        void fetchOpenClawJobs();
        void fetchOpenClawHealth();
      }
    }, 30_000);
    return () => {
      clearInterval(iv);
    };
  }, [isConnected, fetchTasks, fetchHistory, fetchOpenClawJobs, fetchOpenClawHealth]);

  useEffect(() => {
    if (!isConnected) return;
    void fetchOpenClawJobs();
    void fetchOpenClawHealth();
  }, [isConnected, selectedTargetId, fetchOpenClawJobs, fetchOpenClawHealth]);

  useEffect(
    () => () => {
      fetchControllersRef.current.tasks?.abort();
      fetchControllersRef.current.history?.abort();
      fetchControllersRef.current.openclawJobs?.abort();
      runAbortRef.current?.abort();
    },
    []
  );

  const handleAddTarget = useCallback(
    async (input: {
      label: string;
      type: 'local' | 'remote';
      openclawDir: string;
      pollIntervalMs: number;
    }) => {
      setError(null);
      try {
        const res = await fetch(`${props.baseUrl}/openclaw/targets`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as Record<string, string> | null;
          setError(body?.error ?? `Add target failed: HTTP ${res.status}`);
          return;
        }
        const target = (await res.json()) as OpenClawTarget;
        setSelectedTargetId(target.id);
        setShowAddTarget(false);
        await refreshTargets();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Add target failed');
      }
    },
    [props.baseUrl, headers, refreshTargets]
  );

  const handleDeleteTarget = useCallback(
    async (targetId: string) => {
      if (!window.confirm('Remove this OpenClaw target? Sync will stop.')) return;
      setError(null);
      try {
        const res = await fetch(`${props.baseUrl}/openclaw/targets/${targetId}`, {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          setError(`Delete target failed: HTTP ${res.status}`);
          return;
        }
        if (selectedTargetId === targetId) {
          setSelectedTargetId(null);
        }
        await refreshTargets();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Delete target failed');
      }
    },
    [props.baseUrl, headers, selectedTargetId, refreshTargets]
  );

  const handleToggleTarget = useCallback(
    async (targetId: string, enabled: boolean) => {
      setError(null);
      try {
        const res = await fetch(`${props.baseUrl}/openclaw/targets/${targetId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ enabled }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) setError(`Toggle target failed: HTTP ${res.status}`);
        await refreshTargets();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Toggle failed');
      }
    },
    [props.baseUrl, headers, refreshTargets]
  );

  const runAbortRef = useRef<AbortController | null>(null);

  const handleRunNow = useCallback(
    async (taskId: string) => {
      runAbortRef.current?.abort();
      const controller = new AbortController();
      runAbortRef.current = controller;
      setRunningTaskId(taskId);
      setError(null);
      try {
        const res = await fetch(`${props.baseUrl}/tasks/${taskId}/run`, {
          method: 'POST',
          headers,
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        if (!res.ok) setError(`Run failed: HTTP ${res.status}`);
        await fetchTasks();
        await fetchHistory();
      } catch (err) {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Run failed');
      }
      if (!controller.signal.aborted) setRunningTaskId(null);
    },
    [props.baseUrl, headers, fetchTasks, fetchHistory]
  );

  const handleToggle = useCallback(
    async (task: ScheduledTask) => {
      setError(null);
      const newStatus = task.status === 'enabled' ? 'disabled' : 'enabled';
      try {
        const res = await fetch(`${props.baseUrl}/tasks/${task.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify({ status: newStatus }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) setError(`Toggle failed: HTTP ${res.status}`);
        await fetchTasks();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Toggle failed');
      }
    },
    [props.baseUrl, headers, fetchTasks]
  );

  const handleDelete = useCallback(
    async (taskId: string) => {
      if (!window.confirm('Delete this task? This cannot be undone.')) return;
      setError(null);
      try {
        const res = await fetch(`${props.baseUrl}/tasks/${taskId}`, {
          method: 'DELETE',
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) setError(`Delete failed: HTTP ${res.status}`);
        await fetchTasks();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Delete failed');
      }
    },
    [props.baseUrl, headers, fetchTasks]
  );

  const handleCreate = useCallback(
    async (input: Record<string, unknown>) => {
      setError(null);
      try {
        const res = await fetch(`${props.baseUrl}/tasks`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as Record<string, string> | null;
          setError(body?.error ?? `Create failed: HTTP ${res.status}`);
          return;
        }
        setShowCreate(false);
        await fetchTasks();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Create failed');
      }
    },
    [props.baseUrl, headers, fetchTasks]
  );

  const handleRollback = useCallback(
    async (snapshotId: string) => {
      if (!window.confirm('Rollback to this snapshot? Current tasks will be replaced.')) return;
      setError(null);
      try {
        const res = await fetch(`${props.baseUrl}/tasks/rollback/${snapshotId}`, {
          method: 'POST',
          headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) setError(`Rollback failed: HTTP ${res.status}`);
        await fetchTasks();
        await fetchSnapshots();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Rollback failed');
      }
    },
    [props.baseUrl, headers, fetchTasks, fetchSnapshots]
  );

  const counts = useMemo(
    () => ({
      all: tasks.length,
      enabled: tasks.filter((t) => t.status === 'enabled').length,
      disabled: tasks.filter((t) => t.status === 'disabled').length,
      error: tasks.filter((t) => t.status === 'error').length,
    }),
    [tasks]
  );

  const openclawJobCount = useMemo(() => {
    let total = 0;
    for (const entry of openclawTargets) {
      total += entry.syncStatus.jobsCount;
    }
    return total > 0 ? total : openclawJobs.length;
  }, [openclawTargets, openclawJobs.length]);

  const tabs: ReadonlyArray<FilterTab<TaskFilter>> = useMemo(
    () => [
      { id: 'all', label: 'All', count: counts.all },
      { id: 'enabled', label: 'Active', count: counts.enabled },
      { id: 'disabled', label: 'Paused', count: counts.disabled },
      { id: 'error', label: 'Error', count: counts.error },
      { id: 'openclaw', label: 'OpenClaw', count: openclawJobCount },
    ],
    [counts, openclawJobCount]
  );

  const filtered = useMemo(() => {
    if (filter === 'openclaw') return [];
    return tasks.filter((t) => filter === 'all' || t.status === filter);
  }, [tasks, filter]);

  const recentHistory = useMemo(() => history.slice(-RECENT_HISTORY_LIMIT).reverse(), [history]);

  if (!isConnected) {
    return (
      <section className="view-panel">
        <div className="view-header">
          <h2 className="view-title">Scheduled Tasks</h2>
        </div>
        <div className="empty-state">
          <div className="empty-state-icon">
            <IconClock width={28} height={28} />
          </div>
          <p>Connect to the control plane to manage scheduled tasks.</p>
        </div>
      </section>
    );
  }

  if (initialLoading && tasks.length === 0) {
    return (
      <section className="view-panel">
        <div className="view-header">
          <h2 className="view-title">Scheduled Tasks</h2>
        </div>
        <div className="empty-state">
          <span className="mini-spinner" style={{ width: 20, height: 20 }} />
          <p style={{ marginTop: 8, color: 'var(--text-muted)' }}>Loading tasks…</p>
        </div>
      </section>
    );
  }

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Scheduled Tasks</h2>
        <FilterTabs tabs={tabs} active={filter} onChange={setFilter} />
        <div className="actions" style={{ marginLeft: 'auto' }}>
          {filter === 'openclaw' ? (
            <button
              className="btn-primary"
              onClick={() => {
                setShowAddTarget(!showAddTarget);
              }}
            >
              {showAddTarget ? 'Cancel' : '+ Target'}
            </button>
          ) : (
            <>
              <button
                className="btn-secondary"
                onClick={() => {
                  setShowSnapshots(!showSnapshots);
                  if (!showSnapshots) void fetchSnapshots();
                }}
              >
                {showSnapshots ? 'Close' : 'Snapshots'}
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  setShowCreate(!showCreate);
                }}
              >
                {showCreate ? 'Cancel' : '+ New'}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Stats Bar */}
      <TaskStatsBar tasks={tasks} targets={openclawTargets} filter={filter} />

      {error ? (
        <div className="task-error-banner" role="alert">
          <span>{error}</span>
          <button
            className="btn-ghost"
            style={{ marginLeft: 'auto', height: 24, padding: '0 8px' }}
            onClick={() => {
              setError(null);
            }}
          >
            Dismiss
          </button>
        </div>
      ) : null}

      {showSnapshots ? <SnapshotPanel snapshots={snapshots} onRollback={handleRollback} /> : null}
      {showCreate ? <CreateTaskForm onCreate={handleCreate} openclawJobs={openclawJobs} /> : null}

      {filter === 'openclaw' ? (
        <>
          {showAddTarget ? (
            <AddTargetForm
              onAdd={handleAddTarget}
              onCancel={() => {
                setShowAddTarget(false);
              }}
            />
          ) : null}
          <TargetCardsBar
            targets={openclawTargets}
            selectedTargetId={selectedTargetId}
            onSelect={setSelectedTargetId}
            onToggle={handleToggleTarget}
            onDelete={handleDeleteTarget}
          />
          <OpenClawJobsPanel
            jobs={openclawJobs}
            syncStatus={openclawSyncStatus}
            health={openclawHealth}
            baseUrl={props.baseUrl}
            headers={headers}
            selectedTargetId={selectedTargetId}
          />
        </>
      ) : (
        <TaskTable
          tasks={filtered}
          runningTaskId={runningTaskId}
          onRunNow={handleRunNow}
          onToggle={handleToggle}
          onDelete={handleDelete}
        />
      )}

      {filter !== 'openclaw' && recentHistory.length > 0 ? (
        <RunHistoryPanel history={recentHistory} tasks={tasks} />
      ) : null}
    </section>
  );
}

interface TaskStatsBarProps {
  readonly tasks: readonly ScheduledTask[];
  readonly targets: readonly TargetSyncStatusEntry[];
  readonly filter: TaskFilter;
}

function TaskStatsBar(props: TaskStatsBarProps): JSX.Element {
  const activeCount = props.tasks.filter((t) => t.status === 'enabled').length;
  const errorCount = props.tasks.filter(
    (t) => t.status === 'error' || t.consecutiveErrors > 0
  ).length;
  const totalRuns = props.tasks.reduce((sum, t) => sum + t.totalRuns, 0);
  const healthyTargets = props.targets.filter(
    (e) => e.syncStatus.available && e.syncStatus.consecutiveFailures === 0
  ).length;
  const totalJobs = props.targets.reduce((sum, e) => sum + e.syncStatus.jobsCount, 0);

  if (props.filter === 'openclaw') {
    return (
      <div className="task-stats-bar">
        <div className="task-stat">
          <span className="task-stat-value" data-accent="cyan">
            {props.targets.length}
          </span>
          <span className="task-stat-label">Targets</span>
        </div>
        <div className="task-stat">
          <span className="task-stat-value" data-accent="green">
            {healthyTargets}
          </span>
          <span className="task-stat-label">Healthy</span>
        </div>
        <div className="task-stat">
          <span className="task-stat-value">{totalJobs}</span>
          <span className="task-stat-label">Total Jobs</span>
        </div>
        {props.targets.length - healthyTargets > 0 ? (
          <div className="task-stat">
            <span className="task-stat-value" data-accent="red">
              {props.targets.length - healthyTargets}
            </span>
            <span className="task-stat-label">Issues</span>
          </div>
        ) : null}
      </div>
    );
  }

  return (
    <div className="task-stats-bar">
      <div className="task-stat">
        <span className="task-stat-value" data-accent="cyan">
          {props.tasks.length}
        </span>
        <span className="task-stat-label">Total</span>
      </div>
      <div className="task-stat">
        <span className="task-stat-value" data-accent="green">
          {activeCount}
        </span>
        <span className="task-stat-label">Active</span>
      </div>
      <div className="task-stat">
        <span className="task-stat-value">{totalRuns}</span>
        <span className="task-stat-label">Runs</span>
      </div>
      {errorCount > 0 ? (
        <div className="task-stat">
          <span className="task-stat-value" data-accent="red">
            {errorCount}
          </span>
          <span className="task-stat-label">Errors</span>
        </div>
      ) : null}
    </div>
  );
}

interface TargetCardsBarProps {
  readonly targets: readonly TargetSyncStatusEntry[];
  readonly selectedTargetId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onToggle: (id: string, enabled: boolean) => void;
  readonly onDelete: (id: string) => void;
}

function TargetCardsBar(props: TargetCardsBarProps): JSX.Element {
  if (props.targets.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">
          <IconClock width={28} height={28} />
        </div>
        <p>No OpenClaw targets configured.</p>
        <p style={{ fontSize: 11, marginTop: 4 }}>
          Click "+ Target" to add a local or remote OpenClaw instance.
        </p>
      </div>
    );
  }

  return (
    <div className="target-cards-grid">
      {props.targets.map((entry) => {
        const isSelected = entry.target.id === props.selectedTargetId;
        const tone = targetHealthTone(entry);
        return (
          <div
            key={entry.target.id}
            className={`target-card ${isSelected ? 'target-card-selected' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => {
              props.onSelect(entry.target.id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                props.onSelect(entry.target.id);
              }
            }}
          >
            <div className="target-card-header">
              <div className="target-card-title">
                <span className="target-card-label">{entry.target.label}</span>
                <span className={`badge ${tone}`} style={{ fontSize: 10 }}>
                  {targetHealthLabel(entry)}
                </span>
              </div>
              <span
                className={`badge ${entry.target.type === 'remote' ? 'tone-neutral' : 'tone-muted'}`}
                style={{ fontSize: 9 }}
              >
                {entry.target.type}
              </span>
            </div>
            <div className="target-card-meta">
              <span className="target-card-path" title={entry.target.openclawDir}>
                {entry.target.openclawDir}
              </span>
              <span className="target-card-stat">
                {entry.syncStatus.available ? (
                  <>
                    <span style={{ color: 'var(--green)', fontWeight: 600 }}>
                      {entry.syncStatus.jobsCount}
                    </span>{' '}
                    jobs
                  </>
                ) : (
                  'standby'
                )}
                {entry.syncStatus.lastSuccessfulSyncAt ? (
                  <> &middot; sync {formatRelativeTime(entry.syncStatus.lastSuccessfulSyncAt)}</>
                ) : null}
              </span>
              <span className="target-card-stat">
                Polling every {formatPollInterval(entry.target.pollIntervalMs)}
                {' · '}
                added {formatRelativeTime(entry.target.createdAt)}
              </span>
              <span className="target-card-stat">
                {entry.syncStatus.lastAttemptAt
                  ? `last attempt ${formatRelativeTime(entry.syncStatus.lastAttemptAt)}`
                  : 'no sync attempt yet'}
              </span>
            </div>
            <div
              className="target-card-actions"
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <button
                className="btn-ghost"
                style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                onClick={() => {
                  props.onToggle(entry.target.id, !entry.target.enabled);
                }}
              >
                {entry.target.enabled ? 'Pause' : 'Resume'}
              </button>
              {props.targets.length > 1 ? (
                <button
                  className="btn-ghost"
                  style={{ height: 22, padding: '0 8px', fontSize: 11, color: 'var(--red)' }}
                  onClick={() => {
                    props.onDelete(entry.target.id);
                  }}
                >
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}

interface AddTargetFormProps {
  readonly onAdd: (input: {
    label: string;
    type: 'local' | 'remote';
    openclawDir: string;
    pollIntervalMs: number;
  }) => void;
  readonly onCancel: () => void;
}

function AddTargetForm(props: AddTargetFormProps): JSX.Element {
  const [label, setLabel] = useState('');
  const [type, setType] = useState<'local' | 'remote'>('local');
  const [dir, setDir] = useState('~/.openclaw');
  const [interval, setInterval] = useState('30');

  const canSubmit = label.trim().length > 0 && dir.trim().length > 0;

  return (
    <div className="panel" style={{ padding: 20 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 14,
        }}
      >
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600 }}>Add OpenClaw Target</h3>
      </div>
      <div className="dialog-form-grid" style={{ marginTop: 0 }}>
        <div className="dialog-form-row cols-2">
          <div className="dialog-field">
            <label className="dialog-field-label">Label</label>
            <input
              value={label}
              onChange={(e) => {
                setLabel(e.target.value);
              }}
              placeholder="e.g. Production VPS"
            />
          </div>
          <div className="dialog-field">
            <label className="dialog-field-label">Type</label>
            <select
              value={type}
              onChange={(e) => {
                setType(e.target.value as 'local' | 'remote');
              }}
            >
              <option value="local">Local</option>
              <option value="remote">Remote</option>
            </select>
          </div>
        </div>
        <div className="dialog-form-row cols-2">
          <div className="dialog-field">
            <label className="dialog-field-label">OpenClaw Directory</label>
            <input
              value={dir}
              onChange={(e) => {
                setDir(e.target.value);
              }}
              placeholder="/home/user/.openclaw"
            />
          </div>
          <div className="dialog-field">
            <label className="dialog-field-label">Poll Interval (seconds)</label>
            <input
              type="number"
              min="5"
              value={interval}
              onChange={(e) => {
                setInterval(e.target.value);
              }}
            />
          </div>
        </div>
      </div>
      <div className="actions" style={{ marginTop: 16 }}>
        <button
          className="btn-primary"
          disabled={!canSubmit}
          onClick={() => {
            props.onAdd({
              label: label.trim(),
              type,
              openclawDir: dir.trim(),
              pollIntervalMs: Math.max(5, parseInt(interval, 10) || 30) * 1000,
            });
          }}
        >
          Add Target
        </button>
        <button className="btn-secondary" onClick={props.onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

interface TaskTableProps {
  readonly tasks: readonly ScheduledTask[];
  readonly runningTaskId: string | null;
  readonly onRunNow: (id: string) => void;
  readonly onToggle: (task: ScheduledTask) => void;
  readonly onDelete: (id: string) => void;
}

function TaskTable(props: TaskTableProps): JSX.Element {
  if (props.tasks.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">
          <IconClock width={28} height={28} />
        </div>
        <p>No scheduled tasks yet. Click "+ New" to create one.</p>
      </div>
    );
  }

  return (
    <div className="panel" style={{ padding: 0 }}>
      <div className="table-scroll" style={{ maxHeight: 420 }}>
        <table className="data-table compact">
          <thead>
            <tr>
              <th>Name</th>
              <th>Action</th>
              <th>Schedule</th>
              <th>Status</th>
              <th>Next Run</th>
              <th>Last Run</th>
              <th>Runs</th>
              <th style={{ width: 140 }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {props.tasks.map((task) => (
              <tr key={task.id}>
                <td>
                  <span className="mono" title={task.id}>
                    {task.name}
                  </span>
                  {task.description ? (
                    <span
                      className="tone-muted"
                      style={{ display: 'block', fontSize: 11, marginTop: 2 }}
                    >
                      {task.description}
                    </span>
                  ) : null}
                </td>
                <td>
                  <span className={`badge tone-neutral`}>{actionLabel(task.action.action)}</span>
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {formatSchedule(task.schedule)}
                </td>
                <td>
                  <span className={`badge ${statusTone(task.status)}`}>{task.status}</span>
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {formatNextRun(task.nextRunAtMs)}
                </td>
                <td>
                  {task.lastRunAt ? (
                    <>
                      <span className={`badge ${statusTone(task.lastRunStatus ?? 'error')}`}>
                        {task.lastRunStatus ?? '?'}
                      </span>
                      <span className="tone-muted" style={{ marginLeft: 6, fontSize: 11 }}>
                        {formatRelativeTime(task.lastRunAt)}
                      </span>
                    </>
                  ) : (
                    <span className="tone-muted">—</span>
                  )}
                </td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {task.totalRuns}
                  {task.consecutiveErrors > 0 ? (
                    <span style={{ color: 'var(--red)', marginLeft: 4 }}>
                      ({task.consecutiveErrors}err)
                    </span>
                  ) : null}
                </td>
                <td>
                  <div className="actions">
                    <button
                      className="btn-secondary"
                      disabled={props.runningTaskId === task.id}
                      onClick={() => {
                        props.onRunNow(task.id);
                      }}
                    >
                      {props.runningTaskId === task.id ? <span className="mini-spinner" /> : 'Run'}
                    </button>
                    <button
                      className="btn-secondary"
                      onClick={() => {
                        props.onToggle(task);
                      }}
                    >
                      {task.status === 'enabled' ? 'Pause' : 'Start'}
                    </button>
                    <button
                      className="btn-danger"
                      onClick={() => {
                        props.onDelete(task.id);
                      }}
                    >
                      Del
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface RunGroup {
  taskId: string;
  taskName: string;
  latestRun: TaskRunRecord;
  count: number;
  okCount: number;
  errCount: number;
  runs: TaskRunRecord[];
}

interface RunHistoryPanelProps {
  readonly history: readonly TaskRunRecord[];
  readonly tasks: readonly ScheduledTask[];
}

function RunHistoryPanel(props: RunHistoryPanelProps): JSX.Element {
  const [filterTaskId, setFilterTaskId] = useState<string | null>(null);
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);

  const taskNameMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of props.tasks) m.set(t.id, t.name);
    return m;
  }, [props.tasks]);

  const groups = useMemo((): RunGroup[] => {
    const map = new Map<string, RunGroup>();
    for (const r of props.history) {
      const existing = map.get(r.taskId);
      if (existing) {
        existing.count++;
        if (r.status === 'ok') existing.okCount++;
        else existing.errCount++;
        existing.runs.push(r);
      } else {
        map.set(r.taskId, {
          taskId: r.taskId,
          taskName: taskNameMap.get(r.taskId) ?? r.taskId,
          latestRun: r,
          count: 1,
          okCount: r.status === 'ok' ? 1 : 0,
          errCount: r.status !== 'ok' ? 1 : 0,
          runs: [r],
        });
      }
    }
    return [...map.values()]
      .map((group) => ({
        ...group,
        runs: [...group.runs].sort(
          (a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime()
        ),
      }))
      .sort(
        (a, b) =>
          new Date(b.latestRun.startedAt).getTime() - new Date(a.latestRun.startedAt).getTime()
      );
  }, [props.history, taskNameMap]);

  const uniqueTaskIds = useMemo(() => {
    const seen = new Set<string>();
    for (const r of props.history) seen.add(r.taskId);
    return [...seen];
  }, [props.history]);

  const filteredHistory = useMemo(() => {
    if (!filterTaskId) return [];
    return props.history
      .filter((r) => r.taskId === filterTaskId)
      .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime());
  }, [props.history, filterTaskId]);

  if (filterTaskId) {
    return (
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <h3 className="settings-section-title" style={{ margin: 0, border: 0, padding: 0 }}>
            Run History
          </h3>
          <span className="badge tone-neutral">
            {taskNameMap.get(filterTaskId) ?? filterTaskId}
          </span>
          <button
            className="btn-ghost"
            style={{ fontSize: 11 }}
            onClick={() => {
              setFilterTaskId(null);
            }}
          >
            Clear filter
          </button>
        </div>
        <div className="panel" style={{ padding: 0 }}>
          <div className="table-scroll" style={{ maxHeight: 260 }}>
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Started</th>
                  <th>Duration</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {filteredHistory.length === 0 ? (
                  <tr>
                    <td colSpan={4} style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                      No runs found for this task yet.
                    </td>
                  </tr>
                ) : null}
                {filteredHistory.map((r) => (
                  <tr key={r.runId}>
                    <td>
                      <span className={`badge ${statusTone(r.status)}`}>{r.status}</span>
                    </td>
                    <td style={{ fontSize: 12 }}>{formatRelativeTime(r.startedAt)}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {formatDurationMs(r.durationMs)}
                    </td>
                    <td
                      title={r.error ?? ''}
                      style={{
                        fontSize: 11,
                        maxWidth: 240,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        color: r.error ? 'var(--red)' : undefined,
                      }}
                    >
                      {r.error ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <h3 className="settings-section-title" style={{ margin: 0, border: 0, padding: 0 }}>
          Run History
        </h3>
        {uniqueTaskIds.length > 1 ? (
          <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Click a row to filter</span>
        ) : null}
      </div>
      <div className="panel" style={{ padding: 0 }}>
        <div className="table-scroll" style={{ maxHeight: 260 }}>
          <table className="data-table compact">
            <thead>
              <tr>
                <th>Task</th>
                <th>Last Status</th>
                <th>Last Run</th>
                <th>Runs</th>
                <th>Success Rate</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g) => (
                <Fragment key={g.taskId}>
                  <tr
                    className="clickable-row"
                    role="button"
                    tabIndex={0}
                    aria-expanded={expandedGroup === g.taskId}
                    onClick={() => {
                      if (g.count <= 1) {
                        setFilterTaskId(g.taskId);
                        return;
                      }
                      setExpandedGroup(expandedGroup === g.taskId ? null : g.taskId);
                    }}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault();
                        if (g.count <= 1) {
                          setFilterTaskId(g.taskId);
                          return;
                        }
                        setExpandedGroup(expandedGroup === g.taskId ? null : g.taskId);
                      }
                    }}
                  >
                    <td>
                      {g.count > 1 ? (
                        <span style={{ marginRight: 4, fontSize: 10, color: 'var(--text-dim)' }}>
                          {expandedGroup === g.taskId ? '▾' : '▸'}
                        </span>
                      ) : null}
                      <span className="mono" style={{ fontSize: 12 }}>
                        {g.taskName}
                      </span>
                    </td>
                    <td>
                      <span className={`badge ${statusTone(g.latestRun.status)}`}>
                        {g.latestRun.status}
                      </span>
                    </td>
                    <td style={{ fontSize: 12 }}>{formatRelativeTime(g.latestRun.startedAt)}</td>
                    <td className="mono" style={{ fontSize: 12 }}>
                      {g.count}
                    </td>
                    <td>
                      {g.count > 0 ? (
                        <span style={{ fontSize: 12 }} title={`${g.okCount}/${g.count} successful`}>
                          <span style={{ color: 'var(--green)' }}>
                            {Math.round((g.okCount / g.count) * 100)}%
                          </span>
                          {g.errCount > 0 ? (
                            <span style={{ color: 'var(--red)', marginLeft: 4 }}>
                              / {g.errCount} err
                            </span>
                          ) : null}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                  </tr>
                  {expandedGroup === g.taskId ? (
                    <tr>
                      <td colSpan={5} style={{ padding: 0, background: 'var(--bg-elevated)' }}>
                        <div style={{ padding: '4px 0' }}>
                          <table
                            className="data-table compact"
                            style={{ margin: 0, background: 'transparent' }}
                          >
                            <tbody>
                              {g.runs.slice(0, HISTORY_GROUP_PREVIEW_LIMIT).map((r) => (
                                <tr key={r.runId}>
                                  <td style={{ paddingLeft: 28, fontSize: 12, width: '30%' }}>
                                    <span className={`badge ${statusTone(r.status)}`}>
                                      {r.status}
                                    </span>
                                  </td>
                                  <td style={{ fontSize: 12 }}>
                                    {formatRelativeTime(r.startedAt)}
                                  </td>
                                  <td className="mono" style={{ fontSize: 12 }}>
                                    {formatDurationMs(r.durationMs)}
                                  </td>
                                  <td
                                    title={r.error ?? ''}
                                    style={{
                                      fontSize: 11,
                                      color: r.error ? 'var(--red)' : 'var(--text-dim)',
                                    }}
                                  >
                                    {r.error ?? '—'}
                                  </td>
                                </tr>
                              ))}
                              {g.runs.length > HISTORY_GROUP_PREVIEW_LIMIT ? (
                                <tr>
                                  <td
                                    colSpan={4}
                                    style={{
                                      paddingLeft: 28,
                                      fontSize: 11,
                                      color: 'var(--text-dim)',
                                    }}
                                  >
                                    <button
                                      className="btn-ghost"
                                      style={{ fontSize: 11, height: 24 }}
                                      onClick={() => {
                                        setFilterTaskId(g.taskId);
                                      }}
                                    >
                                      View all {g.runs.length} runs
                                    </button>
                                  </td>
                                </tr>
                              ) : null}
                            </tbody>
                          </table>
                        </div>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

interface OpenClawJobsPanelProps {
  readonly jobs: readonly OpenClawCronJob[];
  readonly syncStatus: OpenClawSyncStatus | null;
  readonly health: OpenClawHealthCheck | null;
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly selectedTargetId: string | null;
}

function OpenClawJobsPanel(props: OpenClawJobsPanelProps): JSX.Element {
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [runs, setRuns] = useState<OpenClawRunRecord[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const issueChecks = props.health?.checks.filter((check) => check.status !== 'ok') ?? [];

  const fetchRuns = useCallback(
    async (jobId: string) => {
      setLoadingRuns(true);
      try {
        const runsUrl = props.selectedTargetId
          ? `${props.baseUrl}/openclaw/targets/${props.selectedTargetId}/runs/${jobId}`
          : `${props.baseUrl}/openclaw/cron/runs/${jobId}`;
        const res = await fetch(runsUrl, {
          headers: props.headers,
          signal: AbortSignal.timeout(10_000),
        });
        if (res.ok) {
          const data = (await res.json()) as { runs: OpenClawRunRecord[] };
          setRuns(data.runs);
        }
      } catch {
        /* ok */
      }
      setLoadingRuns(false);
    },
    [props.baseUrl, props.headers, props.selectedTargetId]
  );

  const toggleExpand = useCallback(
    (jobId: string) => {
      if (expandedJobId === jobId) {
        setExpandedJobId(null);
        setRuns([]);
      } else {
        setExpandedJobId(jobId);
        void fetchRuns(jobId);
      }
    },
    [expandedJobId, fetchRuns]
  );

  if (props.jobs.length === 0) {
    return (
      <div className="panel" style={{ padding: 0 }}>
        {/* Health info header even with 0 jobs */}
        <div className="openclaw-panel-header">
          <span className="badge tone-neutral">OpenClaw Native</span>
          {props.health ? (
            <span className={`badge ${props.health.ok ? 'tone-good' : 'tone-bad'}`}>
              {props.health.ok ? 'healthy' : 'issues'}
            </span>
          ) : null}
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {props.health?.target ? `${props.health.target}/cron/` : '~/.openclaw/cron/'}
          </span>
        </div>
        {issueChecks.length > 0 ? <DoctorChecks checks={issueChecks} /> : null}
        <div style={{ padding: '24px 20px', textAlign: 'center' }}>
          <div style={{ opacity: 0.3, marginBottom: 8 }}>
            <IconClock width={28} height={28} />
          </div>
          <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 13 }}>
            {props.syncStatus?.available
              ? 'No OpenClaw cron jobs found.'
              : 'Waiting for OpenClaw cron directory...'}
          </p>
          <p style={{ margin: '6px 0 0', fontSize: 11, color: 'var(--text-dim)' }}>
            Jobs are managed by the OpenClaw Gateway process.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="panel" style={{ padding: 0 }}>
      <div className="openclaw-panel-header">
        <span className="badge tone-neutral">OpenClaw Native</span>
        {props.health ? (
          <span className={`badge ${props.health.ok ? 'tone-good' : 'tone-bad'}`}>
            {props.health.ok ? 'healthy' : 'issues'}
          </span>
        ) : null}
        {props.syncStatus ? (
          <span
            className={`badge ${props.syncStatus.stale || props.syncStatus.consecutiveFailures > 0 ? 'tone-bad' : 'tone-good'}`}
          >
            {props.syncStatus.stale || props.syncStatus.consecutiveFailures > 0
              ? 'degraded'
              : 'syncing'}
          </span>
        ) : null}
        <span style={{ fontSize: 12, color: 'var(--text-muted)', marginLeft: 'auto' }}>
          {props.syncStatus?.lastSuccessfulSyncAt
            ? `synced ${formatRelativeTime(props.syncStatus.lastSuccessfulSyncAt)}`
            : ''}
          {props.syncStatus?.lastError ? (
            <span
              className="badge tone-bad"
              style={{ marginLeft: 6, fontSize: 10 }}
              title={props.syncStatus.lastError}
            >
              error
            </span>
          ) : null}
        </span>
      </div>
      {issueChecks.length > 0 ? <DoctorChecks checks={issueChecks} /> : null}
      <div className="table-scroll" style={{ maxHeight: 500 }}>
        <table className="data-table compact">
          <thead>
            <tr>
              <th>Job</th>
              <th>Schedule</th>
              <th>Execution</th>
              <th>Delivery</th>
              <th>Status</th>
              <th>Modified</th>
              <th>Last Run</th>
            </tr>
          </thead>
          <tbody>
            {props.jobs.map((job) => (
              <Fragment key={job.jobId}>
                <tr
                  className="clickable-row"
                  role="button"
                  tabIndex={0}
                  aria-expanded={expandedJobId === job.jobId}
                  onClick={() => {
                    toggleExpand(job.jobId);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      toggleExpand(job.jobId);
                    }
                  }}
                >
                  <td>
                    <span style={{ marginRight: 4, fontSize: 10, color: 'var(--text-dim)' }}>
                      {expandedJobId === job.jobId ? '▾' : '▸'}
                    </span>
                    <span className="mono" style={{ fontSize: 12 }}>
                      {job.name ?? job.jobId}
                    </span>
                    {job.name ? (
                      <span
                        className="tone-muted"
                        style={{ display: 'block', fontSize: 10, marginTop: 1 }}
                      >
                        {job.jobId}
                      </span>
                    ) : null}
                  </td>
                  <td className="mono" style={{ fontSize: 12 }}>
                    {formatSchedule(job.schedule)}
                  </td>
                  <td>
                    <span className="badge tone-neutral">{job.execution.style}</span>
                    {job.execution.sessionTag ? (
                      <span
                        className="badge tone-neutral"
                        style={{ marginLeft: 6 }}
                        title="Session tag"
                      >
                        {job.execution.sessionTag}
                      </span>
                    ) : null}
                    {job.execution.agentId ? (
                      <span className="tone-muted" style={{ marginLeft: 6, fontSize: 11 }}>
                        {job.execution.agentId}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <span
                      className={`badge ${job.delivery.mode === 'none' ? 'tone-muted' : 'tone-good'}`}
                    >
                      {job.delivery.mode}
                    </span>
                    {job.delivery.channelId ? (
                      <span
                        className="badge tone-neutral"
                        style={{ marginLeft: 6 }}
                        title={`Channel ID: ${job.delivery.channelId}`}
                      >
                        {job.delivery.channelId}
                      </span>
                    ) : null}
                    {job.delivery.mode === 'webhook' && job.delivery.webhookUrl ? (
                      <span
                        className="tone-muted"
                        style={{ display: 'block', fontSize: 10, marginTop: 2 }}
                        title={`${job.delivery.webhookMethod ?? 'POST'} ${job.delivery.webhookUrl}`}
                      >
                        {job.delivery.webhookMethod ?? 'POST'} webhook
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <span className={`badge ${job.enabled ? 'tone-good' : 'tone-muted'}`}>
                      {job.enabled ? 'active' : 'paused'}
                    </span>
                    {(job.consecutiveErrors ?? 0) > 0 ? (
                      <span className="badge tone-bad" style={{ marginLeft: 6 }}>
                        {job.consecutiveErrors} err
                      </span>
                    ) : null}
                  </td>
                  <td>
                    {job.updatedAt && job.updatedAt !== job.createdAt ? (
                      <span className="tone-muted" style={{ fontSize: 11 }}>
                        {formatRelativeTime(job.updatedAt)}
                      </span>
                    ) : (
                      <span className="tone-muted">—</span>
                    )}
                  </td>
                  <td>
                    {job.lastRunAt ? (
                      <>
                        <span className={`badge ${statusTone(job.lastStatus ?? 'error')}`}>
                          {job.lastStatus ?? '?'}
                        </span>
                        <span className="tone-muted" style={{ marginLeft: 6, fontSize: 11 }}>
                          {formatRelativeTime(job.lastRunAt)}
                        </span>
                      </>
                    ) : (
                      <span className="tone-muted">—</span>
                    )}
                  </td>
                </tr>
                {expandedJobId === job.jobId ? (
                  <tr>
                    <td colSpan={7} style={{ padding: 0, background: 'var(--bg-elevated)' }}>
                      <OpenClawRunsDetail runs={runs} loading={loadingRuns} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DoctorChecks(props: {
  readonly checks: readonly {
    readonly id: string;
    readonly name: string;
    readonly status: 'ok' | 'warn' | 'error';
    readonly message: string;
    readonly details?: string;
  }[];
}): JSX.Element {
  return (
    <div className="doctor-checks-strip">
      {props.checks.slice(0, 4).map((check) => (
        <div key={check.id} className={`doctor-check-item doctor-check-${check.status}`}>
          <span className="doctor-check-icon">{check.status === 'error' ? '✕' : '⚠'}</span>
          <span>
            <strong>{check.name}</strong> — {check.message}
          </span>
          {check.details ? <span className="doctor-check-detail">{check.details}</span> : null}
        </div>
      ))}
    </div>
  );
}

function OpenClawRunsDetail(props: {
  readonly runs: readonly OpenClawRunRecord[];
  readonly loading: boolean;
}): JSX.Element {
  if (props.loading) {
    return (
      <div style={{ padding: '12px 20px' }}>
        <span className="inline-loading">
          <span className="mini-spinner" /> Loading runs...
        </span>
      </div>
    );
  }

  if (props.runs.length === 0) {
    return (
      <div style={{ padding: '12px 20px', fontSize: 12, color: 'var(--text-muted)' }}>
        No run history for this job.
      </div>
    );
  }

  return (
    <div style={{ padding: '8px 0' }}>
      <table className="data-table compact" style={{ margin: 0, background: 'transparent' }}>
        <thead>
          <tr>
            <th style={{ paddingLeft: 20 }}>Run ID</th>
            <th>Session</th>
            <th>Status</th>
            <th>Started</th>
            <th>Duration</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {props.runs.slice(0, 10).map((r) => {
            const sessionId = r.sessionId;
            return (
              <tr key={r.runId}>
                <td className="mono" style={{ fontSize: 11, paddingLeft: 20 }}>
                  {r.runId}
                </td>
                <td style={{ fontSize: 11 }}>
                  {sessionId ? (
                    <>
                      <button
                        className="btn-ghost"
                        style={{ height: 22, padding: '0 6px', fontSize: 11 }}
                        onClick={() => {
                          navigate('sessions', { sessionId });
                        }}
                      >
                        {sessionId}
                      </button>
                      <span className="badge tone-neutral" style={{ marginLeft: 6 }}>
                        {parseSessionOrigin(sessionId).icon}
                      </span>
                    </>
                  ) : (
                    <span className="tone-muted">—</span>
                  )}
                </td>
                <td>
                  <span className={`badge ${statusTone(r.status)}`}>{r.status}</span>
                </td>
                <td style={{ fontSize: 12 }}>{formatRelativeTime(r.startedAt)}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {formatDurationMs(r.durationMs)}
                </td>
                <td style={{ fontSize: 11, color: r.error ? 'var(--red)' : undefined }}>
                  {r.error ?? '—'}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface SnapshotPanelProps {
  readonly snapshots: readonly TaskSnapshot[];
  readonly onRollback: (snapshotId: string) => void;
}

function SnapshotPanel(props: SnapshotPanelProps): JSX.Element {
  if (props.snapshots.length === 0) {
    return (
      <div className="panel" style={{ padding: '14px 20px' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          No snapshots yet. A snapshot is created automatically before every task change.
        </span>
      </div>
    );
  }

  return (
    <div className="panel" style={{ padding: 0 }}>
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <strong style={{ fontSize: 12, color: 'var(--text-primary)' }}>Task Snapshots</strong>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Rollback to any previous state
        </span>
      </div>
      <div className="table-scroll" style={{ maxHeight: 200 }}>
        <table className="data-table compact">
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Description</th>
              <th>Tasks</th>
              <th style={{ width: 80 }}>Restore</th>
            </tr>
          </thead>
          <tbody>
            {props.snapshots.map((s) => (
              <tr key={s.id}>
                <td style={{ fontSize: 12 }}>{formatRelativeTime(s.createdAt)}</td>
                <td>
                  <span className="badge tone-neutral">{s.source}</span>
                </td>
                <td style={{ fontSize: 12 }}>{s.description}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {s.taskCount}
                </td>
                <td>
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      props.onRollback(s.id);
                    }}
                  >
                    Restore
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface CreateTaskFormProps {
  readonly onCreate: (input: Record<string, unknown>) => void;
  readonly openclawJobs: readonly OpenClawCronJob[];
}

function CreateTaskForm(props: CreateTaskFormProps): JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [action, setAction] = useState('health_check');
  const [scheduleKind, setScheduleKind] = useState('every');
  const [everyMinutes, setEveryMinutes] = useState('5');
  const [cronExpr, setCronExpr] = useState('0 * * * *');
  const [cronTz, setCronTz] = useState('');
  const [atDate, setAtDate] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookMethod, setWebhookMethod] = useState('POST');
  const [openclawJobId, setOpenclawJobId] = useState('');

  const canSubmit = name.trim().length > 0 && action !== '';

  const handleSubmit = (): void => {
    let schedule: Record<string, unknown>;
    switch (scheduleKind) {
      case 'cron':
        schedule = { kind: 'cron', expr: cronExpr, ...(cronTz ? { tz: cronTz } : {}) };
        break;
      case 'at':
        schedule = { kind: 'at', at: atDate || new Date(Date.now() + 60_000).toISOString() };
        break;
      default:
        schedule = { kind: 'every', everyMs: Math.max(1, parseFloat(everyMinutes) || 5) * 60_000 };
    }

    const actionConfig: Record<string, unknown> = { action };
    if (action === 'custom_webhook') {
      actionConfig.params = { url: webhookUrl, method: webhookMethod };
    }
    if (action === 'openclaw_cron_run') {
      actionConfig.params = { jobId: openclawJobId };
    }

    props.onCreate({
      name: name.trim() || `${actionLabel(action)} task`,
      ...(description.trim() ? { description: description.trim() } : {}),
      schedule,
      action: actionConfig,
    });
  };

  return (
    <div className="panel" style={{ padding: 20 }}>
      <div className="dialog-form-grid" style={{ marginTop: 0 }}>
        <div className="dialog-form-row cols-2">
          <div className="dialog-field">
            <label className="dialog-field-label">Name</label>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              placeholder="e.g. Hourly health check"
            />
          </div>
          <div className="dialog-field">
            <label className="dialog-field-label">Description</label>
            <input
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
              placeholder="Optional"
            />
          </div>
        </div>

        <div className="dialog-form-row cols-2">
          <div className="dialog-field">
            <label className="dialog-field-label">Action</label>
            <select
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
              }}
            >
              <option value="health_check">Health Check</option>
              <option value="reconnect_endpoints">Reconnect Endpoints</option>
              <option value="cleanup_sessions">Cleanup Sessions</option>
              <option value="generate_report">Generate Report</option>
              <option value="custom_webhook">Custom Webhook</option>
              <option value="openclaw_cron_run">OpenClaw Cron Run</option>
            </select>
          </div>
          <div className="dialog-field">
            <label className="dialog-field-label">Schedule</label>
            <select
              value={scheduleKind}
              onChange={(e) => {
                setScheduleKind(e.target.value);
              }}
            >
              <option value="every">Interval</option>
              <option value="cron">Cron Expression</option>
              <option value="at">One-time</option>
            </select>
          </div>
        </div>

        {scheduleKind === 'every' ? (
          <div className="dialog-form-row">
            <div className="dialog-field">
              <label className="dialog-field-label">Every (minutes)</label>
              <input
                type="number"
                min="1"
                value={everyMinutes}
                onChange={(e) => {
                  setEveryMinutes(e.target.value);
                }}
              />
            </div>
          </div>
        ) : scheduleKind === 'cron' ? (
          <div className="dialog-form-row cols-2">
            <div className="dialog-field">
              <label className="dialog-field-label">Cron Expression</label>
              <input
                value={cronExpr}
                onChange={(e) => {
                  setCronExpr(e.target.value);
                }}
                placeholder="0 * * * *"
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-field-label">Timezone (optional)</label>
              <input
                value={cronTz}
                onChange={(e) => {
                  setCronTz(e.target.value);
                }}
                placeholder="e.g. Asia/Bangkok"
              />
            </div>
          </div>
        ) : (
          <div className="dialog-form-row">
            <div className="dialog-field">
              <label className="dialog-field-label">Run at (ISO 8601)</label>
              <input
                value={atDate}
                onChange={(e) => {
                  setAtDate(e.target.value);
                }}
                placeholder="2026-03-01T09:00:00Z"
              />
            </div>
          </div>
        )}

        {action === 'custom_webhook' ? (
          <div className="dialog-form-row cols-2">
            <div className="dialog-field">
              <label className="dialog-field-label">Webhook URL</label>
              <input
                value={webhookUrl}
                onChange={(e) => {
                  setWebhookUrl(e.target.value);
                }}
                placeholder="https://example.com/hook"
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-field-label">HTTP Method</label>
              <select
                value={webhookMethod}
                onChange={(e) => {
                  setWebhookMethod(e.target.value);
                }}
              >
                <option value="POST">POST</option>
                <option value="GET">GET</option>
                <option value="PUT">PUT</option>
              </select>
            </div>
          </div>
        ) : null}

        {action === 'openclaw_cron_run' ? (
          <div className="dialog-form-row">
            <div className="dialog-field">
              <label className="dialog-field-label">OpenClaw Job ID</label>
              {props.openclawJobs.length > 0 ? (
                <select
                  value={openclawJobId}
                  onChange={(e) => {
                    setOpenclawJobId(e.target.value);
                  }}
                >
                  <option value="">Select a job...</option>
                  {props.openclawJobs.map((j) => (
                    <option key={j.jobId} value={j.jobId}>
                      {j.name ?? j.jobId}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={openclawJobId}
                  onChange={(e) => {
                    setOpenclawJobId(e.target.value);
                  }}
                  placeholder="job_id from OpenClaw"
                />
              )}
            </div>
          </div>
        ) : null}
      </div>

      <div className="actions" style={{ marginTop: 16 }}>
        <button className="btn-primary" disabled={!canSubmit} onClick={handleSubmit}>
          Create Task
        </button>
      </div>
    </div>
  );
}
