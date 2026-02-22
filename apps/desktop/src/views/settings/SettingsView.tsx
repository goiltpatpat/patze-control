import { useMemo, useState } from 'react';
import { IconActivity } from '../../components/Icons';
import { HealthBadge } from '../../components/badges/HealthBadge';
import { AuthSettingsSection } from './AuthSettingsSection';
import type { ConnectionStatus, FrontendUnifiedSnapshot } from '../../types';

export interface SettingsViewProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly baseUrl: string;
  readonly token: string;
  readonly status: ConnectionStatus;
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

export function SettingsView(props: SettingsViewProps): JSX.Element {
  const { snapshot, baseUrl, status } = props;
  const health = snapshot?.health;
  const [doctorRun, setDoctorRun] = useState(false);
  const isConnected = status === 'connected' || status === 'degraded';

  const doctorResults = useMemo(() => {
    if (!snapshot) {
      return null;
    }

    const now = Date.now();
    const sessions = snapshot.sessions;
    const runs = snapshot.runs;
    const machines = snapshot.machines;

    const staleSessions = sessions.filter((s) => {
      const isActive = !['completed', 'failed', 'cancelled'].includes(s.state);
      if (!isActive) {
        return false;
      }
      const lastUpdate = new Date(s.updatedAt).getTime();
      return now - lastUpdate > STALE_THRESHOLD_MS;
    });

    const orphanedRuns = runs.filter((r) => {
      const hasSession = sessions.some((s) => s.sessionId === r.sessionId);
      return !hasSession;
    });

    const offlineMachines = machines.filter((m) => m.status === 'offline');

    const issues: Array<{ severity: 'warn' | 'error' | 'info'; message: string }> = [];

    if (staleSessions.length > 0) {
      issues.push({
        severity: 'warn',
        message: `${staleSessions.length} stale session(s) — active but no update for >5 minutes`,
      });
    }

    if (orphanedRuns.length > 0) {
      issues.push({
        severity: 'warn',
        message: `${orphanedRuns.length} orphaned run(s) — session no longer tracked`,
      });
    }

    if (offlineMachines.length > 0) {
      issues.push({
        severity: 'info',
        message: `${offlineMachines.length} offline machine(s)`,
      });
    }

    if ((health?.failedRunsTotal ?? 0) > 0) {
      issues.push({
        severity: 'error',
        message: `${health?.failedRunsTotal ?? 0} failed run(s) detected`,
      });
    }

    if (issues.length === 0) {
      issues.push({ severity: 'info', message: 'All systems healthy — no issues detected' });
    }

    return {
      issues,
      totalEvents: snapshot.recentEvents.length,
      totalLogs: snapshot.logs.length,
      totalSessions: sessions.length,
      totalRuns: runs.length,
    };
  }, [snapshot, health]);

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Settings</h2>
      </div>

      <div className="settings-grid">
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

        <div className="settings-section">
          <h3 className="settings-section-title">Diagnostics</h3>
          <div className="settings-row">
            <span className="settings-row-label">Overall Health</span>
            <span className="settings-row-value">
              <HealthBadge health={health ? health.overall : 'not connected'} />
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Machines</span>
            <span className="settings-row-value">{health?.machines.length ?? 0}</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Stale Machines</span>
            <span className="settings-row-value">{health?.staleMachinesTotal ?? 0}</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Active Runs</span>
            <span className="settings-row-value">{health?.activeRunsTotal ?? 0}</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Failed Runs</span>
            <span className="settings-row-value">{health?.failedRunsTotal ?? 0}</span>
          </div>
        </div>

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

        <AuthSettingsSection baseUrl={baseUrl} token={props.token} connected={isConnected} />

        <div className="settings-section doctor-section">
          <h3 className="settings-section-title">
            <IconActivity className="doctor-icon" />
            Doctor
          </h3>
          {!snapshot ? (
            <p className="doctor-hint">Connect to a control plane to run diagnostics.</p>
          ) : !doctorRun ? (
            <div>
              <p className="doctor-hint">Check for stale sessions, orphaned runs, and anomalies.</p>
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
              <div className="doctor-summary">
                <span className="doctor-stat">{doctorResults.totalSessions} sessions</span>
                <span className="doctor-stat">{doctorResults.totalRuns} runs</span>
                <span className="doctor-stat">{doctorResults.totalEvents} events</span>
                <span className="doctor-stat">{doctorResults.totalLogs} logs</span>
              </div>
              <div className="doctor-issues">
                {doctorResults.issues.map((issue, i) => (
                  <div key={i} className={`doctor-issue doctor-issue-${issue.severity}`}>
                    <span className="doctor-issue-badge">{issue.severity.toUpperCase()}</span>
                    <span>{issue.message}</span>
                  </div>
                ))}
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
      </div>
    </section>
  );
}
