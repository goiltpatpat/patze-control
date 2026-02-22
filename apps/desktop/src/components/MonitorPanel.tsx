import type { FrontendUnifiedSnapshot } from '../types';
import { formatRelativeTime } from '../utils/time';
import { GaugeBar } from './GaugeBar';
import { IconZap } from './Icons';
import { HealthBadge } from './badges/HealthBadge';
import { StateBadge } from './badges/StateBadge';

export interface MonitorPanelProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
}

function computeFleetResource(
  snapshot: FrontendUnifiedSnapshot
): { avgCpu: number; avgMem: number } | null {
  const withResource = snapshot.machines.filter((m) => m.lastResource !== undefined);
  if (withResource.length === 0) {
    return null;
  }

  let totalCpu = 0;
  let totalMem = 0;
  for (const m of withResource) {
    totalCpu += m.lastResource!.cpuPct;
    totalMem += m.lastResource!.memoryPct;
  }

  return {
    avgCpu: totalCpu / withResource.length,
    avgMem: totalMem / withResource.length,
  };
}

export function MonitorPanel(props: MonitorPanelProps): JSX.Element {
  if (!props.snapshot) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">
          <IconZap width={28} height={28} />
        </div>
        Connect to a control plane to see live telemetry data.
      </div>
    );
  }

  const { machines, activeRuns, health, lastUpdated } = props.snapshot;
  const fleetResource = computeFleetResource(props.snapshot);

  return (
    <>
      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">Health</span>
          <div>
            <HealthBadge
              health={
                health.overall === 'unknown' && machines.length === 0 ? 'healthy' : health.overall
              }
            />
          </div>
        </div>
        <div className="stat-card">
          <span className="stat-label">Machines</span>
          <span className="stat-value" data-accent="cyan">
            {String(machines.length)}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Active Runs</span>
          <span className="stat-value" data-accent={activeRuns.length > 0 ? 'green' : undefined}>
            {String(activeRuns.length)}
          </span>
        </div>
        {fleetResource ? (
          <>
            <div className="stat-card">
              <span className="stat-label">Fleet CPU</span>
              <GaugeBar label="" value={fleetResource.avgCpu} />
            </div>
            <div className="stat-card">
              <span className="stat-label">Fleet Memory</span>
              <GaugeBar label="" value={fleetResource.avgMem} />
            </div>
          </>
        ) : (
          <div className="stat-card">
            <span className="stat-label">Last Updated</span>
            <span className="stat-meta" style={{ fontSize: 13, color: 'var(--text-secondary)' }}>
              {formatRelativeTime(lastUpdated)}
            </span>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3 className="panel-title">Machines</h3>
        </div>
        {machines.length === 0 ? (
          <div className="empty-state">
            <p>No machines registered yet.</p>
            <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '4px 0 0' }}>
              Connect an OpenClaw instance or VPS bridge to see machine telemetry.
            </p>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Machine ID</th>
                  <th>Label</th>
                  <th>Status</th>
                  <th>CPU</th>
                  <th>Memory</th>
                  <th>Last Seen</th>
                </tr>
              </thead>
              <tbody>
                {machines.map((machine) => (
                  <tr key={machine.machineId}>
                    <td className="mono">{machine.machineId}</td>
                    <td>{machine.name ?? '—'}</td>
                    <td>
                      <StateBadge value={machine.status} />
                    </td>
                    <td className="mono">
                      {machine.lastResource ? `${machine.lastResource.cpuPct.toFixed(0)}%` : '—'}
                    </td>
                    <td className="mono">
                      {machine.lastResource ? `${machine.lastResource.memoryPct.toFixed(0)}%` : '—'}
                    </td>
                    <td>{formatRelativeTime(machine.lastSeenAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3 className="panel-title">Active Runs</h3>
        </div>
        {activeRuns.length === 0 ? (
          <div className="empty-state">No active runs at this time.</div>
        ) : (
          <div className="table-scroll">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Run ID</th>
                  <th>Machine ID</th>
                  <th>Session ID</th>
                  <th>State</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {activeRuns.map((run) => (
                  <tr key={run.runId} data-active="true">
                    <td className="mono">{run.runId}</td>
                    <td className="mono">{run.machineId}</td>
                    <td className="mono">{run.sessionId}</td>
                    <td>
                      <StateBadge value={run.state} />
                      <span className="inline-loading">
                        <span className="mini-spinner" />
                      </span>
                    </td>
                    <td>{formatRelativeTime(run.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
