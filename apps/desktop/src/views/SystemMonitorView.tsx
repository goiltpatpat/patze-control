import { useMemo, useRef } from 'react';
import { GaugeBar } from '../components/GaugeBar';
import { IconActivity, IconZap } from '../components/Icons';
import { HealthBadge } from '../components/badges/HealthBadge';
import { StateBadge } from '../components/badges/StateBadge';
import type { FleetTargetStatus } from '../hooks/useSmartFleet';
import type { FrontendUnifiedSnapshot } from '../types';
import { formatBytes, formatRate } from '../utils/format';
import { formatRelativeTime } from '../utils/time';

export interface SystemMonitorViewProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly smartFleetTargets: readonly FleetTargetStatus[];
  readonly smartFleetEnabled: boolean;
}

interface NetworkSample {
  readonly netRxBytes: number;
  readonly netTxBytes: number;
  readonly tsMs: number;
}

type FrontendMachineSnapshot = FrontendUnifiedSnapshot['machines'][number];

interface MachineComputedMetrics {
  readonly machine: FrontendMachineSnapshot;
  readonly rxRateBytesPerSec: number;
  readonly txRateBytesPerSec: number;
  readonly memoryTotalBytes: number | null;
}

interface FleetSummary {
  readonly avgCpuPct: number;
  readonly avgMemoryPct: number;
  readonly avgDiskPct: number | null;
  readonly totalMemoryUsedBytes: number;
  readonly totalMemoryBytes: number | null;
  readonly totalDiskUsedBytes: number;
  readonly totalDiskBytes: number | null;
  readonly totalRxRateBytesPerSec: number;
  readonly totalTxRateBytesPerSec: number;
}

function computeMemoryTotalBytes(machine: FrontendMachineSnapshot): number | null {
  const resource = machine.lastResource;
  if (!resource) return null;
  if (resource.memoryTotalBytes !== undefined && resource.memoryTotalBytes > 0) {
    return resource.memoryTotalBytes;
  }
  if (resource.memoryPct <= 0) return null;
  return (resource.memoryBytes * 100) / resource.memoryPct;
}

function computeFleetSummary(metrics: readonly MachineComputedMetrics[]): FleetSummary | null {
  const withResource = metrics.filter((m) => m.machine.lastResource !== undefined);
  if (withResource.length === 0) {
    return null;
  }

  let totalCpu = 0;
  let totalMemoryPct = 0;
  let totalDiskPct = 0;
  let diskCount = 0;
  let totalMemoryUsedBytes = 0;
  let totalMemoryBytes = 0;
  let memoryTotalCount = 0;
  let totalDiskUsedBytes = 0;
  let totalDiskBytes = 0;
  let diskTotalCount = 0;
  let totalRxRateBytesPerSec = 0;
  let totalTxRateBytesPerSec = 0;

  for (const item of withResource) {
    const resource = item.machine.lastResource!;
    totalCpu += resource.cpuPct;
    totalMemoryPct += resource.memoryPct;
    if (resource.diskPct !== undefined) {
      totalDiskPct += resource.diskPct;
      diskCount += 1;
    }
    totalMemoryUsedBytes += resource.memoryBytes;
    if (item.memoryTotalBytes !== null) {
      totalMemoryBytes += item.memoryTotalBytes;
      memoryTotalCount += 1;
    }
    if (resource.diskUsageBytes !== undefined) {
      totalDiskUsedBytes += resource.diskUsageBytes;
    }
    if (resource.diskTotalBytes !== undefined) {
      totalDiskBytes += resource.diskTotalBytes;
      diskTotalCount += 1;
    }
    totalRxRateBytesPerSec += item.rxRateBytesPerSec;
    totalTxRateBytesPerSec += item.txRateBytesPerSec;
  }

  return {
    avgCpuPct: totalCpu / withResource.length,
    avgMemoryPct: totalMemoryPct / withResource.length,
    avgDiskPct: diskCount > 0 ? totalDiskPct / diskCount : null,
    totalMemoryUsedBytes,
    totalMemoryBytes: memoryTotalCount > 0 ? totalMemoryBytes : null,
    totalDiskUsedBytes,
    totalDiskBytes: diskTotalCount > 0 ? totalDiskBytes : null,
    totalRxRateBytesPerSec,
    totalTxRateBytesPerSec,
  };
}

export function SystemMonitorView(props: SystemMonitorViewProps): JSX.Element {
  const previousSamplesRef = useRef<Map<string, NetworkSample>>(new Map());

  const machineMetrics = useMemo((): readonly MachineComputedMetrics[] => {
    if (!props.snapshot) {
      return [];
    }
    const nowMs = Date.parse(props.snapshot.lastUpdated);
    const sampleTsMs = Number.isNaN(nowMs) ? Date.now() : nowMs;
    const activeMachineIds = new Set<string>();

    const next = props.snapshot.machines.map((machine): MachineComputedMetrics => {
      activeMachineIds.add(machine.machineId);
      const resource = machine.lastResource;
      let rxRateBytesPerSec = 0;
      let txRateBytesPerSec = 0;

      if (resource?.netRxBytes !== undefined && resource.netTxBytes !== undefined) {
        const previous = previousSamplesRef.current.get(machine.machineId);
        if (previous) {
          const dtSec = Math.max((sampleTsMs - previous.tsMs) / 1000, 1);
          rxRateBytesPerSec = Math.max(0, (resource.netRxBytes - previous.netRxBytes) / dtSec);
          txRateBytesPerSec = Math.max(0, (resource.netTxBytes - previous.netTxBytes) / dtSec);
        }
        previousSamplesRef.current.set(machine.machineId, {
          netRxBytes: resource.netRxBytes,
          netTxBytes: resource.netTxBytes,
          tsMs: sampleTsMs,
        });
      }

      return {
        machine,
        rxRateBytesPerSec,
        txRateBytesPerSec,
        memoryTotalBytes: computeMemoryTotalBytes(machine),
      };
    });

    for (const machineId of previousSamplesRef.current.keys()) {
      if (!activeMachineIds.has(machineId)) {
        previousSamplesRef.current.delete(machineId);
      }
    }

    return next;
  }, [props.snapshot]);

  const fleet = useMemo(() => computeFleetSummary(machineMetrics), [machineMetrics]);
  const smartFleetSummary = useMemo(() => {
    if (!props.smartFleetEnabled || props.smartFleetTargets.length === 0) return null;
    const totalScore = props.smartFleetTargets.reduce((sum, target) => sum + target.healthScore, 0);
    const driftCount = props.smartFleetTargets.reduce(
      (sum, target) => sum + target.drifts.length,
      0
    );
    const violationCount = props.smartFleetTargets.reduce(
      (sum, target) => sum + target.violations.length,
      0
    );
    return {
      avgHealthScore: totalScore / props.smartFleetTargets.length,
      driftCount,
      violationCount,
    };
  }, [props.smartFleetEnabled, props.smartFleetTargets]);

  if (!props.snapshot) {
    return (
      <section className="view-panel monitor-view">
        <div className="view-header">
          <h2 className="view-title">System Monitor</h2>
        </div>
        <div className="empty-state">
          <div className="empty-state-icon">
            <IconZap width={28} height={28} />
          </div>
          <p>Connect to a control plane to see live telemetry data.</p>
        </div>
      </section>
    );
  }

  const health =
    props.snapshot.health.overall === 'unknown' && props.snapshot.machines.length === 0
      ? 'healthy'
      : props.snapshot.health.overall;

  return (
    <section className="view-panel monitor-view">
      <div className="view-header">
        <h2 className="view-title">System Monitor</h2>
        <div className="ov-header-right">
          <HealthBadge health={health} />
          <span className="ov-last-updated">{formatRelativeTime(props.snapshot.lastUpdated)}</span>
        </div>
      </div>

      <div className="stats-grid">
        <div className="stat-card">
          <span className="stat-label">Machines</span>
          <span className="stat-value" data-accent="cyan">
            {String(props.snapshot.machines.length)}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Active Runs</span>
          <span
            className="stat-value"
            data-accent={props.snapshot.activeRuns.length > 0 ? 'green' : undefined}
          >
            {String(props.snapshot.activeRuns.length)}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Network Rx</span>
          <span className="stat-value monitor-stat-rate">
            {fleet ? formatRate(fleet.totalRxRateBytesPerSec) : '0 B/s'}
          </span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Network Tx</span>
          <span className="stat-value monitor-stat-rate">
            {fleet ? formatRate(fleet.totalTxRateBytesPerSec) : '0 B/s'}
          </span>
        </div>
        {smartFleetSummary ? (
          <>
            <div className="stat-card">
              <span className="stat-label">Fleet Health Score</span>
              <span className="stat-value" data-accent="cyan">
                {smartFleetSummary.avgHealthScore.toFixed(0)}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Fleet Drifts</span>
              <span
                className="stat-value"
                data-accent={smartFleetSummary.driftCount > 0 ? 'yellow' : 'green'}
              >
                {String(smartFleetSummary.driftCount)}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Fleet Violations</span>
              <span
                className="stat-value"
                data-accent={smartFleetSummary.violationCount > 0 ? 'red' : 'green'}
              >
                {String(smartFleetSummary.violationCount)}
              </span>
            </div>
          </>
        ) : null}
      </div>

      {fleet ? (
        <div className="panel monitor-fleet-panel">
          <div className="panel-header">
            <h3 className="panel-title">Fleet Resources</h3>
          </div>
          <div className="monitor-fleet-grid">
            <div>
              <GaugeBar label="CPU Used" value={fleet.avgCpuPct} />
            </div>
            <div>
              <GaugeBar label="Memory Used" value={fleet.avgMemoryPct} />
              <div className="monitor-meta">
                {fleet.totalMemoryBytes !== null
                  ? `${formatBytes(fleet.totalMemoryUsedBytes)} / ${formatBytes(fleet.totalMemoryBytes)}`
                  : formatBytes(fleet.totalMemoryUsedBytes)}
              </div>
            </div>
            <div>
              {fleet.avgDiskPct !== null ? (
                <>
                  <GaugeBar label="Disk Used" value={fleet.avgDiskPct} />
                  <div className="monitor-meta">
                    {fleet.totalDiskBytes !== null
                      ? `${formatBytes(fleet.totalDiskUsedBytes)} / ${formatBytes(fleet.totalDiskBytes)}`
                      : formatBytes(fleet.totalDiskUsedBytes)}
                  </div>
                </>
              ) : (
                <div className="monitor-meta">Disk telemetry unavailable</div>
              )}
            </div>
            <div className="monitor-network">
              <span className="monitor-network-label">Network Throughput</span>
              <span className="monitor-network-value">
                {`↓ ${formatRate(fleet.totalRxRateBytesPerSec)}  ↑ ${formatRate(fleet.totalTxRateBytesPerSec)}`}
              </span>
            </div>
          </div>
        </div>
      ) : null}

      <div className="monitor-machine-grid">
        {machineMetrics.map((item) => {
          const machine = item.machine;
          const resource = machine.lastResource;
          return (
            <div key={machine.machineId} className="machine-card">
              <div className="machine-card-header">
                <div className="machine-card-title">
                  <span className="machine-card-name">{machine.name ?? machine.machineId}</span>
                  <span className="machine-card-id">{machine.machineId}</span>
                </div>
                <StateBadge value={machine.status} />
              </div>

              <div className="machine-card-meta">
                <div className="machine-card-meta-item">
                  <span className="machine-card-meta-label">Last Seen</span>
                  <span className="machine-card-meta-value">
                    {formatRelativeTime(machine.lastSeenAt)}
                  </span>
                </div>
                <div className="machine-card-meta-item">
                  <span className="machine-card-meta-label">Kind</span>
                  <span className="machine-card-meta-value">{machine.kind ?? 'unknown'}</span>
                </div>
              </div>

              {resource ? (
                <div className="machine-card-gauges">
                  <GaugeBar label="CPU Used" value={resource.cpuPct} />
                  <GaugeBar label="Memory Used" value={resource.memoryPct} />
                  <div className="monitor-meta">
                    {item.memoryTotalBytes !== null
                      ? `${formatBytes(resource.memoryBytes)} / ${formatBytes(item.memoryTotalBytes)}`
                      : formatBytes(resource.memoryBytes)}
                  </div>
                  {resource.diskPct !== undefined ? (
                    <>
                      <GaugeBar label="Disk Used" value={resource.diskPct} />
                      <div className="monitor-meta">
                        {resource.diskUsageBytes !== undefined &&
                        resource.diskTotalBytes !== undefined
                          ? `${formatBytes(resource.diskUsageBytes)} / ${formatBytes(resource.diskTotalBytes)}`
                          : 'Disk usage available'}
                      </div>
                    </>
                  ) : (
                    <div className="monitor-meta">Disk telemetry unavailable</div>
                  )}
                  <div className="monitor-network-inline">
                    <span>{`↓ ${formatRate(item.rxRateBytesPerSec)}`}</span>
                    <span>{`↑ ${formatRate(item.txRateBytesPerSec)}`}</span>
                  </div>
                </div>
              ) : (
                <div className="monitor-meta">No resource metrics yet</div>
              )}
            </div>
          );
        })}
      </div>

      <div className="panel">
        <div className="panel-header">
          <h3 className="panel-title">Active Runs</h3>
        </div>
        {props.snapshot.activeRuns.length === 0 ? (
          <div className="ov-empty-compact">
            <IconActivity width={20} height={20} />
            <span>No active runs at this time</span>
          </div>
        ) : (
          <div className="table-scroll">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Run</th>
                  <th>Machine</th>
                  <th>Session</th>
                  <th>State</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {props.snapshot.activeRuns.map((run) => (
                  <tr key={run.runId}>
                    <td className="mono">{run.runId.slice(0, 12)}</td>
                    <td className="mono">{run.machineId.slice(0, 12)}</td>
                    <td className="mono">{run.sessionId.slice(0, 12)}</td>
                    <td>
                      <StateBadge value={run.state} />
                    </td>
                    <td>{formatRelativeTime(run.updatedAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
