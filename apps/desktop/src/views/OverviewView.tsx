import { useMemo } from 'react';
import { ActivityFeed } from '../components/ActivityFeed';
import { GaugeBar } from '../components/GaugeBar';
import {
  IconActivity,
  IconBot,
  IconClock,
  IconLayers,
  IconMessage,
  IconServer,
  IconSettings,
  IconTerminal,
  IconZap,
} from '../components/Icons';
import { HealthBadge } from '../components/badges/HealthBadge';
import { StateBadge } from '../components/badges/StateBadge';
import type { OpenClawTargetsSummary } from '../hooks/useOpenClawTargets';
import { navigate } from '../shell/routes';
import type { AppRoute } from '../shell/routes';
import type { ConnectionStatus, FrontendUnifiedSnapshot } from '../types';
import { formatCost, formatTokenCount } from '../utils/format';
import { formatRelativeTime } from '../utils/time';

export interface OverviewViewProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly onConnect?: () => void;
  readonly bridgeCount?: number;
  readonly openclawSummary: OpenClawTargetsSummary;
  readonly status: ConnectionStatus;
}

interface CostSummary {
  totalCostUsd: number;
  totalTokens: number;
  avgCostPerRun: number;
  runsWithUsage: number;
}

function computeCostSummary(snapshot: FrontendUnifiedSnapshot): CostSummary {
  let totalCostUsd = 0;
  let totalTokens = 0;
  let runsWithUsage = 0;

  for (const detail of Object.values(snapshot.runDetails)) {
    if (detail.modelUsage) {
      totalCostUsd += detail.modelUsage.estimatedCostUsd ?? 0;
      totalTokens += detail.modelUsage.totalTokens;
      runsWithUsage += 1;
    }
  }

  return {
    totalCostUsd,
    totalTokens,
    avgCostPerRun: runsWithUsage > 0 ? totalCostUsd / runsWithUsage : 0,
    runsWithUsage,
  };
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

interface MetricCardProps {
  readonly label: string;
  readonly value: number;
  readonly accent?: string;
  readonly icon: JSX.Element;
  readonly pulse?: boolean;
  readonly danger?: boolean;
}

function MetricCard(props: MetricCardProps): JSX.Element {
  const accentVar = props.danger
    ? 'var(--red)'
    : props.accent
      ? `var(--${props.accent})`
      : 'var(--text-muted)';

  return (
    <div
      className={`ov-metric${props.pulse ? ' ov-metric-pulse' : ''}`}
      style={{ '--metric-accent': accentVar } as React.CSSProperties}
    >
      <div className="ov-metric-header">
        <span className="ov-metric-label">{props.label}</span>
        <span className="ov-metric-icon">{props.icon}</span>
      </div>
      <span className={`ov-metric-value${props.danger ? ' ov-metric-danger' : ''}`}>
        {props.value}
      </span>
    </div>
  );
}

const QUICK_LINKS: ReadonlyArray<{
  route: AppRoute;
  label: string;
  icon: (props: { width?: number; height?: number }) => JSX.Element;
  iconBg: string;
  shortcut: string;
}> = [
  { route: 'tasks', label: 'Tasks', icon: IconClock, iconBg: 'var(--amber-soft)', shortcut: '9' },
  { route: 'agents', label: 'Agents', icon: IconBot, iconBg: 'var(--blue-soft)', shortcut: '2' },
  { route: 'machines', label: 'Machines', icon: IconServer, iconBg: 'var(--accent-soft)', shortcut: '4' },
  { route: 'logs', label: 'Logs', icon: IconTerminal, iconBg: 'var(--muted-soft)', shortcut: '8' },
  { route: 'channels', label: 'Channels', icon: IconMessage, iconBg: 'var(--green-soft)', shortcut: '6' },
  { route: 'settings', label: 'Settings', icon: IconSettings, iconBg: 'var(--muted-soft)', shortcut: '0' },
];

function SuccessRateBar(props: { total: number; failed: number }): JSX.Element {
  const succeeded = props.total - props.failed;
  const pct = props.total > 0 ? (succeeded / props.total) * 100 : 100;
  const color = pct >= 90 ? 'var(--green)' : pct >= 70 ? 'var(--amber)' : 'var(--red)';

  return (
    <div className="ov-success-bar">
      <span className="ov-success-label">Success Rate</span>
      <div className="ov-success-track">
        <div className="ov-success-fill" style={{ width: `${String(pct)}%`, background: color }} />
      </div>
      <span className="ov-success-value" style={{ color }}>
        {pct.toFixed(0)}%
      </span>
      <span style={{ fontSize: 11, color: 'var(--text-dim)' }}>
        {succeeded}/{props.total}
      </span>
    </div>
  );
}

export function OverviewView(props: OverviewViewProps): JSX.Element {
  const cost = useMemo(
    () => (props.snapshot ? computeCostSummary(props.snapshot) : null),
    [props.snapshot]
  );
  const oc = props.openclawSummary;

  if (!props.snapshot) {
    return (
      <section className="view-panel">
        <div className="view-header">
          <h2 className="view-title">Overview</h2>
        </div>
        <div className="empty-state">
          <div className="empty-state-icon">
            <IconZap width={28} height={28} />
          </div>
          <p>Connect to a control plane to see live telemetry data.</p>
          {props.onConnect ? (
            <button className="btn-primary" style={{ marginTop: 8 }} onClick={props.onConnect}>
              Connect Now
            </button>
          ) : null}
        </div>
      </section>
    );
  }

  const snapshot = props.snapshot;
  const machineCount = snapshot.machines.length;
  const sessionCount = snapshot.sessions.length;
  const totalRuns = snapshot.runs.length;
  const activeRuns = snapshot.activeRuns.length;
  const failedRuns = snapshot.runs.filter((r) => r.state === 'failed').length;
  const errorLogs = snapshot.logs.filter(
    (l) => l.level === 'error' || l.level === 'critical'
  ).length;
  const fleetResource = computeFleetResource(snapshot);
  const overallHealth =
    snapshot.health.overall === 'unknown' && machineCount === 0
      ? 'healthy'
      : snapshot.health.overall;

  return (
    <section className="view-panel">
      {/* Header with inline health + last updated */}
      <div className="view-header">
        <h2 className="view-title">Overview</h2>
        <div className="ov-header-right">
          <HealthBadge health={overallHealth} />
          <span className="ov-last-updated">{formatRelativeTime(snapshot.lastUpdated)}</span>
        </div>
      </div>

      {/* Hero: Metrics + System Status */}
      <div className="ov-hero">
        {/* Primary metrics 2×2 */}
        <div className="ov-metrics">
          <MetricCard
            label="Machines"
            value={machineCount}
            accent="accent"
            icon={<IconServer width={16} height={16} />}
          />
          <MetricCard
            label="Sessions"
            value={sessionCount}
            accent="blue"
            icon={<IconLayers width={16} height={16} />}
          />
          <MetricCard
            label="Total Runs"
            value={totalRuns}
            icon={<IconActivity width={16} height={16} />}
          />
          <MetricCard
            label="Active"
            value={activeRuns}
            accent="green"
            pulse={activeRuns > 0}
            icon={<IconZap width={16} height={16} />}
          />
        </div>

        {/* System status panel */}
        <div className="ov-status-panel">
          {/* Fleet health gauges */}
          <div className="ov-status-section">
            <span className="ov-status-title">Fleet Resources</span>
            {fleetResource ? (
              <div className="ov-gauges">
                <GaugeBar label="CPU" value={fleetResource.avgCpu} />
                <GaugeBar label="Memory" value={fleetResource.avgMem} />
              </div>
            ) : (
              <span className="ov-status-nominal">
                <span className="ov-nominal-dot" />
                All systems nominal
              </span>
            )}
          </div>

          {/* Alerts */}
          {failedRuns > 0 || errorLogs > 0 ? (
            <div className="ov-status-section">
              <span className="ov-status-title">Alerts</span>
              <div className="ov-alerts">
                {failedRuns > 0 ? (
                  <button
                    className="ov-alert-chip ov-alert-bad"
                    onClick={() => {
                      navigate('runs');
                    }}
                  >
                    <span className="ov-alert-dot" />
                    {failedRuns} failed run{failedRuns !== 1 ? 's' : ''}
                  </button>
                ) : null}
                {errorLogs > 0 ? (
                  <button
                    className="ov-alert-chip ov-alert-bad"
                    onClick={() => {
                      navigate('logs');
                    }}
                  >
                    <span className="ov-alert-dot" />
                    {errorLogs} error{errorLogs !== 1 ? 's' : ''}
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}

          {/* Integrations */}
          {oc.count > 0 || (props.bridgeCount ?? 0) > 0 ? (
            <div className="ov-status-section">
              <span className="ov-status-title">Integrations</span>
              <div className="ov-integrations">
                {oc.count > 0 ? (
                  <button
                    className="ov-integration-row"
                    onClick={() => {
                      navigate('tasks', { taskView: 'openclaw' });
                    }}
                    title="Open OpenClaw tasks"
                  >
                    <span className="ov-integration-name">OpenClaw</span>
                    <span className="ov-integration-meta">
                      {oc.count} target{oc.count !== 1 ? 's' : ''} · {oc.totalJobs} jobs
                    </span>
                    <HealthBadge health={oc.overallHealth} />
                  </button>
                ) : null}
                {(props.bridgeCount ?? 0) > 0 ? (
                  <button
                    className="ov-integration-row"
                    onClick={() => {
                      navigate('tunnels');
                    }}
                    title="View bridge connections"
                  >
                    <span className="ov-integration-name">VPS Bridges</span>
                    <span className="ov-integration-meta">{props.bridgeCount} active</span>
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {/* Cost summary (compact inline) */}
      {cost && cost.runsWithUsage > 0 ? (
        <div className="ov-cost-bar">
          <div className="ov-cost-item">
            <span className="ov-cost-label">Total Cost</span>
            <span className="ov-cost-value">{formatCost(cost.totalCostUsd)}</span>
          </div>
          <span className="ov-cost-sep" />
          <div className="ov-cost-item">
            <span className="ov-cost-label">Tokens</span>
            <span className="ov-cost-value">{formatTokenCount(cost.totalTokens)}</span>
          </div>
          <span className="ov-cost-sep" />
          <div className="ov-cost-item">
            <span className="ov-cost-label">Avg / Run</span>
            <span className="ov-cost-value">{formatCost(cost.avgCostPerRun)}</span>
          </div>
          <span className="ov-cost-sep" />
          <div className="ov-cost-item">
            <span className="ov-cost-label">Runs w/ Usage</span>
            <span className="ov-cost-value">{cost.runsWithUsage}</span>
          </div>
        </div>
      ) : null}

      {/* Success Rate Bar */}
      {totalRuns > 0 ? <SuccessRateBar total={totalRuns} failed={failedRuns} /> : null}

      {/* Quick Links */}
      <div>
        <div className="ov-section-header">
          <span className="accent-line" />
          <span className="ov-section-header-label">Quick Links</span>
        </div>
        <div className="ov-quick-links">
          {QUICK_LINKS.map((link) => {
            const LinkIcon = link.icon;
            return (
              <button
                key={link.route}
                className="ov-quick-link"
                onClick={() => { navigate(link.route); }}
                title={`${link.label} (${link.shortcut})`}
              >
                <div className="ov-quick-link-icon" style={{ background: link.iconBg }}>
                  <LinkIcon width={16} height={16} />
                </div>
                <div className="ov-quick-link-body">
                  <span className="ov-quick-link-label">{link.label}</span>
                </div>
                <span className="ov-quick-link-shortcut">{link.shortcut}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Two-column data panels */}
      <div className="ov-panels">
        {/* Machines */}
        <div className="panel ov-panel-half">
          <div className="panel-header">
            <div className="ov-section-header" style={{ marginBottom: 0 }}>
              <span className="accent-line" />
              <h3 className="panel-title">Machines</h3>
            </div>
            {machineCount > 0 ? (
              <button
                className="ov-panel-link"
                onClick={() => {
                  navigate('machines');
                }}
              >
                View all
              </button>
            ) : null}
          </div>
          {snapshot.machines.length === 0 ? (
            <div className="ov-empty-compact">
              <IconServer width={20} height={20} />
              <span>No machines registered</span>
            </div>
          ) : (
            <div className="table-scroll" style={{ maxHeight: 220 }}>
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>ID</th>
                    <th>Status</th>
                    <th>CPU</th>
                    <th>Mem</th>
                    <th>Seen</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.machines.map((machine) => (
                    <tr key={machine.machineId}>
                      <td className="mono">{machine.name ?? machine.machineId.slice(0, 8)}</td>
                      <td>
                        <StateBadge value={machine.status} />
                      </td>
                      <td className="mono">
                        {machine.lastResource ? `${machine.lastResource.cpuPct.toFixed(0)}%` : '—'}
                      </td>
                      <td className="mono">
                        {machine.lastResource
                          ? `${machine.lastResource.memoryPct.toFixed(0)}%`
                          : '—'}
                      </td>
                      <td>{formatRelativeTime(machine.lastSeenAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Active Runs */}
        <div className="panel ov-panel-half">
          <div className="panel-header">
            <div className="ov-section-header" style={{ marginBottom: 0 }}>
              <span className="accent-line" />
              <h3 className="panel-title">Active Runs</h3>
            </div>
            {activeRuns > 0 ? (
              <button
                className="ov-panel-link"
                onClick={() => {
                  navigate('runs');
                }}
              >
                View all
              </button>
            ) : null}
          </div>
          {snapshot.activeRuns.length === 0 ? (
            <div className="ov-empty-compact">
              <IconActivity width={20} height={20} />
              <span>No active runs</span>
            </div>
          ) : (
            <div className="table-scroll" style={{ maxHeight: 220 }}>
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>Run</th>
                    <th>Machine</th>
                    <th>State</th>
                    <th>Updated</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.activeRuns.map((run) => (
                    <tr key={run.runId} data-active="true">
                      <td className="mono">{run.runId.slice(0, 8)}</td>
                      <td className="mono">{run.machineId.slice(0, 8)}</td>
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
      </div>

      {/* Activity Feed */}
      <ActivityFeed snapshot={snapshot} />
    </section>
  );
}
