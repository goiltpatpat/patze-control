import { useMemo, useState } from 'react';
import { FilterTabs } from '../components/FilterTabs';
import type { FrontendUnifiedSnapshot } from '../types';

export interface CostsViewProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
}

type CostTab = 'overview' | 'agents' | 'models' | 'timeline';

const COST_TABS: ReadonlyArray<{ id: CostTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'agents', label: 'By Agent' },
  { id: 'models', label: 'By Model' },
  { id: 'timeline', label: 'Timeline' },
];

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return count.toString();
}

interface AgentCostRow {
  agentId: string;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  runs: number;
}

interface ModelCostRow {
  model: string;
  provider: string;
  totalCost: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  runs: number;
}

interface TimelineBucket {
  label: string;
  cost: number;
  tokens: number;
  runs: number;
}

function computeAgentCosts(snapshot: FrontendUnifiedSnapshot): AgentCostRow[] {
  const map = new Map<string, AgentCostRow>();
  for (const run of snapshot.runs) {
    const agentId = run.agentId ?? 'unknown';
    const existing = map.get(agentId) ?? {
      agentId,
      totalCost: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      runs: 0,
    };
    const detail = snapshot.runDetails[run.runId];
    if (detail?.modelUsage) {
      existing.totalCost += detail.modelUsage.estimatedCostUsd ?? 0;
      existing.totalTokens += detail.modelUsage.totalTokens ?? 0;
      existing.inputTokens += detail.modelUsage.inputTokens ?? 0;
      existing.outputTokens += detail.modelUsage.outputTokens ?? 0;
    }
    existing.runs += 1;
    map.set(agentId, existing);
  }
  return [...map.values()].sort((a, b) => b.totalCost - a.totalCost);
}

function computeModelCosts(snapshot: FrontendUnifiedSnapshot): ModelCostRow[] {
  const map = new Map<string, ModelCostRow>();
  for (const run of snapshot.runs) {
    const detail = snapshot.runDetails[run.runId];
    if (!detail?.modelUsage) continue;
    const usage = detail.modelUsage;
    const model = usage.model ?? 'unknown';
    const provider = usage.provider ?? 'unknown';
    const key = `${provider}/${model}`;
    const existing = map.get(key) ?? {
      model,
      provider,
      totalCost: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      runs: 0,
    };
    existing.totalCost += usage.estimatedCostUsd ?? 0;
    existing.totalTokens += usage.totalTokens ?? 0;
    existing.inputTokens += usage.inputTokens ?? 0;
    existing.outputTokens += usage.outputTokens ?? 0;
    existing.runs += 1;
    map.set(key, existing);
  }
  return [...map.values()].sort((a, b) => b.totalCost - a.totalCost);
}

function computeTimeline(snapshot: FrontendUnifiedSnapshot): TimelineBucket[] {
  const buckets = new Map<string, TimelineBucket>();
  const now = new Date();
  for (let i = 6; i >= 0; i--) {
    const d = new Date(now);
    d.setDate(d.getDate() - i);
    const label = d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
    const key = d.toISOString().slice(0, 10);
    buckets.set(key, { label, cost: 0, tokens: 0, runs: 0 });
  }
  for (const run of snapshot.runs) {
    const dateKey = (run.createdAt ?? '').slice(0, 10);
    const bucket = buckets.get(dateKey);
    if (!bucket) continue;
    bucket.runs += 1;
    const detail = snapshot.runDetails[run.runId];
    if (detail?.modelUsage) {
      bucket.cost += detail.modelUsage.estimatedCostUsd ?? 0;
      bucket.tokens += detail.modelUsage.totalTokens ?? 0;
    }
  }
  return [...buckets.values()];
}

function CostBarChart(props: {
  data: readonly { label: string; value: number }[];
  color: string;
  formatValue: (v: number) => string;
}): JSX.Element {
  const maxVal = Math.max(...props.data.map((d) => d.value), 1);
  return (
    <div className="cost-bar-chart">
      {props.data.map((d) => {
        const pct = (d.value / maxVal) * 100;
        return (
          <div key={d.label} className="cost-bar-item">
            <span className="cost-bar-label">{d.label}</span>
            <div className="cost-bar-track">
              <div
                className="cost-bar-fill"
                style={{ width: `${pct}%`, backgroundColor: props.color }}
              />
            </div>
            <span className="cost-bar-value">{props.formatValue(d.value)}</span>
          </div>
        );
      })}
    </div>
  );
}

export function CostsView(props: CostsViewProps): JSX.Element {
  const { snapshot } = props;
  const [tab, setTab] = useState<CostTab>('overview');

  const agentCosts = useMemo(() => (snapshot ? computeAgentCosts(snapshot) : []), [snapshot]);
  const modelCosts = useMemo(() => (snapshot ? computeModelCosts(snapshot) : []), [snapshot]);
  const timeline = useMemo(() => (snapshot ? computeTimeline(snapshot) : []), [snapshot]);

  const totals = useMemo(() => {
    let cost = 0;
    let tokens = 0;
    let input = 0;
    let output = 0;
    let runs = 0;
    for (const row of agentCosts) {
      cost += row.totalCost;
      tokens += row.totalTokens;
      input += row.inputTokens;
      output += row.outputTokens;
      runs += row.runs;
    }
    return { cost, tokens, input, output, runs };
  }, [agentCosts]);

  if (!snapshot) {
    return (
      <section className="view-panel">
        <div className="view-header">
          <h2 className="view-title">Costs & Analytics</h2>
        </div>
        <div className="empty-state">Connect to a control plane to view cost analytics.</div>
      </section>
    );
  }

  return (
    <section className="view-panel cost-view">
      <div className="view-header">
        <h2 className="view-title">Costs & Analytics</h2>
      </div>

      <div className="cost-summary-cards">
        <div className="cost-card cost-card-primary">
          <span className="cost-card-label">Total Cost</span>
          <span className="cost-card-value">{formatCost(totals.cost)}</span>
        </div>
        <div className="cost-card">
          <span className="cost-card-label">Total Tokens</span>
          <span className="cost-card-value">{formatTokens(totals.tokens)}</span>
        </div>
        <div className="cost-card">
          <span className="cost-card-label">Input Tokens</span>
          <span className="cost-card-value">{formatTokens(totals.input)}</span>
        </div>
        <div className="cost-card">
          <span className="cost-card-label">Output Tokens</span>
          <span className="cost-card-value">{formatTokens(totals.output)}</span>
        </div>
        <div className="cost-card">
          <span className="cost-card-label">Avg / Run</span>
          <span className="cost-card-value">
            {totals.runs > 0 ? formatCost(totals.cost / totals.runs) : '—'}
          </span>
        </div>
        <div className="cost-card">
          <span className="cost-card-label">Total Runs</span>
          <span className="cost-card-value">{totals.runs}</span>
        </div>
      </div>

      <FilterTabs tabs={COST_TABS} active={tab} onChange={(t: CostTab) => setTab(t)} />

      <div className="cost-body">
        {tab === 'overview' ? (
          <div className="cost-overview-grid">
            <div className="cost-section">
              <h3 className="cost-section-title">Top Agents by Cost</h3>
              {agentCosts.length === 0 ? (
                <div className="cost-empty">No cost data available</div>
              ) : (
                <CostBarChart
                  data={agentCosts.slice(0, 8).map((a) => ({
                    label: a.agentId,
                    value: a.totalCost,
                  }))}
                  color="var(--accent)"
                  formatValue={formatCost}
                />
              )}
            </div>
            <div className="cost-section">
              <h3 className="cost-section-title">Top Models by Cost</h3>
              {modelCosts.length === 0 ? (
                <div className="cost-empty">No model usage data</div>
              ) : (
                <CostBarChart
                  data={modelCosts.slice(0, 8).map((m) => ({
                    label: `${m.provider}/${m.model}`,
                    value: m.totalCost,
                  }))}
                  color="var(--green)"
                  formatValue={formatCost}
                />
              )}
            </div>
            <div className="cost-section cost-section-wide">
              <h3 className="cost-section-title">7-Day Cost Trend</h3>
              <CostBarChart
                data={timeline.map((b) => ({ label: b.label, value: b.cost }))}
                color="var(--blue)"
                formatValue={formatCost}
              />
            </div>
          </div>
        ) : null}

        {tab === 'agents' ? (
          <div className="cost-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Runs</th>
                  <th>Input Tokens</th>
                  <th>Output Tokens</th>
                  <th>Total Tokens</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {agentCosts.map((row) => (
                  <tr key={row.agentId}>
                    <td className="cell-mono">{row.agentId}</td>
                    <td className="cell-right">{row.runs}</td>
                    <td className="cell-right">{formatTokens(row.inputTokens)}</td>
                    <td className="cell-right">{formatTokens(row.outputTokens)}</td>
                    <td className="cell-right">{formatTokens(row.totalTokens)}</td>
                    <td className="cell-right cell-accent">{formatCost(row.totalCost)}</td>
                  </tr>
                ))}
                {agentCosts.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="cell-empty">
                      No agent cost data
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}

        {tab === 'models' ? (
          <div className="cost-table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Model</th>
                  <th>Runs</th>
                  <th>Input</th>
                  <th>Output</th>
                  <th>Total</th>
                  <th>Cost</th>
                </tr>
              </thead>
              <tbody>
                {modelCosts.map((row) => (
                  <tr key={`${row.provider}/${row.model}`}>
                    <td className="cell-mono">{row.provider}</td>
                    <td className="cell-mono">{row.model}</td>
                    <td className="cell-right">{row.runs}</td>
                    <td className="cell-right">{formatTokens(row.inputTokens)}</td>
                    <td className="cell-right">{formatTokens(row.outputTokens)}</td>
                    <td className="cell-right">{formatTokens(row.totalTokens)}</td>
                    <td className="cell-right cell-accent">{formatCost(row.totalCost)}</td>
                  </tr>
                ))}
                {modelCosts.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="cell-empty">
                      No model cost data
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        ) : null}

        {tab === 'timeline' ? (
          <div className="cost-timeline">
            <div className="cost-section">
              <h3 className="cost-section-title">Daily Cost</h3>
              <CostBarChart
                data={timeline.map((b) => ({ label: b.label, value: b.cost }))}
                color="var(--accent)"
                formatValue={formatCost}
              />
            </div>
            <div className="cost-section">
              <h3 className="cost-section-title">Daily Tokens</h3>
              <CostBarChart
                data={timeline.map((b) => ({ label: b.label, value: b.tokens }))}
                color="var(--green)"
                formatValue={formatTokens}
              />
            </div>
            <div className="cost-section">
              <h3 className="cost-section-title">Daily Runs</h3>
              <CostBarChart
                data={timeline.map((b) => ({ label: b.label, value: b.runs }))}
                color="var(--blue)"
                formatValue={(v) => v.toString()}
              />
            </div>
          </div>
        ) : null}
      </div>
    </section>
  );
}
