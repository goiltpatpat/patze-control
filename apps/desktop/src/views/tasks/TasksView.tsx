import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { FilterTabs, type FilterTab } from '../../components/FilterTabs';
import { useRequiredTarget } from '../../features/openclaw/selection/useRequiredTarget';
import { isSmokeTarget } from '../../features/openclaw/selection/smoke-targets';
import { OpenClawPageState } from '../../features/openclaw/ui/OpenClawPageState';
import { TargetLockBadge } from '../../features/openclaw/ui/TargetLockBadge';
import { navigate } from '../../shell/routes';
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
  const [controlCounts, setControlCounts] = useState<Record<string, number>>({});
  const openclawTargets = props.openclawTargets.entries;
  const refreshTargets = props.openclawTargets.refresh;
  const selectedTargetId = props.selectedTargetId;
  const setSelectedTargetId = props.onSelectedTargetIdChange;
  const [snapshots, setSnapshots] = useState<TaskSnapshot[]>([]);
  const [filter, setFilter] = useState<TaskFilter>(
    props.initialFilter === 'openclaw' ? 'openclaw' : 'all'
  );
  const [showCreate, setShowCreate] = useState(false);
  const [showAddTarget, setShowAddTarget] = useState(false);
  const [showTestTargets, setShowTestTargets] = useState(false);
  const [targetVisibilityMode, setTargetVisibilityMode] = useState<'focus' | 'all'>('focus');
  const [editTarget, setEditTarget] = useState<OpenClawTarget | null>(null);
  const [showSnapshots, setShowSnapshots] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [runningTaskId, setRunningTaskId] = useState<string | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    variant?: 'default' | 'danger' | 'warn';
    confirmLabel?: string;
    onConfirm: () => void;
  } | null>(null);
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
  const healthFetchVersionRef = useRef(0);
  const healthFetchControllerRef = useRef<AbortController | null>(null);
  const selectedTargetIdRef = useRef<string | null>(selectedTargetId);
  selectedTargetIdRef.current = selectedTargetId;

  const isConnected = props.status === 'connected' || props.status === 'degraded';
  const openclawTargetContext = useRequiredTarget({
    connected: isConnected,
    selectedTargetId,
  });
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
    if (!selectedTargetId) {
      setOpenclawJobs([]);
      setOpenclawSyncStatus(null);
      return;
    }
    const requestVersion = ++fetchVersionsRef.current.openclawJobs;
    const requestTargetId = selectedTargetId;
    fetchControllersRef.current.openclawJobs?.abort();
    const { controller, timeoutId } = createTimedAbortController(10_000);
    fetchControllersRef.current.openclawJobs = controller;
    const jobsUrl = `${props.baseUrl}/openclaw/targets/${encodeURIComponent(requestTargetId)}/jobs`;
    try {
      const res = await fetch(jobsUrl, { headers, signal: controller.signal });
      if (!res.ok || controller.signal.aborted) return;
      const data = (await res.json()) as {
        available: boolean;
        jobs: OpenClawCronJob[];
        syncStatus?: OpenClawSyncStatus;
      };
      if (
        !controller.signal.aborted &&
        requestVersion === fetchVersionsRef.current.openclawJobs &&
        requestTargetId === selectedTargetIdRef.current
      ) {
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

  const fetchOpenClawHealth = useCallback(async () => {
    if (!isConnected) return;
    if (!selectedTargetId) {
      setOpenclawHealth(null);
      return;
    }
    const requestVersion = ++healthFetchVersionRef.current;
    const requestTargetId = selectedTargetId;
    healthFetchControllerRef.current?.abort();
    const { controller, timeoutId } = createTimedAbortController(8_000);
    healthFetchControllerRef.current = controller;
    const healthUrl = `${props.baseUrl}/openclaw/targets/${encodeURIComponent(requestTargetId)}/health`;
    try {
      const res = await fetch(healthUrl, { headers, signal: controller.signal });
      if (!res.ok) return;
      const data = (await res.json()) as OpenClawHealthCheck;
      if (
        !controller.signal.aborted &&
        requestVersion === healthFetchVersionRef.current &&
        requestTargetId === selectedTargetIdRef.current
      ) {
        setOpenclawHealth(data);
      }
    } catch {
      /* connection lost */
    } finally {
      clearTimeout(timeoutId);
      if (healthFetchControllerRef.current === controller) {
        healthFetchControllerRef.current = null;
      }
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

  const fetchControlCounts = useCallback(async () => {
    if (!isConnected || !selectedTargetId) {
      setControlCounts({});
      return;
    }
    try {
      const res = await fetch(
        `${props.baseUrl}/openclaw/targets/${encodeURIComponent(selectedTargetId)}/control/commands?limit=100`,
        {
          headers,
          signal: AbortSignal.timeout(8_000),
        }
      );
      if (!res.ok) return;
      const data = (await res.json()) as { counts?: Record<string, number> };
      setControlCounts(data.counts ?? {});
    } catch {
      /* ignore */
    }
  }, [props.baseUrl, headers, isConnected, selectedTargetId]);

  const createBridgeCommand = useCallback(
    async (intent: string, args: Record<string, unknown>): Promise<boolean> => {
      if (!selectedTargetId) return false;
      try {
        const response = await fetch(
          `${props.baseUrl}/openclaw/targets/${encodeURIComponent(selectedTargetId)}/control/commands`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({
              intent,
              args,
              createdBy: 'ui-tasks',
              policyVersion: 'bridge-control-v1',
            }),
            signal: AbortSignal.timeout(10_000),
          }
        );
        return response.ok;
      } catch {
        return false;
      }
    },
    [props.baseUrl, headers, selectedTargetId]
  );

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
    setOpenclawJobs([]);
    setOpenclawSyncStatus(null);
    setOpenclawHealth(null);
    setControlCounts({});
    void fetchOpenClawJobs();
    void fetchOpenClawHealth();
    void fetchControlCounts();
  }, [isConnected, selectedTargetId, fetchOpenClawJobs, fetchOpenClawHealth, fetchControlCounts]);

  useEffect(
    () => () => {
      fetchControllersRef.current.tasks?.abort();
      fetchControllersRef.current.history?.abort();
      fetchControllersRef.current.openclawJobs?.abort();
      healthFetchControllerRef.current?.abort();
      runAbortRef.current?.abort();
    },
    []
  );

  const handleAddTarget = useCallback(
    async (input: {
      label: string;
      type: 'local' | 'remote';
      purpose: 'production' | 'test';
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

  const handleEditTarget = useCallback(
    async (input: {
      label: string;
      type: 'local' | 'remote';
      purpose: 'production' | 'test';
      openclawDir: string;
      pollIntervalMs: number;
    }) => {
      if (!editTarget) return;
      setError(null);
      try {
        const res = await fetch(
          `${props.baseUrl}/openclaw/targets/${encodeURIComponent(editTarget.id)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(input),
            signal: AbortSignal.timeout(10_000),
          }
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as Record<string, string> | null;
          setError(body?.error ?? `Edit target failed: HTTP ${res.status}`);
          return;
        }
        setEditTarget(null);
        await refreshTargets();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Edit target failed');
      }
    },
    [editTarget, headers, props.baseUrl, refreshTargets]
  );

  const handleDeleteTarget = useCallback(
    (targetId: string) => {
      setConfirmState({
        title: 'Remove Target',
        message: 'Remove this OpenClaw target? Sync will stop.',
        variant: 'danger',
        confirmLabel: 'Remove',
        onConfirm: () => {
          setConfirmState(null);
          setError(null);
          void (async () => {
            try {
              const res = await fetch(
                `${props.baseUrl}/openclaw/targets/${encodeURIComponent(targetId)}`,
                { method: 'DELETE', headers, signal: AbortSignal.timeout(10_000) }
              );
              if (!res.ok) {
                setError(`Delete target failed: HTTP ${res.status}`);
                return;
              }
              if (selectedTargetId === targetId) setSelectedTargetId(null);
              await refreshTargets();
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Delete target failed');
            }
          })();
        },
      });
    },
    [props.baseUrl, headers, selectedTargetId, refreshTargets]
  );

  const handleToggleTarget = useCallback(
    async (targetId: string, enabled: boolean) => {
      setError(null);
      try {
        const res = await fetch(
          `${props.baseUrl}/openclaw/targets/${encodeURIComponent(targetId)}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify({ enabled }),
            signal: AbortSignal.timeout(10_000),
          }
        );
        if (!res.ok) setError(`Toggle target failed: HTTP ${res.status}`);
        await refreshTargets();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Toggle failed');
      }
    },
    [props.baseUrl, headers, refreshTargets]
  );

  const smokeTargetIds = useMemo(
    () =>
      openclawTargets
        .map((entry) => entry.target)
        .filter((target) => isSmokeTarget(target))
        .map((target) => target.id),
    [openclawTargets]
  );
  const visibleOpenclawTargets = useMemo(() => {
    const candidates = showTestTargets
      ? [...openclawTargets]
      : openclawTargets.filter((entry) => !isSmokeTarget(entry.target));

    // Keep the most relevant cards first: selected -> active/healthy -> recent.
    const selectedId = selectedTargetId;
    candidates.sort((a, b) => {
      const aSelected = selectedId != null && a.target.id === selectedId;
      const bSelected = selectedId != null && b.target.id === selectedId;
      if (aSelected !== bSelected) {
        return aSelected ? -1 : 1;
      }

      const aActiveScore = (a.target.enabled ? 2 : 0) + (a.syncStatus.available ? 1 : 0);
      const bActiveScore = (b.target.enabled ? 2 : 0) + (b.syncStatus.available ? 1 : 0);
      if (aActiveScore !== bActiveScore) {
        return bActiveScore - aActiveScore;
      }

      const aTime = Date.parse(a.target.createdAt);
      const bTime = Date.parse(b.target.createdAt);
      if (!Number.isNaN(aTime) && !Number.isNaN(bTime) && aTime !== bTime) {
        return bTime - aTime;
      }
      return a.target.label.localeCompare(b.target.label);
    });

    return candidates;
  }, [openclawTargets, selectedTargetId, showTestTargets]);
  const focusOpenclawTargets = useMemo(() => {
    if (targetVisibilityMode === 'all') return visibleOpenclawTargets;
    return visibleOpenclawTargets.filter((entry) => {
      if (entry.target.id === selectedTargetId) return true;
      if (entry.syncStatus.running || entry.syncStatus.jobsCount > 0) return true;
      if (!entry.target.enabled) return false;
      if (!entry.syncStatus.available || entry.syncStatus.stale) return false;
      if (entry.syncStatus.lastError || entry.syncStatus.consecutiveFailures > 0) return false;
      return true;
    });
  }, [selectedTargetId, targetVisibilityMode, visibleOpenclawTargets]);
  const focusHiddenCount = visibleOpenclawTargets.length - focusOpenclawTargets.length;
  const targetCardsEmptyMessage = useMemo(() => {
    if (targetVisibilityMode === 'focus' && visibleOpenclawTargets.length > 0) {
      return 'No targets match Focus mode. Switch to "Show All Targets" to view everything.';
    }
    return 'No OpenClaw targets configured.';
  }, [targetVisibilityMode, visibleOpenclawTargets.length]);

  useEffect(() => {
    if (showTestTargets || !selectedTargetId) return;
    const selectedEntry = openclawTargets.find((entry) => entry.target.id === selectedTargetId);
    if (!selectedEntry) return;
    if (isSmokeTarget(selectedEntry.target)) {
      setSelectedTargetId(null);
    }
  }, [openclawTargets, selectedTargetId, setSelectedTargetId, showTestTargets]);

  const handleDeleteSmokeTargets = useCallback(() => {
    if (smokeTargetIds.length === 0) return;
    setConfirmState({
      title: 'Delete Test Targets',
      message: `Delete ${String(smokeTargetIds.length)} test targets detected from smoke/ui fixtures?`,
      variant: 'danger',
      confirmLabel: 'Delete All',
      onConfirm: () => {
        setConfirmState(null);
        setError(null);
        void (async () => {
          try {
            const res = await fetch(
              `${props.baseUrl}/openclaw/targets?ids=${encodeURIComponent(smokeTargetIds.join(','))}&purpose=test`,
              {
                method: 'DELETE',
                headers,
                signal: AbortSignal.timeout(10_000),
              }
            );
            if (!res.ok) {
              setError(`Delete smoke targets failed: HTTP ${res.status}`);
              return;
            }
            if (selectedTargetId && smokeTargetIds.includes(selectedTargetId)) {
              setSelectedTargetId(null);
            }
            await refreshTargets();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Delete smoke targets failed');
          }
        })();
      },
    });
  }, [
    headers,
    props.baseUrl,
    refreshTargets,
    selectedTargetId,
    setSelectedTargetId,
    smokeTargetIds,
  ]);

  const runAbortRef = useRef<AbortController | null>(null);

  const doRunTask = useCallback(
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
    [props.baseUrl, headers, fetchTasks, fetchHistory, runningTaskId]
  );

  const handleRunNow = useCallback(
    (taskId: string) => {
      if (runningTaskId && runningTaskId !== taskId) {
        setConfirmState({
          title: 'Task Running',
          message: 'Another task run is still pending. Cancel it and run this task instead?',
          variant: 'warn',
          confirmLabel: 'Replace',
          onConfirm: () => {
            setConfirmState(null);
            void doRunTask(taskId);
          },
        });
        return;
      }
      void doRunTask(taskId);
    },
    [runningTaskId, doRunTask]
  );

  const handleDoctorRunHealthCheck = useCallback(() => {
    void fetchOpenClawHealth();
  }, [fetchOpenClawHealth]);

  const handleDoctorReconnect = useCallback(() => {
    void refreshTargets();
    void fetchOpenClawJobs();
    void fetchOpenClawHealth();
  }, [refreshTargets, fetchOpenClawJobs, fetchOpenClawHealth]);

  const handleDoctorOpenTargetSettings = useCallback(() => {
    navigate('settings');
  }, []);

  const handleDoctorViewLogs = useCallback(() => {
    navigate('logs');
  }, []);

  const handleTriggerJob = useCallback(
    async (jobId: string) => {
      if (!selectedTargetId) return;
      const queued = await createBridgeCommand('trigger_job', { jobId });
      if (!queued) {
        setError('Queue bridge command failed for trigger job.');
      }
      await Promise.all([fetchOpenClawJobs(), fetchControlCounts()]);
    },
    [createBridgeCommand, fetchControlCounts, fetchOpenClawJobs, selectedTargetId]
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
    (taskId: string) => {
      setConfirmState({
        title: 'Delete Task',
        message: 'Delete this task? This cannot be undone.',
        variant: 'danger',
        confirmLabel: 'Delete',
        onConfirm: () => {
          setConfirmState(null);
          setError(null);
          void (async () => {
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
          })();
        },
      });
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
    (snapshotId: string) => {
      setConfirmState({
        title: 'Rollback Tasks',
        message: 'Rollback to this snapshot? Current tasks will be replaced.',
        variant: 'warn',
        confirmLabel: 'Rollback',
        onConfirm: () => {
          setConfirmState(null);
          setError(null);
          void (async () => {
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
          })();
        },
      });
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
    for (const entry of focusOpenclawTargets) {
      total += entry.syncStatus.jobsCount;
    }
    return total > 0 ? total : openclawJobs.length;
  }, [focusOpenclawTargets, openclawJobs.length]);

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
        <OpenClawPageState kind="notReady" featureName="scheduled tasks" />
      </section>
    );
  }

  if (initialLoading && tasks.length === 0) {
    return (
      <section className="view-panel">
        <div className="view-header">
          <h2 className="view-title">Scheduled Tasks</h2>
        </div>
        <OpenClawPageState kind="loading" featureName="scheduled tasks" />
      </section>
    );
  }

  return (
    <section className="view-panel">
      <div className="view-header tasks-view-header">
        <div className="tasks-view-title-block">
          <h2 className="view-title">Scheduled Tasks</h2>
          <p className="tasks-view-subtitle">
            Manage Patze schedules and OpenClaw native cron jobs from one control surface.
          </p>
        </div>
        <div className="tasks-view-toolbar">
          <FilterTabs tabs={tabs} active={filter} onChange={setFilter} />
          {filter === 'openclaw' ? <TargetLockBadge targetId={selectedTargetId} /> : null}
          {filter === 'openclaw' ? (
            <span className="badge tone-neutral">
              control q/r/f {(controlCounts.queued ?? 0).toString()}/
              {(controlCounts.running ?? 0).toString()}/{(controlCounts.failed ?? 0).toString()}
            </span>
          ) : null}
          <div className="actions tasks-view-actions">
            {filter === 'openclaw' ? (
              <button
                className="btn-primary"
                onClick={() => {
                  if (showAddTarget || editTarget) {
                    setShowAddTarget(false);
                    setEditTarget(null);
                    return;
                  }
                  setEditTarget(null);
                  setShowAddTarget(true);
                }}
              >
                {showAddTarget || editTarget ? 'Cancel' : '+ Target'}
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
            {filter === 'openclaw' && smokeTargetIds.length > 0 ? (
              <span className="badge tone-muted">hidden test targets: {smokeTargetIds.length}</span>
            ) : null}
            {filter === 'openclaw' ? (
              <span className="badge tone-neutral">
                view: {targetVisibilityMode}
                {targetVisibilityMode === 'focus' && focusHiddenCount > 0
                  ? ` (${focusHiddenCount.toString()} hidden)`
                  : ''}
              </span>
            ) : null}
            {filter === 'openclaw' ? (
              <button
                className="btn-secondary"
                onClick={() => {
                  setTargetVisibilityMode((prev) => (prev === 'focus' ? 'all' : 'focus'));
                }}
              >
                {targetVisibilityMode === 'focus' ? 'Show All Targets' : 'Focus Targets'}
              </button>
            ) : null}
            {filter === 'openclaw' && smokeTargetIds.length > 0 ? (
              <button className="btn-danger" onClick={handleDeleteSmokeTargets}>
                Clean Test Targets ({smokeTargetIds.length})
              </button>
            ) : null}
            {filter === 'openclaw' && smokeTargetIds.length > 0 ? (
              <button
                className="btn-secondary"
                onClick={() => {
                  setShowTestTargets((prev) => !prev);
                }}
              >
                {showTestTargets ? 'Hide Test Targets' : 'Show Test Targets'}
              </button>
            ) : null}
          </div>
        </div>
      </div>

      {/* Stats Bar */}
      {filter === 'openclaw' && openclawTargetContext.state !== 'ready' ? null : (
        <TaskStatsBar tasks={tasks} targets={focusOpenclawTargets} filter={filter} />
      )}

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
      {!error && props.openclawTargets.lastError && filter === 'openclaw' ? (
        <div className="task-error-banner" role="alert">
          <span>OpenClaw targets degraded: {props.openclawTargets.lastError}</span>
          <button
            className="btn-ghost"
            style={{ marginLeft: 'auto', height: 24, padding: '0 8px' }}
            onClick={() => {
              void props.openclawTargets.refresh();
            }}
          >
            Retry
          </button>
        </div>
      ) : null}

      {showSnapshots ? <SnapshotPanel snapshots={snapshots} onRollback={handleRollback} /> : null}
      {showCreate ? <CreateTaskForm onCreate={handleCreate} openclawJobs={openclawJobs} /> : null}

      {filter === 'timeline' ? (
        <TaskTimeline tasks={timelineTasks} />
      ) : filter === 'openclaw' ? (
        <>
          {openclawTargetContext.state === 'ready' ? (
            <>
              {showAddTarget ? (
                <AddTargetForm
                  onSubmit={handleAddTarget}
                  onCancel={() => {
                    setShowAddTarget(false);
                  }}
                />
              ) : null}
              {editTarget ? (
                <AddTargetForm
                  title="Edit OpenClaw Target"
                  submitLabel="Save Changes"
                  initialValues={{
                    label: editTarget.label,
                    type: editTarget.type,
                    purpose: editTarget.purpose,
                    openclawDir: editTarget.openclawDir,
                    pollIntervalMs: editTarget.pollIntervalMs,
                  }}
                  onSubmit={handleEditTarget}
                  onCancel={() => {
                    setEditTarget(null);
                  }}
                />
              ) : null}
              <TargetCardsBar
                targets={focusOpenclawTargets}
                selectedTargetId={selectedTargetId}
                onSelect={setSelectedTargetId}
                onToggle={handleToggleTarget}
                onEdit={(entry) => {
                  setShowAddTarget(false);
                  setEditTarget(entry.target);
                }}
                onDelete={handleDeleteTarget}
                emptyMessage={targetCardsEmptyMessage}
              />
              <OpenClawJobsPanel
                jobs={openclawJobs}
                syncStatus={openclawSyncStatus}
                health={openclawHealth}
                baseUrl={props.baseUrl}
                headers={headers}
                selectedTargetId={selectedTargetId}
                onRunHealthCheck={handleDoctorRunHealthCheck}
                onReconnect={handleDoctorReconnect}
                onOpenTargetSettings={handleDoctorOpenTargetSettings}
                onViewLogs={handleDoctorViewLogs}
                onTriggerJob={handleTriggerJob}
              />
            </>
          ) : (
            <OpenClawPageState kind="noTarget" featureName="OpenClaw jobs" />
          )}
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

      {confirmState ? (
        <ConfirmDialog
          title={confirmState.title}
          message={confirmState.message}
          variant={confirmState.variant}
          confirmLabel={confirmState.confirmLabel}
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      ) : null}
    </section>
  );
}
