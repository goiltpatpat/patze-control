import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FilterTabs, type FilterTab } from '../../components/FilterTabs';
import { IconClock } from '../../components/Icons';
import { emitConfigChanged } from '../../utils/openclaw-events';
import { TaskTimeline, type TimelineTask } from '../../components/TaskTimeline';
import { AddTargetForm } from './AddTargetForm';
import { CreateTaskForm } from './CreateTaskForm';
import { OpenClawJobsPanel } from './OpenClawJobsPanel';
import { RunHistoryPanel } from './RunHistoryPanel';
import { SnapshotPanel } from './SnapshotPanel';
import { TargetCardsBar } from './TargetCardsBar';
import { TaskStatsBar } from './TaskStatsBar';
import { TaskTable } from './TaskTable';
import type {
  OpenClawCronJob,
  OpenClawHealthCheck,
  OpenClawSyncStatus,
  OpenClawTarget,
  ScheduledTask,
  TaskFilter,
  TaskRunRecord,
  TaskSnapshot,
  TasksViewProps,
} from './types';
import { authHeaders, createTimedAbortController, RECENT_HISTORY_LIMIT } from './utils';

export type { TasksViewProps };

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
      const data = (await res.json()) as ScheduledTask[] | undefined;
      if (!controller.signal.aborted && requestVersion === fetchVersionsRef.current.tasks) {
        setTasks(Array.isArray(data) ? data : []);
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
      const data = (await res.json()) as TaskRunRecord[] | undefined;
      if (!controller.signal.aborted && requestVersion === fetchVersionsRef.current.history) {
        setHistory(Array.isArray(data) ? data : []);
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
        setOpenclawJobs(data.jobs ?? []);
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
      if (res.ok) {
        const data = (await res.json()) as TaskSnapshot[] | undefined;
        setSnapshots(Array.isArray(data) ? data : []);
      }
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
              } else if (eventType === 'config-changed') {
                emitConfigChanged();
                void fetchOpenClawJobsRef.current?.();
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
      { id: 'timeline', label: 'Timeline' },
    ],
    [counts, openclawJobCount]
  );

  const timelineTasks = useMemo<readonly TimelineTask[]>(() => {
    const result: TimelineTask[] = [];
    for (const task of tasks) {
      result.push({
        id: task.id,
        name: task.name,
        schedule: task.schedule,
        enabled: task.status === 'enabled',
        nextRunAtMs: task.nextRunAtMs,
      });
    }
    for (const job of openclawJobs) {
      result.push({
        id: job.jobId,
        name: job.name ?? job.jobId,
        schedule: job.schedule,
        enabled: job.enabled,
        nextRunAtMs: job.nextRunAtMs,
      });
    }
    return result;
  }, [tasks, openclawJobs]);

  const filtered = useMemo(() => {
    if (filter === 'openclaw' || filter === 'timeline') return [];
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

      {filter === 'timeline' ? (
        <TaskTimeline tasks={timelineTasks} />
      ) : filter === 'openclaw' ? (
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
