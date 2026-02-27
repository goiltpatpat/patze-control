import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconClock } from '../../components/Icons';
import { navigate } from '../../shell/routes';
import { TargetLockBadge } from '../../features/openclaw/ui/TargetLockBadge';
import { parseSessionOrigin } from '../../utils/openclaw';
import { formatRelativeTime } from '../../utils/time';
import type {
  OpenClawCronJob,
  OpenClawHealthCheck,
  OpenClawRunRecord,
  OpenClawSyncStatus,
} from './types';
import {
  formatCompactMs,
  formatDurationMs,
  formatNextRun,
  formatSchedule,
  statusTone,
} from './utils';

interface OpenClawJobsPanelProps {
  readonly jobs: readonly OpenClawCronJob[];
  readonly syncStatus: OpenClawSyncStatus | null;
  readonly health: OpenClawHealthCheck | null;
  readonly baseUrl: string;
  readonly headers: Record<string, string>;
  readonly selectedTargetId: string | null;
  readonly onRunHealthCheck?: () => void;
  readonly onReconnect?: () => void;
  readonly onOpenTargetSettings?: () => void;
  readonly onViewLogs?: () => void;
  readonly onTriggerJob?: (jobId: string) => void;
}

type StatusFilter = 'all' | 'active' | 'paused' | 'issues';
const RUNS_CACHE_TTL_MS = 15_000;
const RUNS_CACHE_LIMIT = 40;

interface CachedRunsEntry {
  readonly fetchedAtMs: number;
  readonly runs: readonly OpenClawRunRecord[];
}

export function OpenClawJobsPanel(props: OpenClawJobsPanelProps): JSX.Element {
  const [expandedJobId, setExpandedJobId] = useState<string | null>(null);
  const [runs, setRuns] = useState<OpenClawRunRecord[]>([]);
  const [loadingRuns, setLoadingRuns] = useState(false);
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const issueChecks = (props.health?.checks ?? []).filter((c) => c.status !== 'ok');
  const runsRequestVersionRef = useRef(0);
  const runsControllerRef = useRef<AbortController | null>(null);
  const runsCacheRef = useRef<Map<string, CachedRunsEntry>>(new Map());
  const selectedTargetIdRef = useRef<string | null>(props.selectedTargetId);
  selectedTargetIdRef.current = props.selectedTargetId;

  const toRunsCacheKey = useCallback(
    (jobId: string): string => {
      return `${props.selectedTargetId ?? '__local__'}::${jobId}`;
    },
    [props.selectedTargetId]
  );

  const cacheRuns = useCallback((key: string, nextRuns: readonly OpenClawRunRecord[]): void => {
    const cache = runsCacheRef.current;
    cache.delete(key);
    cache.set(key, { fetchedAtMs: Date.now(), runs: nextRuns });
    while (cache.size > RUNS_CACHE_LIMIT) {
      const oldestKey = cache.keys().next().value as string | undefined;
      if (!oldestKey) {
        break;
      }
      cache.delete(oldestKey);
    }
  }, []);

  const cancelRunsRequest = useCallback(() => {
    runsRequestVersionRef.current += 1;
    runsControllerRef.current?.abort();
    runsControllerRef.current = null;
  }, []);

  const stats = useMemo(() => {
    let active = 0;
    let paused = 0;
    let errors = 0;
    let nextMs: number | null = null;
    for (const job of props.jobs) {
      if (job.enabled) active += 1;
      else paused += 1;
      if ((job.consecutiveErrors ?? 0) > 0 || job.lastStatus === 'error') errors += 1;
      if (job.nextRunAtMs !== undefined && (nextMs === null || job.nextRunAtMs < nextMs))
        nextMs = job.nextRunAtMs;
    }
    return { active, paused, errors, nextMs };
  }, [props.jobs]);

  const filteredJobs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return props.jobs.filter((job) => {
      const hasIssue = (job.consecutiveErrors ?? 0) > 0 || job.lastStatus === 'error';
      if (statusFilter === 'active' && !job.enabled) return false;
      if (statusFilter === 'paused' && job.enabled) return false;
      if (statusFilter === 'issues' && !hasIssue) return false;
      if (!q) return true;
      return (
        job.jobId.toLowerCase().includes(q) ||
        (job.name?.toLowerCase().includes(q) ?? false) ||
        (job.execution.agentId?.toLowerCase().includes(q) ?? false) ||
        (job.delivery.channelId?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [props.jobs, query, statusFilter]);

  const fetchRuns = useCallback(
    async (jobId: string) => {
      const cacheKey = toRunsCacheKey(jobId);
      const cached = runsCacheRef.current.get(cacheKey);
      if (cached && Date.now() - cached.fetchedAtMs <= RUNS_CACHE_TTL_MS) {
        setRuns([...cached.runs]);
        setLoadingRuns(false);
        return;
      }

      const requestVersion = ++runsRequestVersionRef.current;
      const requestTargetId = props.selectedTargetId;
      runsControllerRef.current?.abort();
      const controller = new AbortController();
      runsControllerRef.current = controller;
      const signal = controller.signal;
      setLoadingRuns(true);
      try {
        const runsUrl = props.selectedTargetId
          ? `${props.baseUrl}/openclaw/targets/${encodeURIComponent(props.selectedTargetId)}/runs/${encodeURIComponent(jobId)}`
          : `${props.baseUrl}/openclaw/cron/runs/${encodeURIComponent(jobId)}`;
        const res = await fetch(runsUrl, {
          headers: props.headers,
          signal,
        });
        if (signal.aborted || requestVersion !== runsRequestVersionRef.current) return;
        if (res.ok) {
          const data = (await res.json()) as { runs?: OpenClawRunRecord[] };
          if (requestTargetId === selectedTargetIdRef.current) {
            const nextRuns = data.runs ?? [];
            setRuns(nextRuns);
            cacheRuns(cacheKey, nextRuns);
          }
        }
      } catch {
        /* ok */
      } finally {
        if (!signal.aborted && requestVersion === runsRequestVersionRef.current) {
          setLoadingRuns(false);
        }
        if (runsControllerRef.current === controller) {
          runsControllerRef.current = null;
        }
      }
    },
    [cacheRuns, props.baseUrl, props.headers, props.selectedTargetId, toRunsCacheKey]
  );

  const toggleExpand = useCallback(
    (jobId: string) => {
      if (expandedJobId === jobId) {
        cancelRunsRequest();
        setExpandedJobId(null);
        setRuns([]);
      } else {
        setExpandedJobId(jobId);
        setRuns([]);
        void fetchRuns(jobId);
      }
    },
    [expandedJobId, fetchRuns, cancelRunsRequest]
  );

  useEffect(() => {
    cancelRunsRequest();
    setExpandedJobId(null);
    setRuns([]);
    setLoadingRuns(false);
  }, [props.selectedTargetId, cancelRunsRequest]);

  useEffect(
    () => () => {
      cancelRunsRequest();
    },
    [cancelRunsRequest]
  );

  if (props.jobs.length === 0) {
    return (
      <div className="oc2">
        <PanelHeader
          health={props.health}
          syncStatus={props.syncStatus}
          selectedTargetId={props.selectedTargetId}
        />
        {issueChecks.length > 0 ? (
          <DoctorChecks
            checks={issueChecks}
            {...(props.onRunHealthCheck ? { onRunHealthCheck: props.onRunHealthCheck } : {})}
            {...(props.onReconnect ? { onReconnect: props.onReconnect } : {})}
            {...(props.onOpenTargetSettings
              ? { onOpenTargetSettings: props.onOpenTargetSettings }
              : {})}
            {...(props.onViewLogs ? { onViewLogs: props.onViewLogs } : {})}
          />
        ) : null}
        <div style={{ padding: '40px 20px', textAlign: 'center' }}>
          <div style={{ opacity: 0.2, marginBottom: 10 }}>
            <IconClock width={32} height={32} />
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
    <div className="oc2">
      <PanelHeader
        health={props.health}
        syncStatus={props.syncStatus}
        selectedTargetId={props.selectedTargetId}
      />
      {issueChecks.length > 0 ? (
        <DoctorChecks
          checks={issueChecks}
          {...(props.onRunHealthCheck ? { onRunHealthCheck: props.onRunHealthCheck } : {})}
          {...(props.onReconnect ? { onReconnect: props.onReconnect } : {})}
          {...(props.onOpenTargetSettings
            ? { onOpenTargetSettings: props.onOpenTargetSettings }
            : {})}
          {...(props.onViewLogs ? { onViewLogs: props.onViewLogs } : {})}
        />
      ) : null}

      {/* Stats */}
      <div className="oc2-stats">
        <div className="oc2-stat">
          <span className="oc2-stat-n">{props.jobs.length}</span>
          <span className="oc2-stat-l">Jobs</span>
        </div>
        <div className="oc2-stat">
          <span className="oc2-stat-n oc2-green">{stats.active}</span>
          <span className="oc2-stat-l">Active</span>
        </div>
        <div className="oc2-stat">
          <span className="oc2-stat-n">{stats.paused}</span>
          <span className="oc2-stat-l">Paused</span>
        </div>
        <div className="oc2-stat">
          <span className={`oc2-stat-n ${stats.errors > 0 ? 'oc2-red' : ''}`}>{stats.errors}</span>
          <span className="oc2-stat-l">Issues</span>
        </div>
        <div className="oc2-stat oc2-stat-wide">
          <span className="oc2-stat-n">{stats.nextMs ? formatNextRun(stats.nextMs) : '—'}</span>
          <span className="oc2-stat-l">Next Run</span>
        </div>
      </div>

      {/* Toolbar */}
      <div className="oc2-bar">
        <input
          className="oc2-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search jobs..."
        />
        <div className="oc2-chips">
          {(['all', 'active', 'paused', 'issues'] as const).map((f) => (
            <button
              key={f}
              className={`oc2-chip${statusFilter === f ? ' on' : ''}`}
              onClick={() => setStatusFilter(f)}
            >
              {f === 'all'
                ? 'All'
                : f === 'active'
                  ? 'Active'
                  : f === 'paused'
                    ? 'Paused'
                    : 'Issues'}
            </button>
          ))}
        </div>
        <span className="oc2-count">
          {filteredJobs.length}/{props.jobs.length}
        </span>
      </div>

      {/* Job list */}
      <div className="oc2-list">
        {filteredJobs.map((job) => (
          <JobCard
            key={job.jobId}
            job={job}
            isExpanded={expandedJobId === job.jobId}
            onToggle={toggleExpand}
            {...(props.onTriggerJob ? { onTrigger: props.onTriggerJob } : {})}
            runs={expandedJobId === job.jobId ? runs : []}
            loadingRuns={expandedJobId === job.jobId && loadingRuns}
          />
        ))}
      </div>
    </div>
  );
}

function JobCard(props: {
  readonly job: OpenClawCronJob;
  readonly isExpanded: boolean;
  readonly onToggle: (id: string) => void;
  readonly onTrigger?: (id: string) => void;
  readonly runs: readonly OpenClawRunRecord[];
  readonly loadingRuns: boolean;
}): JSX.Element {
  const { job, isExpanded } = props;
  const hasIssue = (job.consecutiveErrors ?? 0) > 0 || job.lastStatus === 'error';

  return (
    <div className={`oc2-card${isExpanded ? ' open' : ''}${hasIssue ? ' issue' : ''}`}>
      {/* Clickable header */}
      <div
        className="oc2-card-head"
        role="button"
        tabIndex={0}
        onClick={() => props.onToggle(job.jobId)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            props.onToggle(job.jobId);
          }
        }}
      >
        <span className={`oc2-dot${job.enabled ? ' active' : ''}`} />
        <div className="oc2-card-title">
          <span className="oc2-card-name">{job.name ?? job.jobId}</span>
          {job.name ? <span className="oc2-card-id">{job.jobId}</span> : null}
        </div>
        <div className="oc2-card-badges">
          {props.onTrigger ? (
            <button
              type="button"
              className="btn-ghost"
              style={{ height: 22, padding: '0 8px', fontSize: '0.68rem' }}
              onClick={(event) => {
                event.stopPropagation();
                props.onTrigger?.(job.jobId);
              }}
            >
              Trigger
            </button>
          ) : null}
          {job.lastRunAt ? (
            <span className={`badge ${statusTone(job.lastStatus ?? 'error')}`}>
              {job.lastStatus ?? '?'}
            </span>
          ) : null}
          {(job.consecutiveErrors ?? 0) > 0 ? (
            <span className="badge tone-bad">{job.consecutiveErrors} err</span>
          ) : null}
        </div>
        <span className="oc2-chevron">{isExpanded ? '▾' : '▸'}</span>
      </div>

      {/* Always-visible meta row */}
      <div className="oc2-meta">
        <div className="oc2-meta-cell">
          <span className="oc2-meta-k">Schedule</span>
          <span className="oc2-meta-v mono">{formatSchedule(job.schedule)}</span>
          {job.schedule.kind === 'cron' &&
          job.schedule.staggerMs !== undefined &&
          job.schedule.staggerMs > 0 ? (
            <span className="badge tone-neutral" style={{ marginLeft: 4, fontSize: 9 }}>
              stagger {formatCompactMs(job.schedule.staggerMs)}
            </span>
          ) : null}
        </div>
        <div className="oc2-meta-cell">
          <span className="oc2-meta-k">Next</span>
          <span className="oc2-meta-v oc2-cyan">
            {job.nextRunAtMs ? formatNextRun(job.nextRunAtMs) : '—'}
          </span>
        </div>
        <div className="oc2-meta-cell">
          <span className="oc2-meta-k">Exec</span>
          <span className="oc2-meta-v">
            <span className="badge tone-neutral">{job.execution.style}</span>
            {job.payload?.kind ? (
              <span className="badge tone-neutral">{job.payload.kind}</span>
            ) : null}
            {job.sessionTarget ? (
              <span className="badge tone-neutral">{job.sessionTarget}</span>
            ) : null}
            {job.wakeMode ? (
              <span className="badge tone-neutral">
                wake {job.wakeMode === 'next-heartbeat' ? 'hb' : 'now'}
              </span>
            ) : null}
          </span>
        </div>
        <div className="oc2-meta-cell">
          <span className="oc2-meta-k">Delivery</span>
          <span className="oc2-meta-v">
            <span className={`badge ${job.delivery.mode === 'none' ? 'tone-muted' : 'tone-good'}`}>
              {job.delivery.mode}
            </span>
            {job.delivery.channelId ? (
              <span className="badge tone-neutral">{job.delivery.channelId}</span>
            ) : null}
            {job.delivery.channel ? (
              <span className="oc2-dim">via {job.delivery.channel}</span>
            ) : null}
          </span>
        </div>
        {job.lastRunAt ? (
          <div className="oc2-meta-cell oc2-meta-wide">
            <span className="oc2-meta-k">Last Run</span>
            <span className="oc2-meta-v">
              <span className={`badge ${statusTone(job.lastStatus ?? 'error')}`}>
                {job.lastStatus ?? '?'}
              </span>
              <span className="oc2-dim">{formatRelativeTime(job.lastRunAt)}</span>
              {job.lastDurationMs !== undefined ? (
                <span className="oc2-dim mono">{formatDurationMs(job.lastDurationMs)}</span>
              ) : null}
              {job.lastDelivered !== undefined ? (
                <span className={`badge ${job.lastDelivered ? 'tone-good' : 'tone-muted'}`}>
                  {job.lastDelivered ? 'delivered' : 'not delivered'}
                </span>
              ) : null}
            </span>
          </div>
        ) : null}
      </div>

      {/* Expanded: run history */}
      {isExpanded ? (
        <div className="oc2-expand">
          <div className="oc2-expand-title">Run History</div>
          <RunHistory runs={props.runs} loading={props.loadingRuns} />
        </div>
      ) : null}
    </div>
  );
}

function PanelHeader(props: {
  readonly health: OpenClawHealthCheck | null;
  readonly syncStatus: OpenClawSyncStatus | null;
  readonly selectedTargetId?: string | null;
}): JSX.Element {
  const isSyncing =
    props.syncStatus && !props.syncStatus.stale && props.syncStatus.consecutiveFailures === 0;
  return (
    <div className="oc2-header">
      <div className="oc2-header-left">
        <span className="oc2-header-title">OpenClaw</span>
        <TargetLockBadge targetId={props.selectedTargetId ?? null} />
        {props.health ? (
          <span className={`badge ${props.health.ok ? 'tone-good' : 'tone-bad'}`}>
            {props.health.ok ? 'healthy' : 'issues'}
          </span>
        ) : null}
        {props.syncStatus ? (
          <span className={`badge ${isSyncing ? 'tone-good' : 'tone-bad'}`}>
            {isSyncing ? 'syncing' : 'degraded'}
          </span>
        ) : null}
      </div>
      <span className="oc2-header-sync">
        {props.syncStatus?.lastSuccessfulSyncAt
          ? `synced ${formatRelativeTime(props.syncStatus.lastSuccessfulSyncAt)}`
          : ''}
      </span>
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
  readonly onRunHealthCheck?: () => void;
  readonly onReconnect?: () => void;
  readonly onOpenTargetSettings?: () => void;
  readonly onViewLogs?: () => void;
}): JSX.Element {
  return (
    <div className="oc2-doctor">
      {props.checks.slice(0, 4).map((c) => (
        <div
          key={c.id}
          className={`oc2-doctor-row ${c.status === 'error' ? 'oc2-red' : 'oc2-amber'}`}
        >
          <span>{c.status === 'error' ? '✕' : '⚠'}</span>
          <span>
            <strong>{c.name}</strong> — {c.message}
          </span>
          {c.details ? <span className="oc2-dim">{c.details}</span> : null}
        </div>
      ))}
      <div className="oc2-doctor-row">
        {props.onReconnect ? (
          <button className="btn-ghost" type="button" onClick={props.onReconnect}>
            Reconnect OpenClaw
          </button>
        ) : null}
        {props.onOpenTargetSettings ? (
          <button className="btn-ghost" type="button" onClick={props.onOpenTargetSettings}>
            Open Target Settings
          </button>
        ) : null}
        {props.onRunHealthCheck ? (
          <button className="btn-ghost" type="button" onClick={props.onRunHealthCheck}>
            Run Health Check
          </button>
        ) : null}
        {props.onViewLogs ? (
          <button className="btn-ghost" type="button" onClick={props.onViewLogs}>
            View Logs
          </button>
        ) : null}
      </div>
    </div>
  );
}

function RunHistory(props: {
  readonly runs: readonly OpenClawRunRecord[];
  readonly loading: boolean;
}): JSX.Element {
  if (props.loading) {
    return (
      <div className="oc2-runs-msg">
        <span className="mini-spinner" /> Loading runs...
      </div>
    );
  }
  if (props.runs.length === 0) {
    return <div className="oc2-runs-msg">No run history for this job.</div>;
  }
  return (
    <div className="oc2-runs">
      {props.runs.slice(0, 8).map((r) => (
        <div key={r.runId} className="oc2-run">
          <span className={`badge ${statusTone(r.status)}`}>{r.status}</span>
          <span className="oc2-dim">{formatRelativeTime(r.startedAt)}</span>
          <span className="oc2-dim mono">{formatDurationMs(r.durationMs)}</span>
          {r.sessionId ? (
            <button
              className="oc2-session-link"
              onClick={() => navigate('sessions', { sessionId: r.sessionId! })}
            >
              {parseSessionOrigin(r.sessionId).icon} {r.sessionId}
            </button>
          ) : null}
          {r.error ? <span className="oc2-run-err">{r.error}</span> : null}
        </div>
      ))}
    </div>
  );
}
