import { useMemo, useState, useEffect, useCallback } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { IconActivity } from '../../components/Icons';
import { HealthBadge } from '../../components/badges/HealthBadge';
import { cachedFetch, getCacheStats, invalidateCache } from '../../hooks/useApiCache';
import { AuthSettingsSection } from './AuthSettingsSection';
import { FleetAlertsSection } from './FleetAlertsSection';
import { FleetPoliciesSection } from './FleetPoliciesSection';
import { DiffViewer } from '../../components/DiffViewer';
import { navigate } from '../../shell/routes';
import type { ConnectionStatus, FrontendUnifiedSnapshot } from '../../types';
import type { OpenClawConfigSnapshot } from '@patze/telemetry-core';

function ConfigHistorySection(props: {
  readonly baseUrl: string;
  readonly token: string;
  readonly connected: boolean;
  readonly selectedTargetId: string | null;
}): JSX.Element {
  const [snapshots, setSnapshots] = useState<readonly OpenClawConfigSnapshot[]>([]);
  const [selectedSnap, setSelectedSnap] = useState<OpenClawConfigSnapshot | null>(null);
  const [previousSnap, setPreviousSnap] = useState<OpenClawConfigSnapshot | null>(null);
  const [rollbackPending, setRollbackPending] = useState(false);
  const [rollbackResult, setRollbackResult] = useState<string | null>(null);
  const [confirmRollbackId, setConfirmRollbackId] = useState<string | null>(null);

  const targetId = props.selectedTargetId;

  const fetchSnapshots = useCallback(async () => {
    if (!props.connected || !targetId) {
      setSnapshots([]);
      return;
    }
    try {
      const res = await cachedFetch(
        `${props.baseUrl}/openclaw/targets/${encodeURIComponent(targetId)}/config-snapshots`,
        {
          headers: buildAuthHeaders(props.token),
          ttlMs: 10_000,
        }
      );
      if (res.ok) {
        const data = (await res.json()) as { snapshots?: OpenClawConfigSnapshot[] };
        setSnapshots(data.snapshots ?? []);
      }
    } catch {
      /* ignore */
    }
  }, [props.baseUrl, props.token, props.connected, targetId]);

  useEffect(() => {
    void fetchSnapshots();
  }, [fetchSnapshots]);

  const doRollback = useCallback(
    async (snapId: string) => {
      if (!targetId) {
        setRollbackResult('Select an OpenClaw target before rollback.');
        return;
      }
      setRollbackPending(true);
      setRollbackResult(null);
      try {
        const res = await fetch(
          `${props.baseUrl}/openclaw/targets/${encodeURIComponent(targetId)}/config-snapshots/${encodeURIComponent(snapId)}/rollback`,
          {
            method: 'POST',
            headers: buildAuthHeaders(props.token, true),
          }
        );
        if (res.ok) {
          setRollbackResult('Rollback applied successfully');
          invalidateCache('/openclaw/');
          void fetchSnapshots();
        } else {
          setRollbackResult(`Rollback failed (HTTP ${res.status})`);
        }
      } catch {
        setRollbackResult('Rollback failed — network error');
      } finally {
        setRollbackPending(false);
      }
    },
    [props.baseUrl, props.token, targetId, fetchSnapshots]
  );

  const handleRollback = useCallback((snapId: string) => {
    setConfirmRollbackId(snapId);
  }, []);

  const viewDiff = useCallback(
    (snap: OpenClawConfigSnapshot, idx: number) => {
      setSelectedSnap(snap);
      setPreviousSnap(idx < snapshots.length - 1 ? (snapshots[idx + 1] ?? null) : null);
    },
    [snapshots]
  );

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Config History</h3>
      {!props.connected ? (
        <p className="doctor-hint">Connect to view config history.</p>
      ) : !targetId ? (
        <p className="doctor-hint">Select a specific OpenClaw target to view config history.</p>
      ) : snapshots.length === 0 ? (
        <p className="doctor-hint">
          No config snapshots yet. Changes applied via the Command Queue will appear here.
        </p>
      ) : (
        <>
          {rollbackResult ? (
            <div
              className={`doctor-issue ${rollbackResult.includes('success') ? 'doctor-issue-info' : 'doctor-issue-error'}`}
              style={{ marginBottom: 8 }}
            >
              <span>{rollbackResult}</span>
              <button type="button" className="btn-ghost" onClick={() => setRollbackResult(null)}>
                Dismiss
              </button>
            </div>
          ) : null}
          <div className="config-history-list">
            {snapshots.slice(0, 20).map((snap, idx) => (
              <div key={snap.id} className="config-history-item">
                <div className="config-history-meta">
                  <span className="config-history-source badge tone-neutral">{snap.source}</span>
                  <span className="config-history-time">
                    {new Date(snap.timestamp).toLocaleString()}
                  </span>
                </div>
                <span className="config-history-desc">{snap.description}</span>
                <div className="config-history-actions">
                  <button type="button" className="btn-ghost" onClick={() => viewDiff(snap, idx)}>
                    Diff
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    disabled={rollbackPending}
                    onClick={() => void handleRollback(snap.id)}
                  >
                    {rollbackPending ? 'Rolling back...' : 'Rollback'}
                  </button>
                </div>
              </div>
            ))}
          </div>
          {selectedSnap ? (
            <div style={{ marginTop: 12 }}>
              <DiffViewer
                before={previousSnap?.configContent ?? '(no previous snapshot)'}
                after={selectedSnap.configContent}
                title={`Snapshot: ${selectedSnap.id}`}
              />
              <button
                type="button"
                className="btn-ghost"
                style={{ marginTop: 6 }}
                onClick={() => setSelectedSnap(null)}
              >
                Close Diff
              </button>
            </div>
          ) : null}
        </>
      )}

      {confirmRollbackId ? (
        <ConfirmDialog
          title="Rollback Config"
          message="Rollback to this config snapshot? Current config will be overwritten."
          variant="warn"
          confirmLabel="Rollback"
          onConfirm={() => {
            const id = confirmRollbackId;
            setConfirmRollbackId(null);
            void doRollback(id);
          }}
          onCancel={() => setConfirmRollbackId(null)}
        />
      ) : null}
    </div>
  );
}

function UpdateSection(): JSX.Element {
  const [checking, setChecking] = useState(false);
  const [updateStatus, setUpdateStatus] = useState<
    'idle' | 'checking' | 'available' | 'up-to-date' | 'error'
  >('idle');
  const [updateInfo, setUpdateInfo] = useState<string | null>(null);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [releaseUrl, setReleaseUrl] = useState<string | null>(null);

  const parseVersion = useCallback((value: string): [number, number, number] => {
    const normalized = value.trim().replace(/^v/i, '');
    const [majorRaw, minorRaw, patchRaw] = normalized.split('.');
    const major = Number(majorRaw ?? '0');
    const minor = Number(minorRaw ?? '0');
    const patch = Number((patchRaw ?? '0').split('-')[0] ?? '0');
    return [
      Number.isFinite(major) ? major : 0,
      Number.isFinite(minor) ? minor : 0,
      Number.isFinite(patch) ? patch : 0,
    ];
  }, []);

  const isVersionNewer = useCallback(
    (current: string, latest: string): boolean => {
      const a = parseVersion(current);
      const b = parseVersion(latest);
      if (b[0] !== a[0]) return b[0] > a[0];
      if (b[1] !== a[1]) return b[1] > a[1];
      return b[2] > a[2];
    },
    [parseVersion]
  );

  const checkForUpdates = useCallback(async () => {
    setChecking(true);
    setUpdateStatus('checking');
    setLatestVersion(null);
    setReleaseUrl(null);
    try {
      const latestReleaseUrl =
        import.meta.env.VITE_RELEASES_LATEST_URL ??
        'https://api.github.com/repos/patyagami/patze-control/releases/latest';
      const res = await fetch(latestReleaseUrl, {
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        setUpdateStatus('error');
        setUpdateInfo(`Unable to check updates (HTTP ${String(res.status)}).`);
        return;
      }
      const data = (await res.json()) as {
        tag_name?: string;
        html_url?: string;
        published_at?: string;
      };
      const latestTag = typeof data.tag_name === 'string' ? data.tag_name : '';
      if (!latestTag) {
        setUpdateStatus('error');
        setUpdateInfo('Release feed returned no tag_name.');
        return;
      }
      const newer = isVersionNewer(__APP_VERSION__, latestTag);
      setLatestVersion(latestTag);
      setReleaseUrl(typeof data.html_url === 'string' ? data.html_url : null);
      if (newer) {
        setUpdateStatus('available');
        setUpdateInfo(
          `Update available (${latestTag}). Published ${data.published_at ? new Date(data.published_at).toLocaleString() : 'recently'}.`
        );
      } else {
        setUpdateStatus('up-to-date');
        setUpdateInfo(`You're on the latest version (${__APP_VERSION__}).`);
      }
    } catch {
      setUpdateStatus('error');
      setUpdateInfo('Unable to check updates — network error.');
    } finally {
      setChecking(false);
    }
  }, [isVersionNewer]);

  return (
    <div className="settings-section">
      <h3 className="settings-section-title">Updates</h3>
      <div className="settings-row">
        <span className="settings-row-label">Current Version</span>
        <span className="settings-row-value">{__APP_VERSION__}</span>
      </div>
      <div className="settings-row">
        <span className="settings-row-label">Status</span>
        <span className="settings-row-value">
          {updateStatus === 'idle'
            ? 'Not checked'
            : updateStatus === 'checking'
              ? 'Checking...'
              : updateStatus === 'available'
                ? 'Update available!'
                : updateStatus === 'error'
                  ? 'Check failed'
                  : 'Up to date'}
        </span>
      </div>
      {latestVersion ? (
        <div className="settings-row">
          <span className="settings-row-label">Latest Release</span>
          <span className="settings-row-value">{latestVersion}</span>
        </div>
      ) : null}
      {updateInfo ? (
        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', marginTop: 4 }}>
          {updateInfo}
        </p>
      ) : null}
      <div className="fleet-policy-actions" style={{ marginTop: 8 }}>
        <button
          type="button"
          className="btn-primary"
          onClick={() => void checkForUpdates()}
          disabled={checking}
        >
          {checking ? 'Checking...' : 'Check for Updates'}
        </button>
        {updateStatus === 'available' && releaseUrl ? (
          <button
            type="button"
            className="btn-secondary"
            onClick={() => window.open(releaseUrl, '_blank', 'noopener,noreferrer')}
          >
            Open Release
          </button>
        ) : null}
      </div>
    </div>
  );
}

export interface SettingsViewProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly baseUrl: string;
  readonly token: string;
  readonly status: ConnectionStatus;
  readonly selectedTargetId: string | null;
  readonly onBaseUrlChange: (value: string) => void;
  readonly onTokenChange: (value: string) => void;
  readonly onConnect: () => void;
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000;
const SMART_FLEET_V2_ENABLED = (import.meta.env.VITE_SMART_FLEET_V2_ENABLED ?? '1') !== '0';
const DEV_DIAGNOSTICS_ENABLED = import.meta.env.DEV;

interface DoctorReconcileCandidate {
  readonly targetId: string;
  readonly label: string;
  readonly reasons: readonly string[];
  readonly consecutiveFailures: number;
  readonly stale: boolean;
  readonly available: boolean;
  readonly running: boolean;
}

interface DoctorVerifySummary {
  readonly baseline: number;
  readonly after: number;
  readonly resolved: number;
  readonly remaining: number;
  readonly checkedAt: string;
}

interface OpenClawReadinessCheck {
  readonly id:
    | 'bridge-connected'
    | 'targets-available'
    | 'sync-running'
    | 'recent-runs'
    | 'auth-mode';
  readonly status: 'ok' | 'warn' | 'error';
  readonly title: string;
  readonly detail: string;
  readonly actionHints: readonly string[];
}

interface OpenClawReadinessResponse {
  readonly ok: boolean;
  readonly score: number;
  readonly checks: readonly OpenClawReadinessCheck[];
  readonly rootCause?: {
    readonly severity: 'error' | 'warn' | 'ok';
    readonly detail: string;
  };
  readonly summary: {
    readonly bridgeConnections: number;
    readonly targets: number;
    readonly syncRunningTargets: number;
    readonly recentRuns: number;
    readonly authMode: 'none' | 'token';
  };
}

interface OperationJournalEntry {
  readonly operationId: string;
  readonly type: string;
  readonly targetId?: string;
  readonly status: 'started' | 'succeeded' | 'failed';
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly message: string;
  readonly error?: string;
}

interface OpenClawTargetInfo {
  readonly id: string;
  readonly label: string;
  readonly type: 'local' | 'remote';
  readonly origin?: 'user' | 'auto' | 'smoke';
  readonly purpose?: 'production' | 'test';
  readonly enabled: boolean;
  readonly openclawDir: string;
}

interface OpenClawSyncStatusInfo {
  readonly running: boolean;
  readonly available: boolean;
  readonly jobsCount: number;
  readonly consecutiveFailures: number;
  readonly stale: boolean;
  readonly lastSuccessfulSyncAt?: string;
}

interface TargetSyncStatusEntry {
  readonly target: OpenClawTargetInfo;
  readonly syncStatus: OpenClawSyncStatusInfo;
}

interface OpenClawHealthCheck {
  readonly id: string;
  readonly name: string;
  readonly status: 'ok' | 'warn' | 'error';
  readonly message: string;
}

interface OpenClawTargetHealthResponse {
  readonly ok: boolean;
  readonly target: string;
  readonly checks: readonly OpenClawHealthCheck[];
  readonly cliAvailable: boolean;
  readonly cliVersion: string | null;
}

interface FleetTargetRuntimeState {
  readonly targetId: string;
  readonly reported?: {
    readonly machineId?: string;
  };
}

function buildAuthHeaders(token: string, includeJson = false): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token.length > 0) headers.Authorization = `Bearer ${token}`;
  if (includeJson) headers['Content-Type'] = 'application/json';
  return headers;
}

function isNoiseTargetForUi(target: OpenClawTargetInfo): boolean {
  if (target.purpose === 'test') return true;
  if (target.origin === 'smoke') return true;
  const label = target.label.trim();
  if (/^ui smoke target/i.test(label) || /^smoke target/i.test(label)) return true;
  return /patze-smoke/i.test(target.openclawDir);
}

function hasRealRuntime(entry: TargetSyncStatusEntry): boolean {
  return (
    entry.syncStatus.running ||
    entry.syncStatus.available ||
    Boolean(entry.syncStatus.lastSuccessfulSyncAt)
  );
}

export function SettingsView(props: SettingsViewProps): JSX.Element {
  const { snapshot, baseUrl, status } = props;
  const health = snapshot?.health;
  const [doctorRun, setDoctorRun] = useState(false);
  const [doctorActionPending, setDoctorActionPending] = useState(false);
  const [doctorActionMessage, setDoctorActionMessage] = useState<string | null>(null);
  const [doctorPlanPending, setDoctorPlanPending] = useState(false);
  const [doctorPlanCandidates, setDoctorPlanCandidates] = useState<
    readonly DoctorReconcileCandidate[]
  >([]);
  const [doctorVerifyPending, setDoctorVerifyPending] = useState(false);
  const [doctorVerifySummary, setDoctorVerifySummary] = useState<DoctorVerifySummary | null>(null);
  const [doctorPlanConfig, setDoctorPlanConfig] = useState({
    minConsecutiveFailures: 2,
    includeStale: true,
    includeUnavailable: true,
  });
  const [readiness, setReadiness] = useState<OpenClawReadinessResponse | null>(null);
  const [readinessPending, setReadinessPending] = useState(false);
  const [readinessFixPending, setReadinessFixPending] = useState(false);
  const [readinessMessage, setReadinessMessage] = useState<string | null>(null);
  const [operations, setOperations] = useState<readonly OperationJournalEntry[]>([]);
  const [testRunPending, setTestRunPending] = useState(false);
  const [testRunMessage, setTestRunMessage] = useState<string | null>(null);
  const [testRunLastRunId, setTestRunLastRunId] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<'core' | 'fleet' | 'advanced'>('core');
  const [targetEntries, setTargetEntries] = useState<readonly TargetSyncStatusEntry[]>([]);
  const [targetsPending, setTargetsPending] = useState(false);
  const [selectedOpsTargetId, setSelectedOpsTargetId] = useState<string | null>(
    props.selectedTargetId
  );
  const [selectedTargetHealth, setSelectedTargetHealth] =
    useState<OpenClawTargetHealthResponse | null>(null);
  const [targetHealthPending, setTargetHealthPending] = useState(false);
  const [targetActionPending, setTargetActionPending] = useState(false);
  const [targetActionMessage, setTargetActionMessage] = useState<string | null>(null);
  const [fleetRuntimeByTargetId, setFleetRuntimeByTargetId] = useState<
    Readonly<Record<string, FleetTargetRuntimeState>>
  >({});
  const showTestTargets = (import.meta.env.VITE_SHOW_TEST_TARGETS ?? '0') === '1';
  const isConnected = status === 'connected' || status === 'degraded';
  const showCore = activeSection === 'core';
  const showFleet = activeSection === 'fleet';
  const showAdvanced = activeSection === 'advanced';

  const doctorResults = useMemo(() => {
    if (!snapshot) return null;

    const now = Date.now();
    const sessions = snapshot.sessions;
    const runs = snapshot.runs;
    const machines = snapshot.machines;

    type DoctorIssue = {
      severity: 'error' | 'warn' | 'info';
      message: string;
      fixLabel?: string;
      fixAction?: string;
    };

    const issues: DoctorIssue[] = [];
    let score = 100;

    const staleSessions = sessions.filter((s) => {
      const isActive = !['completed', 'failed', 'cancelled'].includes(s.state);
      if (!isActive) return false;
      return now - new Date(s.updatedAt).getTime() > STALE_THRESHOLD_MS;
    });
    if (staleSessions.length > 0) {
      score -= Math.min(20, staleSessions.length * 5);
      issues.push({
        severity: 'warn',
        message: `${staleSessions.length} stale session(s) — active but no update for >5 min`,
      });
    }

    const orphanedRuns = runs.filter((r) => !sessions.some((s) => s.sessionId === r.sessionId));
    if (orphanedRuns.length > 0) {
      score -= Math.min(15, orphanedRuns.length * 3);
      issues.push({
        severity: 'warn',
        message: `${orphanedRuns.length} orphaned run(s) — session no longer tracked`,
      });
    }

    const offlineMachines = machines.filter((m) => m.status === 'offline');
    if (offlineMachines.length > 0) {
      score -= offlineMachines.length * 5;
      issues.push({
        severity: 'info',
        message: `${offlineMachines.length} offline machine(s)`,
      });
    }

    const degradedMachines = machines.filter((m) => m.status === 'degraded');
    if (degradedMachines.length > 0) {
      score -= degradedMachines.length * 10;
      issues.push({
        severity: 'warn',
        message: `${degradedMachines.length} degraded machine(s) — check bridge connectivity`,
        fixLabel: 'Reconcile unhealthy targets',
        fixAction: 'reconcile-unhealthy-targets',
      });
    }

    const failedRuns = health?.failedRunsTotal ?? 0;
    if (failedRuns > 0) {
      score -= Math.min(25, failedRuns * 2);
      issues.push({
        severity: 'error',
        message: `${failedRuns} failed run(s) detected`,
        fixLabel: 'Reconcile unhealthy targets',
        fixAction: 'reconcile-unhealthy-targets',
      });
    }

    const emptySessions = sessions.filter((s) => {
      const hasRuns = runs.some((r) => r.sessionId === s.sessionId);
      return !hasRuns && ['completed', 'failed', 'cancelled'].includes(s.state);
    });
    if (emptySessions.length > 5) {
      score -= 5;
      issues.push({
        severity: 'info',
        message: `${emptySessions.length} empty terminated sessions — consider cleanup via Session Analysis`,
      });
    }

    const cacheStats = getCacheStats();
    if (cacheStats.entries > 400) {
      issues.push({
        severity: 'info',
        message: `API cache is ${Math.round((cacheStats.entries / cacheStats.maxEntries) * 100)}% full (${cacheStats.entries}/${cacheStats.maxEntries})`,
        fixLabel: 'Flush cache',
        fixAction: 'flush-cache',
      });
    }

    if (health?.overall === 'degraded') {
      score -= 15;
    }

    score = Math.max(0, Math.min(100, score));

    if (issues.length === 0) {
      issues.push({ severity: 'info', message: 'All systems healthy — no issues detected' });
    }

    return {
      score,
      issues,
      totalEvents: snapshot.recentEvents.length,
      totalLogs: snapshot.logs.length,
      totalSessions: sessions.length,
      totalRuns: runs.length,
    };
  }, [snapshot, health]);

  const handleDoctorFix = useCallback(
    async (fixAction: string): Promise<void> => {
      if (doctorActionPending) return;
      if (fixAction === 'flush-cache') {
        invalidateCache();
        setDoctorActionMessage('API cache flushed.');
        setDoctorRun(false);
        return;
      }
      if (fixAction === 'reconcile-unhealthy-targets') {
        setDoctorActionMessage(
          'Use Playbook controls below: Preview Plan first, then Apply Playbook.'
        );
      }
    },
    [doctorActionPending]
  );

  const runDoctorPlaybook = useCallback(
    async (dryRun: boolean): Promise<void> => {
      if (dryRun) {
        setDoctorPlanPending(true);
      } else {
        setDoctorActionPending(true);
      }
      if (!dryRun) {
        setDoctorActionMessage(null);
        setDoctorVerifySummary(null);
      }
      try {
        const res = await fetch(`${props.baseUrl}/doctor/actions/reconcile-unhealthy-targets`, {
          method: 'POST',
          ...(props.token.length > 0
            ? {
                headers: {
                  Authorization: `Bearer ${props.token}`,
                  'Content-Type': 'application/json',
                },
              }
            : { headers: { 'Content-Type': 'application/json' } }),
          body: JSON.stringify({
            minConsecutiveFailures: doctorPlanConfig.minConsecutiveFailures,
            includeStale: doctorPlanConfig.includeStale,
            includeUnavailable: doctorPlanConfig.includeUnavailable,
            dryRun,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          const msg = dryRun
            ? `Preview plan failed (HTTP ${String(res.status)}).`
            : `Apply playbook failed (HTTP ${String(res.status)}).`;
          setDoctorActionMessage(msg);
          return;
        }
        const data = (await res.json()) as {
          candidates?: DoctorReconcileCandidate[];
          attempted?: number;
          restarted?: number;
          skipped?: number;
        };
        setDoctorPlanCandidates(data.candidates ?? []);
        if (dryRun) {
          setDoctorVerifySummary(null);
          setDoctorActionMessage(
            `Preview: ${String(data.attempted ?? 0)} candidate target(s) match current playbook strategy.`
          );
        } else {
          const baselineCandidates = data.candidates ?? [];
          const baselineSet = new Set(baselineCandidates.map((candidate) => candidate.targetId));
          setDoctorActionMessage(
            `Apply completed: attempted ${String(data.attempted ?? 0)}, restarted ${String(
              data.restarted ?? 0
            )}, skipped ${String(data.skipped ?? 0)}. Verifying...`
          );
          setDoctorVerifyPending(true);
          try {
            await new Promise<void>((resolve) => {
              setTimeout(() => resolve(), 1_500);
            });
            const verifyRes = await fetch(
              `${props.baseUrl}/doctor/actions/reconcile-unhealthy-targets`,
              {
                method: 'POST',
                ...(props.token.length > 0
                  ? {
                      headers: {
                        Authorization: `Bearer ${props.token}`,
                        'Content-Type': 'application/json',
                      },
                    }
                  : { headers: { 'Content-Type': 'application/json' } }),
                body: JSON.stringify({
                  minConsecutiveFailures: doctorPlanConfig.minConsecutiveFailures,
                  includeStale: doctorPlanConfig.includeStale,
                  includeUnavailable: doctorPlanConfig.includeUnavailable,
                  dryRun: true,
                }),
                signal: AbortSignal.timeout(10_000),
              }
            );
            if (verifyRes.ok) {
              const verifyData = (await verifyRes.json()) as {
                candidates?: DoctorReconcileCandidate[];
              };
              const afterCandidates = verifyData.candidates ?? [];
              setDoctorPlanCandidates(afterCandidates);
              const remaining = afterCandidates.filter((candidate) =>
                baselineSet.has(candidate.targetId)
              ).length;
              const resolved = Math.max(0, baselineSet.size - remaining);
              setDoctorVerifySummary({
                baseline: baselineSet.size,
                after: afterCandidates.length,
                resolved,
                remaining,
                checkedAt: new Date().toISOString(),
              });
              setDoctorActionMessage(
                `Apply completed. Verify: resolved ${String(resolved)}/${String(
                  baselineSet.size
                )}, remaining ${String(remaining)} (total unhealthy now ${String(afterCandidates.length)}).`
              );
            } else {
              setDoctorActionMessage(
                `Apply completed, but verify failed (HTTP ${String(verifyRes.status)}).`
              );
            }
          } catch {
            setDoctorActionMessage('Apply completed, but verify failed — network error.');
          } finally {
            setDoctorVerifyPending(false);
          }
          invalidateCache('/openclaw/');
          props.onConnect();
          setDoctorRun(false);
        }
      } catch {
        setDoctorActionMessage(
          dryRun ? 'Preview plan failed — network error.' : 'Apply playbook failed — network error.'
        );
      } finally {
        if (dryRun) {
          setDoctorPlanPending(false);
        } else {
          setDoctorActionPending(false);
        }
      }
    },
    [doctorPlanConfig, props.baseUrl, props.onConnect, props.token]
  );

  const sendTelemetryTestRun = useCallback(async (): Promise<void> => {
    if (testRunPending) return;
    setTestRunPending(true);
    setTestRunMessage(null);
    setTestRunLastRunId(null);
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (props.token.length > 0) {
        headers.Authorization = `Bearer ${props.token}`;
      }

      const seed = Date.now();
      const runId = `run_manual_test_${String(seed)}`;
      const sessionId = `session_manual_test_${String(seed)}`;
      const agentId = 'agent_manual_test';
      const machineId = `machine_manual_test_${String(seed)}`;
      const traceId = `trace_manual_test_${String(seed)}`;
      const startTs = new Date().toISOString();
      const endTs = new Date(Date.now() + 1_000).toISOString();
      const events = [
        {
          version: 'telemetry.v1',
          id: `manual-test-running-${String(seed)}`,
          ts: startTs,
          machineId,
          severity: 'info',
          type: 'run.state.changed',
          payload: {
            runId,
            sessionId,
            agentId,
            from: 'queued',
            to: 'running',
          },
          trace: {
            traceId,
          },
        },
        {
          version: 'telemetry.v1',
          id: `manual-test-completed-${String(seed)}`,
          ts: endTs,
          machineId,
          severity: 'info',
          type: 'run.state.changed',
          payload: {
            runId,
            sessionId,
            agentId,
            from: 'running',
            to: 'completed',
          },
          trace: {
            traceId,
          },
        },
      ] as const;

      for (const event of events) {
        const response = await fetch(`${props.baseUrl}/ingest`, {
          method: 'POST',
          headers,
          body: JSON.stringify(event),
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) {
          setTestRunMessage(`Send test run failed (HTTP ${String(response.status)}).`);
          return;
        }
      }

      setTestRunLastRunId(runId);
      setTestRunMessage(`Test run sent: ${runId} (running -> completed). Open Runs to verify.`);
    } catch {
      setTestRunMessage('Send test run failed — network error.');
    } finally {
      setTestRunPending(false);
    }
  }, [props.baseUrl, props.token, testRunPending]);

  const refreshOpenClawReadiness = useCallback(async (): Promise<void> => {
    if (!isConnected) {
      setReadiness(null);
      setOperations([]);
      setReadinessMessage('Connect to run OpenClaw readiness checks.');
      return;
    }
    setReadinessPending(true);
    try {
      const headers = buildAuthHeaders(props.token);
      const [readinessRes, operationsRes] = await Promise.all([
        fetch(`${props.baseUrl}/openclaw/readiness`, {
          headers,
          signal: AbortSignal.timeout(8_000),
        }),
        fetch(`${props.baseUrl}/operations/recent?limit=12`, {
          headers,
          signal: AbortSignal.timeout(8_000),
        }),
      ]);
      if (!readinessRes.ok) {
        setReadinessMessage(`Readiness check failed (HTTP ${String(readinessRes.status)}).`);
        return;
      }
      const readinessData = (await readinessRes.json()) as OpenClawReadinessResponse;
      setReadiness(readinessData);
      setReadinessMessage(null);
      if (operationsRes.ok) {
        const operationsData = (await operationsRes.json()) as {
          operations?: OperationJournalEntry[];
        };
        setOperations(operationsData.operations ?? []);
      } else {
        setOperations([]);
      }
    } catch {
      setReadinessMessage('Cannot verify OpenClaw readiness right now — network error.');
    } finally {
      setReadinessPending(false);
    }
  }, [isConnected, props.baseUrl, props.token]);

  const runReadinessFix = useCallback(
    async (
      action: 'create_default_target' | 'restart_sync_all' | 'reconcile_unhealthy'
    ): Promise<void> => {
      if (readinessFixPending) return;
      setReadinessFixPending(true);
      setReadinessMessage(null);
      try {
        const headers = buildAuthHeaders(props.token, true);
        const res = await fetch(`${props.baseUrl}/openclaw/readiness/fix`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ action }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          setReadinessMessage(`Readiness fix failed (HTTP ${String(res.status)}).`);
          return;
        }
        setReadinessMessage(`Readiness fix executed: ${action}.`);
        await refreshOpenClawReadiness();
      } catch {
        setReadinessMessage('Readiness fix failed — network error.');
      } finally {
        setReadinessFixPending(false);
      }
    },
    [props.baseUrl, props.token, readinessFixPending, refreshOpenClawReadiness]
  );

  const refreshTargetStatuses = useCallback(async (): Promise<void> => {
    if (!isConnected) {
      setTargetEntries([]);
      setSelectedTargetHealth(null);
      return;
    }
    setTargetsPending(true);
    try {
      const [targetsRes, fleetRes] = await Promise.all([
        fetch(`${props.baseUrl}/openclaw/targets`, {
          headers: buildAuthHeaders(props.token),
          signal: AbortSignal.timeout(8_000),
        }),
        fetch(`${props.baseUrl}/fleet/targets`, {
          headers: buildAuthHeaders(props.token),
          signal: AbortSignal.timeout(8_000),
        }),
      ]);
      if (!targetsRes.ok) {
        setTargetActionMessage(
          `Failed to load OpenClaw targets (HTTP ${String(targetsRes.status)}).`
        );
        return;
      }
      const data = (await targetsRes.json()) as { targets?: TargetSyncStatusEntry[] };
      const entries = data.targets ?? [];
      setTargetEntries(entries);
      if (fleetRes.ok) {
        const fleetData = (await fleetRes.json()) as { targets?: FleetTargetRuntimeState[] };
        const nextFleetRuntimeByTargetId: Record<string, FleetTargetRuntimeState> = {};
        for (const item of fleetData.targets ?? []) {
          nextFleetRuntimeByTargetId[item.targetId] = item;
        }
        setFleetRuntimeByTargetId(nextFleetRuntimeByTargetId);
      } else {
        setFleetRuntimeByTargetId({});
      }
      if (entries.length === 0) {
        setSelectedOpsTargetId(null);
        setSelectedTargetHealth(null);
        return;
      }
      const hasSelected = selectedOpsTargetId
        ? entries.some((entry) => entry.target.id === selectedOpsTargetId)
        : false;
      if (!hasSelected) {
        setSelectedOpsTargetId(entries[0]?.target.id ?? null);
      }
    } catch {
      setTargetActionMessage('Failed to load OpenClaw targets — network error.');
    } finally {
      setTargetsPending(false);
    }
  }, [isConnected, props.baseUrl, props.token, selectedOpsTargetId]);

  const refreshSelectedTargetHealth = useCallback(async (): Promise<void> => {
    if (!isConnected || !selectedOpsTargetId) {
      setSelectedTargetHealth(null);
      return;
    }
    setTargetHealthPending(true);
    try {
      const res = await fetch(
        `${props.baseUrl}/openclaw/targets/${encodeURIComponent(selectedOpsTargetId)}/health`,
        {
          headers: buildAuthHeaders(props.token),
          signal: AbortSignal.timeout(8_000),
        }
      );
      if (!res.ok) {
        setTargetActionMessage(`Health check failed (HTTP ${String(res.status)}).`);
        return;
      }
      const data = (await res.json()) as OpenClawTargetHealthResponse;
      setSelectedTargetHealth(data);
    } catch {
      setTargetActionMessage('Health check failed — network error.');
    } finally {
      setTargetHealthPending(false);
    }
  }, [isConnected, props.baseUrl, props.token, selectedOpsTargetId]);

  const reconcileSelectedTarget = useCallback(async (): Promise<void> => {
    if (!selectedOpsTargetId || targetActionPending) return;
    setTargetActionPending(true);
    setTargetActionMessage(null);
    try {
      const res = await fetch(
        `${props.baseUrl}/fleet/targets/${encodeURIComponent(selectedOpsTargetId)}/reconcile`,
        {
          method: 'POST',
          headers: buildAuthHeaders(props.token),
          signal: AbortSignal.timeout(10_000),
        }
      );
      if (!res.ok) {
        setTargetActionMessage(`Reconcile failed (HTTP ${String(res.status)}).`);
        return;
      }
      setTargetActionMessage('Reconcile started for selected target.');
      await Promise.all([
        refreshOpenClawReadiness(),
        refreshTargetStatuses(),
        refreshSelectedTargetHealth(),
      ]);
    } catch {
      setTargetActionMessage('Reconcile failed — network error.');
    } finally {
      setTargetActionPending(false);
    }
  }, [
    selectedOpsTargetId,
    targetActionPending,
    props.baseUrl,
    props.token,
    refreshOpenClawReadiness,
    refreshTargetStatuses,
    refreshSelectedTargetHealth,
  ]);

  const restartAllSync = useCallback(async (): Promise<void> => {
    if (targetActionPending) return;
    setTargetActionPending(true);
    setTargetActionMessage(null);
    try {
      await runReadinessFix('restart_sync_all');
      await Promise.all([refreshTargetStatuses(), refreshSelectedTargetHealth()]);
      setTargetActionMessage('Restart sync executed for all targets.');
    } finally {
      setTargetActionPending(false);
    }
  }, [targetActionPending, runReadinessFix, refreshTargetStatuses, refreshSelectedTargetHealth]);

  const visibleTargetEntries = useMemo(
    () =>
      targetEntries.filter((entry) => {
        if (showTestTargets) return true;
        return !isNoiseTargetForUi(entry.target);
      }),
    [showTestTargets, targetEntries]
  );
  const activeRuntimeTargetEntries = useMemo(
    () => visibleTargetEntries.filter((entry) => hasRealRuntime(entry)),
    [visibleTargetEntries]
  );
  const hiddenTestTargetsCount = Math.max(0, targetEntries.length - visibleTargetEntries.length);
  const selectedTargetEntry = useMemo(
    () =>
      activeRuntimeTargetEntries.find((entry) => entry.target.id === selectedOpsTargetId) ?? null,
    [activeRuntimeTargetEntries, selectedOpsTargetId]
  );
  const selectedFleetRuntime = selectedTargetEntry
    ? fleetRuntimeByTargetId[selectedTargetEntry.target.id]
    : undefined;
  const selectedRemoteTruth = useMemo(() => {
    if (!selectedTargetEntry || selectedTargetEntry.target.type !== 'remote') return null;
    const hasBridge = Boolean(selectedFleetRuntime?.reported?.machineId);
    if (!hasBridge) return { tone: 'error', label: 'Bridge Missing' } as const;
    if (!selectedTargetEntry.syncStatus.running && !selectedTargetEntry.syncStatus.available) {
      return { tone: 'warn', label: 'Tunnel/Sync Missing' } as const;
    }
    if (selectedTargetEntry.syncStatus.running && selectedTargetEntry.syncStatus.available) {
      return { tone: 'ok', label: 'Remote Connected' } as const;
    }
    return { tone: 'warn', label: 'Remote Partial' } as const;
  }, [selectedFleetRuntime?.reported?.machineId, selectedTargetEntry]);

  const rootTruth = useMemo((): {
    tone: 'ok' | 'warn' | 'error';
    summary: string;
    action: string | null;
  } | null => {
    if (!selectedTargetEntry) return null;

    const sync = selectedTargetEntry.syncStatus;
    const isRemote = selectedTargetEntry.target.type === 'remote';
    const checks = selectedTargetHealth?.checks ?? [];
    const errorChecks = checks.filter((c) => c.status === 'error');
    const warnChecks = checks.filter((c) => c.status === 'warn');

    if (isRemote && !selectedFleetRuntime?.reported?.machineId) {
      return {
        tone: 'error',
        summary: 'No bridge reporting for this remote target. Install and connect bridge first.',
        action: 'tunnels',
      };
    }

    const homeCheck = errorChecks.find((c) => c.id === 'openclaw-home');
    if (homeCheck) {
      return {
        tone: 'error',
        summary: `OpenClaw directory not found: ${homeCheck.message}`,
        action: isRemote ? 'tunnels' : null,
      };
    }

    const cronCheck = errorChecks.find((c) => c.id === 'cron-dir');
    if (cronCheck) {
      return {
        tone: 'error',
        summary: `Cron directory missing: ${cronCheck.message}`,
        action: null,
      };
    }

    const jobsCheck = errorChecks.find((c) => c.id === 'jobs-json');
    if (jobsCheck) {
      return {
        tone: 'error',
        summary: 'jobs.json not found. OpenClaw may not be installed or initialized.',
        action: null,
      };
    }

    if (!sync.running && !sync.available) {
      return {
        tone: 'error',
        summary: 'Sync loop is not running and target is unavailable. Restart sync or check path.',
        action: null,
      };
    }

    if (sync.consecutiveFailures >= 3) {
      return {
        tone: 'error',
        summary: `${String(sync.consecutiveFailures)} consecutive sync failures. Check target connectivity.`,
        action: null,
      };
    }

    if (sync.stale) {
      return {
        tone: 'warn',
        summary: 'Sync data is stale. Last successful sync was too long ago.',
        action: null,
      };
    }

    if (errorChecks.length > 0) {
      return {
        tone: 'error',
        summary: `${String(errorChecks.length)} error(s): ${errorChecks.map((c) => c.name).join(', ')}`,
        action: null,
      };
    }

    if (warnChecks.length > 0) {
      return {
        tone: 'warn',
        summary: `${String(warnChecks.length)} warning(s): ${warnChecks.map((c) => c.name).join(', ')}`,
        action: null,
      };
    }

    return {
      tone: 'ok',
      summary: 'All checks passed. OpenClaw is connected and operational.',
      action: null,
    };
  }, [selectedFleetRuntime?.reported?.machineId, selectedTargetEntry, selectedTargetHealth]);

  useEffect(() => {
    void refreshOpenClawReadiness();
  }, [refreshOpenClawReadiness]);

  useEffect(() => {
    if (props.selectedTargetId && props.selectedTargetId !== selectedOpsTargetId) {
      setSelectedOpsTargetId(props.selectedTargetId);
    }
  }, [props.selectedTargetId, selectedOpsTargetId]);

  useEffect(() => {
    if (activeRuntimeTargetEntries.length === 0) {
      setSelectedOpsTargetId(null);
      setSelectedTargetHealth(null);
      return;
    }
    const hasSelected = selectedOpsTargetId
      ? activeRuntimeTargetEntries.some((entry) => entry.target.id === selectedOpsTargetId)
      : false;
    if (!hasSelected) {
      setSelectedOpsTargetId(activeRuntimeTargetEntries[0]?.target.id ?? null);
    }
  }, [activeRuntimeTargetEntries, selectedOpsTargetId]);

  useEffect(() => {
    void refreshTargetStatuses();
  }, [refreshTargetStatuses]);

  useEffect(() => {
    void refreshSelectedTargetHealth();
  }, [refreshSelectedTargetHealth]);

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Settings</h2>
        <div className="settings-section-tabs" role="tablist" aria-label="Settings sections">
          <button
            type="button"
            role="tab"
            className={`settings-section-tab ${showCore ? 'active' : ''}`}
            aria-selected={showCore}
            onClick={() => setActiveSection('core')}
          >
            Core
          </button>
          <button
            type="button"
            role="tab"
            className={`settings-section-tab ${showFleet ? 'active' : ''}`}
            aria-selected={showFleet}
            onClick={() => setActiveSection('fleet')}
          >
            Fleet
          </button>
          <button
            type="button"
            role="tab"
            className={`settings-section-tab ${showAdvanced ? 'active' : ''}`}
            aria-selected={showAdvanced}
            onClick={() => setActiveSection('advanced')}
          >
            Advanced
          </button>
        </div>
      </div>

      <div className="settings-grid">
        {showCore ? (
          <div className="settings-section">
            <h3 className="settings-section-title">Connection</h3>
            <div className="settings-row">
              <span className="settings-row-label">Endpoint</span>
              <span className="settings-row-value">{baseUrl}</span>
            </div>
            <div className="settings-row">
              <span className="settings-row-label">Status</span>
              <span className="settings-row-value">{status}</span>
            </div>
          </div>
        ) : null}

        {showFleet ? (
          <div className="settings-section settings-section-diagnostics">
            <h3 className="settings-section-title">Diagnostics</h3>
            <div className="settings-smart-actions">
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  navigate('tunnels');
                }}
              >
                Connections
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  navigate('tasks', { taskView: 'openclaw' });
                }}
              >
                OpenClaw Jobs
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  navigate('runs');
                }}
              >
                Runs
              </button>
              <button
                type="button"
                className="btn-ghost"
                onClick={() => {
                  void refreshOpenClawReadiness();
                }}
              >
                Refresh
              </button>
            </div>
            <div className="settings-kpi-grid">
              <div className="settings-kpi-card">
                <span className="settings-kpi-label">Overall</span>
                <span className="settings-kpi-value">
                  <HealthBadge health={health ? health.overall : 'not connected'} />
                </span>
              </div>
              <div className="settings-kpi-card">
                <span className="settings-kpi-label">Machines</span>
                <span className="settings-kpi-value">{health?.machines.length ?? 0}</span>
              </div>
              <div className="settings-kpi-card">
                <span className="settings-kpi-label">Active Runs</span>
                <span className="settings-kpi-value">{health?.activeRunsTotal ?? 0}</span>
              </div>
              <div className="settings-kpi-card">
                <span className="settings-kpi-label">Failed Runs</span>
                <span className="settings-kpi-value">{health?.failedRunsTotal ?? 0}</span>
              </div>
              <div className="settings-kpi-card">
                <span className="settings-kpi-label">Bridge</span>
                <span className="settings-kpi-value">
                  {String(readiness?.summary.bridgeConnections ?? 0)}
                </span>
              </div>
              <div className="settings-kpi-card">
                <span className="settings-kpi-label">Targets</span>
                <span className="settings-kpi-value">
                  {String(readiness?.summary.targets ?? 0)}
                </span>
              </div>
            </div>
            <div className="settings-readiness-score">
              <div className="settings-readiness-score-head">
                <span className="settings-row-label">Readiness Score</span>
                <span className="settings-row-value">
                  {readinessPending
                    ? 'Checking…'
                    : readiness
                      ? `${String(readiness.score)} / 100`
                      : '-'}
                </span>
              </div>
              <div className="settings-readiness-score-bar">
                <span
                  className={`settings-readiness-score-fill ${
                    (readiness?.score ?? 0) >= 80
                      ? 'is-good'
                      : (readiness?.score ?? 0) >= 60
                        ? 'is-warn'
                        : 'is-bad'
                  }`}
                  style={{ width: `${String(Math.max(0, Math.min(100, readiness?.score ?? 0)))}%` }}
                />
              </div>
              {readiness?.rootCause ? (
                <p className="doctor-hint" style={{ marginTop: 8, marginBottom: 0 }}>
                  {`Root cause: ${readiness.rootCause.detail}`}
                </p>
              ) : null}
            </div>
            {readinessMessage ? (
              <div className="doctor-issue doctor-issue-info">
                <span className="doctor-issue-msg">{readinessMessage}</span>
              </div>
            ) : null}
            {readiness ? (
              <div className="settings-readiness-grid">
                {readiness.checks.map((check) => (
                  <div
                    key={check.id}
                    className={`settings-readiness-card status-${
                      check.status === 'error' ? 'error' : check.status === 'warn' ? 'warn' : 'ok'
                    }`}
                  >
                    <div className="settings-readiness-card-head">
                      <span className="doctor-issue-badge">{check.status.toUpperCase()}</span>
                      <span className="settings-readiness-card-title">{check.title}</span>
                    </div>
                    <p className="settings-readiness-card-detail">{check.detail}</p>
                    <div className="settings-readiness-card-actions">
                      {check.id === 'targets-available' ? (
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={readinessFixPending}
                          onClick={() => {
                            void runReadinessFix('create_default_target');
                          }}
                        >
                          {readinessFixPending ? 'Working…' : 'Create Default Target'}
                        </button>
                      ) : null}
                      {check.id === 'sync-running' ? (
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={readinessFixPending}
                          onClick={() => {
                            void runReadinessFix('restart_sync_all');
                          }}
                        >
                          {readinessFixPending ? 'Working…' : 'Restart Sync'}
                        </button>
                      ) : null}
                      {check.id === 'bridge-connected' ? (
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => {
                            navigate('tunnels');
                          }}
                        >
                          Open Connections
                        </button>
                      ) : null}
                      {check.id === 'recent-runs' ? (
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => {
                            navigate('runs');
                          }}
                        >
                          Open Runs
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
            {operations.length > 0 ? (
              <div style={{ marginTop: 8 }}>
                <h4 className="section-subtitle" style={{ marginBottom: 8 }}>
                  Recent Operations
                </h4>
                <div className="doctor-playbook-list">
                  {operations.slice(0, 8).map((entry) => (
                    <div key={entry.operationId} className="doctor-playbook-item">
                      <span className="mono">{`${entry.type} · ${entry.status}`}</span>
                      <span className="doctor-hint">{entry.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}
            {DEV_DIAGNOSTICS_ENABLED ? (
              <>
                <div className="settings-row">
                  <span className="settings-row-label">Telemetry Test</span>
                  <span className="settings-row-value">
                    <button
                      type="button"
                      className="btn-secondary"
                      disabled={!isConnected || testRunPending}
                      onClick={() => {
                        void sendTelemetryTestRun();
                      }}
                    >
                      {testRunPending ? 'Sending...' : 'Send test run event'}
                    </button>
                  </span>
                </div>
                {testRunMessage ? (
                  <div
                    style={{
                      marginTop: 8,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                    }}
                  >
                    <p className="doctor-hint" style={{ margin: 0 }}>
                      {testRunMessage}
                    </p>
                    {testRunLastRunId ? (
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => {
                          navigate('runs');
                        }}
                      >
                        Open Runs
                      </button>
                    ) : null}
                  </div>
                ) : null}
              </>
            ) : null}
            <div className="settings-section settings-openclaw-live-control">
              <h3 className="settings-section-title">OpenClaw Live Control</h3>
              {!isConnected ? (
                <p className="doctor-hint">Connect to manage OpenClaw targets.</p>
              ) : activeRuntimeTargetEntries.length === 0 ? (
                <div className="settings-live-empty">
                  <p className="doctor-hint">
                    {visibleTargetEntries.length > 0
                      ? 'Waiting for real OpenClaw runtime. Connect bridge/remote first, then refresh.'
                      : targetEntries.length > 0
                        ? 'Only test/smoke targets found. Production targets are hidden by default.'
                        : 'No OpenClaw targets found.'}
                  </p>
                  <button
                    type="button"
                    className="btn-primary"
                    disabled={targetActionPending}
                    onClick={() => {
                      void runReadinessFix('create_default_target');
                    }}
                  >
                    Create Default Target
                  </button>
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => {
                      navigate('tunnels');
                    }}
                  >
                    Open Remote Connections
                  </button>
                </div>
              ) : (
                <div className="settings-live-grid">
                  {hiddenTestTargetsCount > 0 ? (
                    <p className="doctor-hint">
                      {`Hidden ${String(hiddenTestTargetsCount)} test/smoke target(s) to reduce UI noise.`}
                    </p>
                  ) : null}
                  <div className="settings-live-row">
                    <label className="settings-row-label" htmlFor="settings-openclaw-target-select">
                      Active Target
                    </label>
                    <select
                      id="settings-openclaw-target-select"
                      className="fleet-policy-select"
                      value={selectedOpsTargetId ?? ''}
                      onChange={(event) => setSelectedOpsTargetId(event.target.value)}
                    >
                      {activeRuntimeTargetEntries.map((entry) => (
                        <option key={entry.target.id} value={entry.target.id}>
                          {entry.target.label}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn-ghost"
                      disabled={targetsPending}
                      onClick={() => {
                        void refreshTargetStatuses();
                      }}
                    >
                      {targetsPending ? 'Refreshing...' : 'Refresh Targets'}
                    </button>
                  </div>
                  {selectedTargetEntry ? (
                    <>
                      <div className="settings-live-chips">
                        <span
                          className={`badge ${selectedTargetEntry.syncStatus.running ? 'tone-ok' : 'tone-error'}`}
                        >
                          {selectedTargetEntry.syncStatus.running ? 'running' : 'stopped'}
                        </span>
                        <span
                          className={`badge ${selectedTargetEntry.syncStatus.available ? 'tone-ok' : 'tone-warn'}`}
                        >
                          {selectedTargetEntry.syncStatus.available ? 'available' : 'unavailable'}
                        </span>
                        <span
                          className={`badge ${selectedTargetEntry.syncStatus.stale ? 'tone-warn' : 'tone-ok'}`}
                        >
                          {selectedTargetEntry.syncStatus.stale ? 'stale' : 'fresh'}
                        </span>
                        <span className="badge tone-neutral">
                          jobs: {String(selectedTargetEntry.syncStatus.jobsCount)}
                        </span>
                        <span className="badge tone-neutral">
                          failures: {String(selectedTargetEntry.syncStatus.consecutiveFailures)}
                        </span>
                        {selectedRemoteTruth ? (
                          <span className={`badge tone-${selectedRemoteTruth.tone}`}>
                            {selectedRemoteTruth.label}
                          </span>
                        ) : null}
                      </div>
                      <div className="settings-live-actions">
                        <button
                          type="button"
                          className="btn-secondary"
                          disabled={targetActionPending || !selectedOpsTargetId}
                          onClick={() => {
                            void reconcileSelectedTarget();
                          }}
                        >
                          {targetActionPending ? 'Working...' : 'Reconcile Selected'}
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={targetActionPending}
                          onClick={() => {
                            void restartAllSync();
                          }}
                        >
                          Restart All Sync
                        </button>
                        <button
                          type="button"
                          className="btn-ghost"
                          disabled={targetHealthPending || !selectedOpsTargetId}
                          onClick={() => {
                            void refreshSelectedTargetHealth();
                          }}
                        >
                          {targetHealthPending ? 'Checking...' : 'Refresh Health'}
                        </button>
                      </div>
                      <div className="settings-live-meta">
                        <span className="mono">{selectedTargetEntry.target.id}</span>
                        <span className="mono">{selectedTargetEntry.target.openclawDir}</span>
                        {selectedTargetEntry.syncStatus.lastSuccessfulSyncAt ? (
                          <span className="mono">
                            {`last sync ${new Date(selectedTargetEntry.syncStatus.lastSuccessfulSyncAt).toLocaleString()}`}
                          </span>
                        ) : null}
                      </div>
                      {selectedTargetHealth ? (
                        <div className="settings-live-health-list">
                          {selectedTargetHealth.checks.slice(0, 6).map((check) => (
                            <div
                              key={check.id}
                              className={`doctor-issue doctor-issue-${check.status}`}
                            >
                              <span className="doctor-issue-badge">
                                {check.status.toUpperCase()}
                              </span>
                              <span className="doctor-issue-msg">{`${check.name}: ${check.message}`}</span>
                            </div>
                          ))}
                          <p className="doctor-hint" style={{ marginBottom: 0 }}>
                            {selectedTargetHealth.cliAvailable
                              ? `CLI detected: ${selectedTargetHealth.cliVersion ?? 'unknown'}`
                              : 'OpenClaw CLI not detected on current runtime.'}
                          </p>
                        </div>
                      ) : null}
                      {rootTruth ? (
                        <div className={`settings-root-truth tone-${rootTruth.tone}`}>
                          <span className="settings-root-truth-label">Root Truth</span>
                          <span className="settings-root-truth-summary">{rootTruth.summary}</span>
                          {rootTruth.action === 'tunnels' ? (
                            <button
                              type="button"
                              className="btn-ghost"
                              onClick={() => {
                                navigate('tunnels');
                              }}
                            >
                              Open Connections
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </>
                  ) : null}
                </div>
              )}
              {targetActionMessage ? <p className="doctor-hint">{targetActionMessage}</p> : null}
            </div>
          </div>
        ) : null}

        {showCore ? (
          <>
            <div className="settings-section">
              <h3 className="settings-section-title">About</h3>
              <div className="settings-row">
                <span className="settings-row-label">App</span>
                <span className="settings-row-value">Patze Control Desktop</span>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">Version</span>
                <span className="settings-row-value">{__APP_VERSION__}</span>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">Telemetry Schema</span>
                <span className="settings-row-value">telemetry.v1</span>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">Framework</span>
                <span className="settings-row-value">Tauri 2 + React 18</span>
              </div>
            </div>
            <UpdateSection />
          </>
        ) : null}

        {showAdvanced ? (
          <>
            <AuthSettingsSection
              baseUrl={baseUrl}
              token={props.token}
              connected={isConnected}
              onBaseUrlChange={props.onBaseUrlChange}
              onTokenChange={props.onTokenChange}
              onConnect={props.onConnect}
            />
            <ConfigHistorySection
              baseUrl={baseUrl}
              token={props.token}
              connected={isConnected}
              selectedTargetId={props.selectedTargetId}
            />
          </>
        ) : null}

        {showFleet && SMART_FLEET_V2_ENABLED ? (
          <>
            <FleetAlertsSection baseUrl={baseUrl} token={props.token} connected={isConnected} />
            <FleetPoliciesSection baseUrl={baseUrl} token={props.token} connected={isConnected} />
          </>
        ) : null}

        {showAdvanced ? (
          <div className="settings-section doctor-section">
            <h3 className="settings-section-title">
              <IconActivity className="doctor-icon" />
              Doctor
            </h3>
            {doctorActionMessage ? (
              <p className="doctor-hint" style={{ marginBottom: 8 }}>
                {doctorActionMessage}
              </p>
            ) : null}
            {!snapshot ? (
              <p className="doctor-hint">Connect to a control plane to run diagnostics.</p>
            ) : !doctorRun ? (
              <div>
                <p className="doctor-hint">
                  Check for stale sessions, orphaned runs, and anomalies.
                </p>
                <button
                  className="btn-primary"
                  onClick={() => {
                    setDoctorRun(true);
                  }}
                >
                  Run Doctor
                </button>
              </div>
            ) : doctorResults ? (
              <div className="doctor-results">
                <div className="doctor-score-row">
                  <div
                    className={`doctor-score-ring ${doctorResults.score >= 80 ? 'score-good' : doctorResults.score >= 50 ? 'score-warn' : 'score-bad'}`}
                  >
                    <span className="doctor-score-value">{doctorResults.score}</span>
                    <span className="doctor-score-label">/ 100</span>
                  </div>
                  <div className="doctor-summary">
                    <span className="doctor-stat">{doctorResults.totalSessions} sessions</span>
                    <span className="doctor-stat">{doctorResults.totalRuns} runs</span>
                    <span className="doctor-stat">{doctorResults.totalEvents} events</span>
                    <span className="doctor-stat">{doctorResults.totalLogs} logs</span>
                  </div>
                </div>
                <div className="doctor-playbook">
                  <div className="doctor-playbook-header">
                    Playbook: Reconcile Unhealthy Targets
                  </div>
                  <div className="doctor-playbook-controls">
                    <label className="fleet-policy-checkbox">
                      Min failures
                      <input
                        type="number"
                        min={1}
                        step={1}
                        className="fleet-policy-input doctor-playbook-input"
                        value={String(doctorPlanConfig.minConsecutiveFailures)}
                        onChange={(event) =>
                          setDoctorPlanConfig((prev) => ({
                            ...prev,
                            minConsecutiveFailures: Math.max(1, Number(event.target.value) || 1),
                          }))
                        }
                      />
                    </label>
                    <label className="fleet-policy-checkbox">
                      <input
                        type="checkbox"
                        checked={doctorPlanConfig.includeStale}
                        onChange={(event) =>
                          setDoctorPlanConfig((prev) => ({
                            ...prev,
                            includeStale: event.target.checked,
                          }))
                        }
                      />
                      Include stale targets
                    </label>
                    <label className="fleet-policy-checkbox">
                      <input
                        type="checkbox"
                        checked={doctorPlanConfig.includeUnavailable}
                        onChange={(event) =>
                          setDoctorPlanConfig((prev) => ({
                            ...prev,
                            includeUnavailable: event.target.checked,
                          }))
                        }
                      />
                      Include unavailable/not running
                    </label>
                    <div className="fleet-policy-actions">
                      <button
                        type="button"
                        className="btn-secondary"
                        disabled={doctorPlanPending || doctorActionPending}
                        onClick={() => void runDoctorPlaybook(true)}
                      >
                        {doctorPlanPending ? 'Previewing...' : 'Preview Plan'}
                      </button>
                      <button
                        type="button"
                        className="btn-primary"
                        disabled={doctorPlanPending || doctorActionPending}
                        onClick={() => void runDoctorPlaybook(false)}
                      >
                        {doctorActionPending ? 'Applying...' : 'Apply Playbook'}
                      </button>
                    </div>
                  </div>
                  {doctorPlanCandidates.length > 0 ? (
                    <div className="doctor-playbook-list">
                      {doctorPlanCandidates.slice(0, 8).map((candidate) => (
                        <div key={candidate.targetId} className="doctor-playbook-item">
                          <span className="mono">{candidate.label}</span>
                          <span className="doctor-hint">
                            {`reasons: ${candidate.reasons.join(', ')}`}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {doctorVerifyPending ? (
                    <p className="doctor-hint" style={{ marginTop: 8, marginBottom: 0 }}>
                      Verifying post-apply health...
                    </p>
                  ) : null}
                  {doctorVerifySummary ? (
                    <p className="doctor-hint" style={{ marginTop: 8, marginBottom: 0 }}>
                      {`Verify summary: resolved ${String(doctorVerifySummary.resolved)}/${String(
                        doctorVerifySummary.baseline
                      )}, remaining ${String(doctorVerifySummary.remaining)}, checked at ${new Date(
                        doctorVerifySummary.checkedAt
                      ).toLocaleTimeString()}.`}
                    </p>
                  ) : null}
                </div>
                <div className="doctor-issues">
                  {doctorResults.issues.map((issue, i) => {
                    const fixAction = issue.fixAction;
                    return (
                      <div key={i} className={`doctor-issue doctor-issue-${issue.severity}`}>
                        <span className="doctor-issue-badge">{issue.severity.toUpperCase()}</span>
                        <span className="doctor-issue-msg">{issue.message}</span>
                        {fixAction ? (
                          <button
                            type="button"
                            className="btn-ghost doctor-fix-btn"
                            disabled={doctorActionPending}
                            onClick={() => {
                              void handleDoctorFix(fixAction);
                            }}
                          >
                            {doctorActionPending ? 'Working...' : issue.fixLabel}
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
                <button
                  className="btn-secondary"
                  style={{ marginTop: 12 }}
                  onClick={() => {
                    setDoctorRun(false);
                  }}
                >
                  Re-run
                </button>
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
