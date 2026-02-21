import { useMemo } from 'react';
import { ActivityFeed } from '../components/ActivityFeed';
import { IconZap } from '../components/Icons';
import { MonitorPanel } from '../components/MonitorPanel';
import type { FrontendUnifiedSnapshot } from '../types';

export interface OverviewViewProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly onConnect?: () => void;
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

function formatCost(usd: number): string {
  if (usd === 0) return '$0.00';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return String(tokens);
}

export function OverviewView(props: OverviewViewProps): JSX.Element {
  if (!props.snapshot) {
    return (
      <section className="view-panel">
        <div className="view-header">
          <h2 className="view-title">Overview</h2>
        </div>
        <div className="empty-state">
          <div className="empty-state-icon"><IconZap width={28} height={28} /></div>
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
  const cost = useMemo(() => computeCostSummary(snapshot), [snapshot]);

  const machineCount = snapshot.machines.length;
  const sessionCount = snapshot.sessions.length;
  const totalRuns = snapshot.runs.length;
  const activeRuns = snapshot.activeRuns.length;
  const failedRuns = snapshot.runs.filter((r) => r.state === 'failed').length;
  const errorLogs = snapshot.logs.filter((l) => l.level === 'error' || l.level === 'critical').length;

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Overview</h2>
      </div>

      <div className="overview-stats">
        <div className="overview-stat-card">
          <span className="overview-stat-label">Machines</span>
          <span className="overview-stat-value">{String(machineCount)}</span>
        </div>
        <div className="overview-stat-card">
          <span className="overview-stat-label">Sessions</span>
          <span className="overview-stat-value">{String(sessionCount)}</span>
        </div>
        <div className="overview-stat-card">
          <span className="overview-stat-label">Total Runs</span>
          <span className="overview-stat-value">{String(totalRuns)}</span>
        </div>
        <div className="overview-stat-card">
          <span className="overview-stat-label">Active Runs</span>
          <span className="overview-stat-value">{String(activeRuns)}</span>
        </div>
        <div className="overview-stat-card">
          <span className="overview-stat-label">Failed Runs</span>
          <span className="overview-stat-value" style={failedRuns > 0 ? { color: 'var(--red)' } : undefined}>
            {String(failedRuns)}
          </span>
        </div>
        <div className="overview-stat-card">
          <span className="overview-stat-label">Error Logs</span>
          <span className="overview-stat-value" style={errorLogs > 0 ? { color: 'var(--red)' } : undefined}>
            {String(errorLogs)}
          </span>
        </div>
      </div>

      {cost.runsWithUsage > 0 ? (
        <div className="cost-summary">
          <div className="cost-stat">
            <span className="cost-stat-label">Total Cost</span>
            <span className="cost-stat-value">{formatCost(cost.totalCostUsd)}</span>
          </div>
          <div className="cost-stat">
            <span className="cost-stat-label">Total Tokens</span>
            <span className="cost-stat-value">{formatTokenCount(cost.totalTokens)}</span>
          </div>
          <div className="cost-stat">
            <span className="cost-stat-label">Avg Cost / Run</span>
            <span className="cost-stat-value">{formatCost(cost.avgCostPerRun)}</span>
          </div>
          <div className="cost-stat">
            <span className="cost-stat-label">Runs with Usage</span>
            <span className="cost-stat-value">{String(cost.runsWithUsage)}</span>
          </div>
        </div>
      ) : null}

      <MonitorPanel snapshot={snapshot} />
      <ActivityFeed snapshot={snapshot} />
    </section>
  );
}
