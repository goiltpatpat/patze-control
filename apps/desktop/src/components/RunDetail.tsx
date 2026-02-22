import type { FrontendRunDetailSnapshot } from '../types';
import { StateBadge } from './badges/StateBadge';

export interface RunDetailProps {
  readonly detail: FrontendRunDetailSnapshot;
}

export function RunDetail(props: RunDetailProps): JSX.Element {
  const { toolCalls, modelUsage } = props.detail;

  return (
    <div className="run-detail">
      <div className="run-detail-grid">
        <div>
          <h4 className="run-detail-section-title">Tool Calls ({toolCalls.length})</h4>
          {toolCalls.length === 0 ? (
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>No tool calls recorded.</span>
          ) : (
            <div>
              {toolCalls.map((tc) => (
                <div key={tc.toolCallId} className="tool-call-item">
                  <StateBadge value={tc.status} />
                  <span className="tool-call-name">{tc.toolName}</span>
                  {tc.durationMs !== undefined ? (
                    <span className="tool-call-duration">{tc.durationMs}ms</span>
                  ) : null}
                  {tc.errorMessage ? (
                    <span className="tool-call-error">{tc.errorMessage}</span>
                  ) : null}
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <h4 className="run-detail-section-title">Model Usage</h4>
          {modelUsage ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div className="settings-row">
                <span className="settings-row-label">Provider</span>
                <span className="settings-row-value">{modelUsage.provider}</span>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">Model</span>
                <span className="settings-row-value">{modelUsage.model}</span>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">Input Tokens</span>
                <span className="settings-row-value">
                  {modelUsage.inputTokens.toLocaleString()}
                </span>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">Output Tokens</span>
                <span className="settings-row-value">
                  {modelUsage.outputTokens.toLocaleString()}
                </span>
              </div>
              <div className="settings-row">
                <span className="settings-row-label">Total Tokens</span>
                <span className="settings-row-value">
                  {modelUsage.totalTokens.toLocaleString()}
                </span>
              </div>
              {modelUsage.estimatedCostUsd !== undefined ? (
                <div className="settings-row">
                  <span className="settings-row-label">Est. Cost</span>
                  <span className="settings-row-value">
                    ${modelUsage.estimatedCostUsd.toFixed(4)}
                  </span>
                </div>
              ) : null}
            </div>
          ) : (
            <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>No model usage recorded.</span>
          )}
        </div>
      </div>
    </div>
  );
}
