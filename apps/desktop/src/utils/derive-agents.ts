import type { FrontendUnifiedSnapshot } from '../types';

const NON_TERMINAL_STATES = new Set(['created', 'queued', 'running', 'waiting_tool', 'streaming']);

export interface DerivedAgent {
  readonly agentId: string;
  readonly machines: readonly string[];
  readonly activeSessions: number;
  readonly totalSessions: number;
  readonly activeRuns: number;
  readonly totalRuns: number;
  readonly failedRuns: number;
  readonly lastSeenAt: number;
  readonly totalTokens: number;
  readonly estimatedCostUsd: number;
  readonly active: boolean;
}

interface AgentAccumulator {
  machines: Set<string>;
  activeSessions: number;
  totalSessions: number;
  activeRuns: number;
  totalRuns: number;
  failedRuns: number;
  lastSeenAt: number;
  totalTokens: number;
  estimatedCostUsd: number;
}

function getOrCreate(map: Map<string, AgentAccumulator>, agentId: string): AgentAccumulator {
  let acc = map.get(agentId);
  if (!acc) {
    acc = {
      machines: new Set(),
      activeSessions: 0,
      totalSessions: 0,
      activeRuns: 0,
      totalRuns: 0,
      failedRuns: 0,
      lastSeenAt: 0,
      totalTokens: 0,
      estimatedCostUsd: 0,
    };
    map.set(agentId, acc);
  }
  return acc;
}

export function deriveAgents(snapshot: FrontendUnifiedSnapshot): DerivedAgent[] {
  const accumulators = new Map<string, AgentAccumulator>();

  for (const session of snapshot.sessions) {
    const acc = getOrCreate(accumulators, session.agentId);
    acc.totalSessions += 1;
    acc.machines.add(session.machineId);
    if (NON_TERMINAL_STATES.has(session.state)) {
      acc.activeSessions += 1;
    }
    const ts = new Date(session.updatedAt).getTime();
    if (ts > acc.lastSeenAt) acc.lastSeenAt = ts;
  }

  for (const run of snapshot.runs) {
    const acc = getOrCreate(accumulators, run.agentId);
    acc.totalRuns += 1;
    acc.machines.add(run.machineId);
    if (NON_TERMINAL_STATES.has(run.state)) {
      acc.activeRuns += 1;
    }
    if (run.state === 'failed') {
      acc.failedRuns += 1;
    }
    const ts = new Date(run.updatedAt).getTime();
    if (ts > acc.lastSeenAt) acc.lastSeenAt = ts;

    const detail = snapshot.runDetails[run.runId];
    if (detail?.modelUsage) {
      acc.totalTokens += detail.modelUsage.totalTokens;
      acc.estimatedCostUsd += detail.modelUsage.estimatedCostUsd ?? 0;
    }
  }

  const agents: DerivedAgent[] = [];
  for (const [agentId, acc] of accumulators) {
    agents.push({
      agentId,
      machines: Array.from(acc.machines),
      activeSessions: acc.activeSessions,
      totalSessions: acc.totalSessions,
      activeRuns: acc.activeRuns,
      totalRuns: acc.totalRuns,
      failedRuns: acc.failedRuns,
      lastSeenAt: acc.lastSeenAt,
      totalTokens: acc.totalTokens,
      estimatedCostUsd: acc.estimatedCostUsd,
      active: acc.activeSessions > 0 || acc.activeRuns > 0,
    });
  }

  agents.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  return agents;
}
