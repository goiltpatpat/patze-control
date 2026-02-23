import { useEffect, useRef } from 'react';
import type { ManagedBridgeState } from './types';
import { BRIDGE_PROGRESS_STEPS } from './types';
import { phaseLabel, bridgeProgressPercent } from './utils';

export function BridgeLogPanel(props: {
  readonly bridge: ManagedBridgeState | null;
}): JSX.Element | null {
  const { bridge } = props;
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (bridge) {
      logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [bridge?.logs.length, bridge]);

  if (!bridge) return null;
  const progressPercent = bridgeProgressPercent(bridge.status);
  const currentStepIndex = BRIDGE_PROGRESS_STEPS.findIndex((step) => step.key === bridge.status);
  const statusTone =
    bridge.status === 'error'
      ? 'var(--red)'
      : bridge.status === 'telemetry_active'
        ? 'var(--green)'
        : 'var(--accent)';

  return (
    <div style={{ padding: '8px 14px 12px', borderTop: '1px solid var(--border-muted)' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 8,
          marginBottom: 8,
          border: '1px solid var(--border-muted)',
          borderRadius: 8,
          padding: '6px 10px',
          background: 'color-mix(in srgb, var(--bg-elevated) 40%, transparent)',
        }}
      >
        <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>Current Phase</span>
        <span style={{ fontSize: '0.72rem', color: statusTone, fontWeight: 600 }}>
          {phaseLabel(bridge.status)}
        </span>
      </div>
      <div style={{ marginBottom: 8 }}>
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            fontSize: '0.7rem',
            color: 'var(--text-muted)',
            marginBottom: 4,
          }}
        >
          <span>Bridge Progress</span>
          <span>{progressPercent}%</span>
        </div>
        <div
          style={{ height: 6, borderRadius: 999, background: 'var(--bg-base)', overflow: 'hidden' }}
        >
          <div
            style={{
              width: `${progressPercent}%`,
              height: '100%',
              transition: 'width 180ms ease',
              background: bridge.status === 'error' ? 'var(--red)' : 'var(--accent)',
            }}
          />
        </div>
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {BRIDGE_PROGRESS_STEPS.map((step, idx) => {
            const done = currentStepIndex >= 0 && idx < currentStepIndex;
            const active = step.key === bridge.status;
            const failed = bridge.status === 'error' && idx === Math.max(currentStepIndex, 0);
            return (
              <span
                key={step.key}
                style={{
                  fontSize: '0.68rem',
                  borderRadius: 999,
                  border: `1px solid ${failed ? 'var(--red-dim)' : done || active ? 'var(--accent-dim)' : 'var(--border-muted)'}`,
                  padding: '2px 8px',
                  color: failed
                    ? 'var(--red)'
                    : done || active
                      ? 'var(--text-primary)'
                      : 'var(--text-muted)',
                  background: failed
                    ? 'color-mix(in srgb, var(--red-dim) 16%, transparent)'
                    : done || active
                      ? 'color-mix(in srgb, var(--accent-dim) 14%, transparent)'
                      : 'transparent',
                }}
              >
                {step.label}
              </span>
            );
          })}
        </div>
        {bridge.status === 'telemetry_active' || bridge.status === 'running' ? (
          <div style={{ marginTop: 8, fontSize: '0.7rem', color: 'var(--green)' }}>
            {bridge.machineId
              ? `Verified: machine ${bridge.machineId} is connected.`
              : 'Bridge connected. Waiting machine-id confirmation.'}
          </div>
        ) : null}
      </div>
      <div
        style={{
          background: 'var(--bg-base)',
          borderRadius: 4,
          padding: '8px 10px',
          maxHeight: 180,
          overflowY: 'auto',
          fontSize: '0.72rem',
          fontFamily: 'var(--font-mono)',
          lineHeight: 1.6,
          color: 'var(--text-secondary)',
        }}
      >
        {bridge.logs.map((line, i) => (
          <div key={i}>{line}</div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}
