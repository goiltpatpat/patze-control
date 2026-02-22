import { useEffect, useRef, useState } from 'react';
import type { MonitorState } from '../control-monitor';
import { HealthBadge } from '../components/badges/HealthBadge';
import { IconClock } from '../components/Icons';
import { SeverityBadge, type SeverityLevel } from '../components/badges/SeverityBadge';
import type { OpenClawTargetsSummary } from '../hooks/useOpenClawTargets';
import type { FrontendUnifiedSnapshot } from '../types';
import { navigate } from './routes';

export interface StatusStripProps {
  readonly state: MonitorState;
  readonly bridgeCount: number;
  readonly openclawSummary: OpenClawTargetsSummary;
}

function formatLastUpdated(value: string | null): string {
  if (!value) {
    return '—';
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime()) || date.getTime() === 0) {
    return '—';
  }

  return new Intl.DateTimeFormat(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(date);
}

interface FleetResource {
  avgCpu: number;
  avgMem: number;
  avgDisk: number | null;
}

function computeFleetResource(snapshot: FrontendUnifiedSnapshot): FleetResource | null {
  const withResource = snapshot.machines.filter((m) => m.lastResource !== undefined);
  if (withResource.length === 0) return null;
  let totalCpu = 0;
  let totalMem = 0;
  let totalDisk = 0;
  let diskCount = 0;
  for (const m of withResource) {
    totalCpu += m.lastResource!.cpuPct;
    totalMem += m.lastResource!.memoryPct;
    if (m.lastResource!.diskPct !== undefined) {
      totalDisk += m.lastResource!.diskPct;
      diskCount += 1;
    }
  }
  return {
    avgCpu: totalCpu / withResource.length,
    avgMem: totalMem / withResource.length,
    avgDisk: diskCount > 0 ? totalDisk / diskCount : null,
  };
}

function countAgents(snapshot: FrontendUnifiedSnapshot): number {
  const agentIds = new Set<string>();
  for (const session of snapshot.sessions) {
    if (session.agentId) agentIds.add(session.agentId);
  }
  for (const run of snapshot.runs) {
    if (run.agentId) agentIds.add(run.agentId);
  }
  return agentIds.size;
}

function gaugeTone(pct: number): string {
  if (pct >= 85) return 'tone-bad';
  if (pct >= 60) return 'tone-warn';
  return 'tone-good';
}

function MiniGauge(props: { label: string; value: number; onClick?: () => void }): JSX.Element {
  const pct = Math.min(100, Math.max(0, props.value));
  const Tag = props.onClick ? 'button' : 'span';
  return (
    <Tag
      className={`status-strip-gauge${props.onClick ? ' status-strip-gauge-clickable' : ''}`}
      onClick={props.onClick}
      title={props.onClick ? `View ${props.label} details` : undefined}
    >
      <span className="status-strip-gauge-label">{props.label}</span>
      <span className="status-strip-gauge-value">{pct.toFixed(0)}%</span>
      <span className="status-strip-gauge-bar">
        <span
          className={`status-strip-gauge-fill ${gaugeTone(pct)}`}
          style={{ width: `${String(pct)}%` }}
        />
      </span>
    </Tag>
  );
}

function formatUptime(startMs: number): string {
  const diff = Date.now() - startMs;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `Up ${String(days)}d ${String(hours % 24)}h`;
  if (hours > 0) return `Up ${String(hours)}h ${String(minutes % 60)}m`;
  if (minutes > 0) return `Up ${String(minutes)}m`;
  return 'Up <1m';
}

function toConnectionSeverity(status: MonitorState['status']): SeverityLevel {
  switch (status) {
    case 'error':
      return 'error';
    case 'degraded':
      return 'warn';
    case 'connecting':
    case 'connected':
      return 'info';
    case 'idle':
      return 'debug';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function StatusStrip(props: StatusStripProps): JSX.Element {
  const snapshot = props.state.snapshot;
  const activeRunsCount = snapshot?.activeRuns.length ?? 0;
  const lastUpdated = formatLastUpdated(snapshot?.lastUpdated ?? null);
  const rawHealth = snapshot?.health.overall ?? 'unknown';
  const overallHealth =
    rawHealth === 'unknown' && props.state.status === 'connected' ? 'healthy' : rawHealth;
  const { overallHealth: openclawHealth, count: openclawTargetCount } = props.openclawSummary;
  const fleetResource = snapshot ? computeFleetResource(snapshot) : null;

  const connectedAtRef = useRef<number | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    if (props.state.status === 'connected' && connectedAtRef.current === null) {
      connectedAtRef.current = Date.now();
    } else if (props.state.status !== 'connected' && props.state.status !== 'degraded') {
      connectedAtRef.current = null;
    }
  }, [props.state.status]);

  useEffect(() => {
    if (props.state.status !== 'connected' && props.state.status !== 'degraded') return;
    const timer = setInterval(() => {
      setTick((t) => t + 1);
    }, 60_000);
    return () => {
      clearInterval(timer);
    };
  }, [props.state.status]);

  const isConnected = props.state.status === 'connected' || props.state.status === 'degraded';

  const agentCount = snapshot ? countAgents(snapshot) : 0;

  return (
    <footer className="status-strip">
      <span className="status-strip-item">
        <span className="status-strip-label">Connection</span>
        <SeverityBadge
          severity={toConnectionSeverity(props.state.status)}
          label={props.state.status}
        />
      </span>
      <span className="status-strip-item">
        <span className="status-strip-label">Health</span>
        <HealthBadge health={overallHealth} />
      </span>
      {fleetResource ? (
        <>
          <span className="status-strip-sep" />
          <MiniGauge
            label="CPU"
            value={fleetResource.avgCpu}
            onClick={() => {
              navigate('monitor');
            }}
          />
          <MiniGauge
            label="MEM"
            value={fleetResource.avgMem}
            onClick={() => {
              navigate('monitor');
            }}
          />
          {fleetResource.avgDisk !== null ? (
            <MiniGauge
              label="DISK"
              value={fleetResource.avgDisk}
              onClick={() => {
                navigate('monitor');
              }}
            />
          ) : null}
          <span className="status-strip-sep" />
        </>
      ) : null}
      {agentCount > 0 ? (
        <button
          className="status-strip-item status-strip-link"
          onClick={() => {
            navigate('agents');
          }}
          title="View agents"
        >
          <span className="status-strip-label">Agents</span>
          <span className="status-strip-value">{agentCount}</span>
        </button>
      ) : null}
      <button
        className="status-strip-item status-strip-link"
        onClick={() => {
          navigate('runs');
        }}
        title="View runs"
      >
        <span className="status-strip-label">Active Runs</span>
        <span className={`status-strip-value${activeRunsCount > 0 ? ' metric-active' : ''}`}>
          {activeRunsCount}
        </span>
      </button>
      {props.bridgeCount > 0 ? (
        <button
          className="status-strip-item status-strip-link"
          onClick={() => {
            navigate('tunnels');
          }}
          title="View bridges"
        >
          <span className="status-strip-label">Bridges</span>
          <span className="status-strip-value metric-active">{props.bridgeCount}</span>
        </button>
      ) : null}
      <button
        className="status-strip-item status-strip-link"
        onClick={() => {
          navigate('tasks', { taskView: 'openclaw' });
        }}
        title="Open OpenClaw tasks"
      >
        <span className="status-strip-label">OpenClaw</span>
        <span
          className={`badge ${openclawHealth === 'healthy' ? 'tone-good' : openclawHealth === 'degraded' ? 'tone-warn' : 'tone-muted'}`}
        >
          {openclawHealth}
        </span>
        {openclawTargetCount > 0 ? (
          <span className="status-strip-value">{openclawTargetCount}</span>
        ) : null}
      </button>
      <span className="status-strip-item">
        <span className="status-strip-label">Updated</span>
        <span className="status-strip-value">{lastUpdated}</span>
      </span>
      {isConnected && connectedAtRef.current ? (
        <>
          <span className="status-strip-sep" />
          <span className="status-strip-uptime">
            <IconClock width={12} height={12} />
            {formatUptime(connectedAtRef.current)}
          </span>
        </>
      ) : null}
    </footer>
  );
}
