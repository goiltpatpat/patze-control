import { Fragment, useCallback, useState } from 'react';
import { IconClock } from '../../components/Icons';
import { navigate } from '../../shell/routes';
import { parseSessionOrigin } from '../../utils/openclaw';
import { formatRelativeTime } from '../../utils/time';
import type { OpenClawCronJob, OpenClawHealthCheck, OpenClawRunRecord, OpenClawSyncStatus } from './types';
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
}

export function OpenClawJobsPanel(props: OpenClawJobsPanelProps): JSX.Element {
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
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 4 }}>
                      {job.schedule.kind === 'cron' && job.schedule.staggerMs !== undefined ? (
                        <span
                          className={`badge ${job.schedule.staggerMs > 0 ? 'tone-neutral' : 'tone-good'}`}
                        >
                          {job.schedule.staggerMs > 0
                            ? `stagger ${formatCompactMs(job.schedule.staggerMs)}`
                            : 'exact'}
                        </span>
                      ) : null}
                      {job.schedule.kind === 'every' && job.schedule.anchorMs !== undefined ? (
                        <span
                          className="badge tone-neutral"
                          title={`Anchor: ${job.schedule.anchorMs}`}
                        >
                          anchor {new Date(job.schedule.anchorMs).toLocaleTimeString()}
                        </span>
                      ) : null}
                      {job.nextRunAtMs ? (
                        <span className="badge tone-neutral">
                          next {formatNextRun(job.nextRunAtMs)}
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td>
                    <span className="badge tone-neutral">{job.execution.style}</span>
                    {job.payload?.kind ? (
                      <span className="badge tone-neutral" style={{ marginLeft: 6 }}>
                        {job.payload.kind}
                      </span>
                    ) : null}
                    {job.sessionTarget ? (
                      <span className="badge tone-neutral" style={{ marginLeft: 6 }}>
                        {job.sessionTarget}
                      </span>
                    ) : null}
                    {job.wakeMode ? (
                      <span className="badge tone-neutral" style={{ marginLeft: 6 }}>
                        wake {job.wakeMode === 'next-heartbeat' ? 'next-hb' : 'now'}
                      </span>
                    ) : null}
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
                    {job.delivery.channel ? (
                      <span
                        className="tone-muted"
                        style={{ display: 'block', fontSize: 10, marginTop: 2 }}
                      >
                        via {job.delivery.channel}
                      </span>
                    ) : null}
                    {job.delivery.to ? (
                      <span
                        className="tone-muted"
                        style={{ display: 'block', fontSize: 10, marginTop: 2 }}
                        title={job.delivery.to}
                      >
                        to {job.delivery.to}
                      </span>
                    ) : null}
                  </td>
                  <td>
                    <span className={`badge ${job.enabled ? 'tone-good' : 'tone-muted'}`}>
                      {job.enabled ? 'active' : 'paused'}
                    </span>
                    {job.lastStatus === 'skipped' ? (
                      <span className="badge tone-warn" style={{ marginLeft: 6 }}>
                        skipped
                      </span>
                    ) : null}
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
                        {job.lastDurationMs !== undefined ? (
                          <span className="tone-muted" style={{ marginLeft: 6, fontSize: 11 }}>
                            {formatDurationMs(job.lastDurationMs)}
                          </span>
                        ) : null}
                        {job.lastDelivered !== undefined ? (
                          <span
                            className={`badge ${job.lastDelivered ? 'tone-good' : 'tone-muted'}`}
                            style={{ marginLeft: 6 }}
                          >
                            {job.lastDelivered ? 'delivered' : 'not delivered'}
                          </span>
                        ) : null}
                        {job.lastError ? (
                          <span
                            className="tone-bad"
                            style={{ display: 'block', marginTop: 2, fontSize: 10 }}
                            title={job.lastError}
                          >
                            {job.lastError}
                          </span>
                        ) : null}
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
