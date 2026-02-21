import { useMemo, useState } from 'react';
import { FilterTabs, type FilterTab } from '../components/FilterTabs';
import { IconBot } from '../components/Icons';
import { navigate, type RouteFilter } from '../shell/routes';
import type { FrontendUnifiedSnapshot } from '../types';
import { deriveAgents, type DerivedAgent } from '../utils/derive-agents';
import { formatRelativeTime } from '../utils/time';

export interface AgentsViewProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly filter: RouteFilter;
}

type AgentFilter = 'all' | 'active' | 'idle';

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

function lastSeenLabel(agent: DerivedAgent): string {
  if (agent.lastSeenAt === 0) return 'never';
  return formatRelativeTime(new Date(agent.lastSeenAt).toISOString());
}

export function AgentsView(props: AgentsViewProps): JSX.Element {
  const [filter, setFilter] = useState<AgentFilter>('all');
  const agents = useMemo(
    () => (props.snapshot ? deriveAgents(props.snapshot) : []),
    [props.snapshot],
  );

  const activeCount = agents.filter((a) => a.active).length;
  const idleCount = agents.length - activeCount;

  const tabs: ReadonlyArray<FilterTab<AgentFilter>> = [
    { id: 'all', label: 'All', count: agents.length },
    { id: 'active', label: 'Active', count: activeCount },
    { id: 'idle', label: 'Idle', count: idleCount },
  ];

  const filtered = agents.filter((a) => {
    switch (filter) {
      case 'active': return a.active;
      case 'idle': return !a.active;
      case 'all': return true;
    }
  });

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Agents</h2>
        <FilterTabs tabs={tabs} active={filter} onChange={setFilter} />
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><IconBot width={28} height={28} /></div>
          {agents.length === 0
            ? 'No agents detected. Agents are derived from session and run data.'
            : 'No agents match the current filter.'}
        </div>
      ) : (
        <div className="machine-grid">
          {filtered.map((agent) => (
            <div
              key={agent.agentId}
              className="machine-card machine-card-clickable"
              role="button"
              tabIndex={0}
              onClick={() => { navigate('sessions', { agentId: agent.agentId }); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  navigate('sessions', { agentId: agent.agentId });
                }
              }}
            >
              <div className="machine-card-header">
                <div className="machine-card-title">
                  <span className="machine-card-name">{agent.agentId}</span>
                </div>
                <span className={`state-badge state-badge-${agent.active ? 'ok' : 'muted'}`}>
                  {agent.active ? 'active' : 'idle'}
                </span>
              </div>

              <div className="machine-card-meta">
                <div className="machine-card-meta-item">
                  <span className="machine-card-meta-label">Machines</span>
                  <span className="machine-card-meta-value">{String(agent.machines.length)}</span>
                </div>
                <div className="machine-card-meta-item">
                  <span className="machine-card-meta-label">Sessions</span>
                  <span className={`machine-card-meta-value${agent.activeSessions > 0 ? ' metric-active' : ''}`}>
                    {agent.activeSessions > 0
                      ? `${String(agent.activeSessions)} active / ${String(agent.totalSessions)}`
                      : String(agent.totalSessions)}
                  </span>
                </div>
                <div className="machine-card-meta-item">
                  <span className="machine-card-meta-label">Runs</span>
                  <span className={`machine-card-meta-value${agent.activeRuns > 0 ? ' metric-active' : ''}`}>
                    {String(agent.totalRuns)}
                    {agent.failedRuns > 0 ? (
                      <span className="error" style={{ marginLeft: 4 }}>
                        ({String(agent.failedRuns)} failed)
                      </span>
                    ) : null}
                  </span>
                </div>
                <div className="machine-card-meta-item">
                  <span className="machine-card-meta-label">Last Seen</span>
                  <span className="machine-card-meta-value">{lastSeenLabel(agent)}</span>
                </div>
                {agent.totalTokens > 0 ? (
                  <>
                    <div className="machine-card-meta-item">
                      <span className="machine-card-meta-label">Tokens</span>
                      <span className="machine-card-meta-value">{formatTokenCount(agent.totalTokens)}</span>
                    </div>
                    <div className="machine-card-meta-item">
                      <span className="machine-card-meta-label">Cost</span>
                      <span className="machine-card-meta-value">{formatCost(agent.estimatedCostUsd)}</span>
                    </div>
                  </>
                ) : null}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
