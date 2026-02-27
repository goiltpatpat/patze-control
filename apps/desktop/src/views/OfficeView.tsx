import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconBuilding, IconBot } from '../components/Icons';
import type { TargetSyncStatusEntry } from '../hooks/useOpenClawTargets';
import type { OpenClawAgent } from '@patze/telemetry-core';
import { navigate } from '../shell/routes';
import type { CameraMode } from './OfficeScene3D';
import { isSmokeTarget } from '../features/openclaw/selection/smoke-targets';

const OfficeScene3D = lazy(async () =>
  import('./OfficeScene3D').then((mod) => ({ default: mod.OfficeScene3D }))
);

export interface OfficeViewProps {
  readonly openclawTargets: readonly TargetSyncStatusEntry[];
  readonly baseUrl: string;
  readonly token: string;
  readonly selectedTargetId: string | null;
}

type DeskStatus = 'active' | 'idle' | 'error' | 'offline';

interface OfficeDesk {
  readonly id: string;
  readonly label: string;
  readonly type: 'local' | 'remote';
  readonly status: DeskStatus;
  readonly activeRuns: number;
  readonly lastSeen: string | null;
  readonly emoji: string;
}

const AGENT_EMOJIS: Record<string, string> = {
  main: '🧠',
  bob: '🤖',
  must: '⚡',
  'tf-planner': '📋',
  'tf-worker': '🔧',
  'tf-reviewer': '🔍',
  'voice-rt': '🎙️',
};

function agentEmoji(agent: OpenClawAgent): string {
  if (agent.emoji) return agent.emoji;
  const known = AGENT_EMOJIS[agent.id];
  if (known) return known;
  const ch = agent.name.trim().charAt(0);
  return ch.length > 0 ? ch.toUpperCase() : '🤖';
}

function agentToDesk(agent: OpenClawAgent, targetType: 'local' | 'remote'): OfficeDesk {
  return {
    id: agent.id,
    label: agent.name,
    type: targetType,
    status: agent.enabled ? 'active' : 'idle',
    activeRuns: 0,
    lastSeen: null,
    emoji: agentEmoji(agent),
  };
}

export function OfficeView(props: OfficeViewProps): JSX.Element {
  const [mode, setMode] = useState<'3d' | 'classic'>('3d');
  const [cameraMode, setCameraMode] = useState<CameraMode>('orbit');
  const [supports3D, setSupports3D] = useState(true);
  const [agents, setAgents] = useState<readonly OpenClawAgent[]>([]);
  const fetchVersionRef = useRef(0);

  const selectedTarget = useMemo(
    () =>
      props.selectedTargetId
        ? (props.openclawTargets.find((t) => t.target.id === props.selectedTargetId) ?? null)
        : null,
    [props.openclawTargets, props.selectedTargetId]
  );
  const selectedTargetIsTest = selectedTarget ? isSmokeTarget(selectedTarget.target) : false;
  const selectedTargetConnected =
    selectedTarget !== null &&
    selectedTarget.syncStatus.available &&
    !selectedTarget.syncStatus.stale &&
    selectedTarget.syncStatus.running;
  const selectedTargetReady =
    selectedTarget !== null && !selectedTargetIsTest && selectedTargetConnected;

  const targetType: 'local' | 'remote' = selectedTarget?.target.type ?? 'remote';

  const fetchAgents = useCallback(async () => {
    if (!props.baseUrl || !props.selectedTargetId || !selectedTargetReady) {
      setAgents([]);
      return;
    }
    const version = ++fetchVersionRef.current;
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (props.token) headers['Authorization'] = `Bearer ${props.token}`;

    try {
      const res = await fetch(
        `${props.baseUrl}/openclaw/targets/${encodeURIComponent(props.selectedTargetId)}/agents`,
        { headers, signal: AbortSignal.timeout(8000) }
      );
      if (version !== fetchVersionRef.current) return;
      if (!res.ok) return;
      const data = (await res.json()) as { agents?: OpenClawAgent[] };
      if (version !== fetchVersionRef.current) return;
      setAgents(data.agents ?? []);
    } catch {
      // ignore — keep previous agents
    }
  }, [props.baseUrl, props.selectedTargetId, props.token, selectedTargetReady]);

  useEffect(() => {
    void fetchAgents();
    const interval = setInterval(() => void fetchAgents(), 30_000);
    return () => clearInterval(interval);
  }, [fetchAgents]);

  const agentDesks = useMemo(
    () => agents.map((a) => agentToDesk(a, targetType)),
    [agents, targetType]
  );
  const desks = agentDesks;

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    const canvas = window.document.createElement('canvas');
    const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl');
    const ok = gl !== null;
    setSupports3D(ok);
    if (!ok) {
      setMode('classic');
    }
    const loseExt = gl?.getExtension('WEBGL_lose_context');
    loseExt?.loseContext();
  }, []);

  return (
    <section className="view-panel office-view office-view-full">
      <div className="view-header">
        <h2 className="view-title">Office</h2>
        <div className="office-header-actions">
          <div className="office-mode-toggle" role="group" aria-label="Office rendering mode">
            <button
              type="button"
              className={`office-mode-btn${mode === '3d' ? ' office-mode-btn-active' : ''}`}
              disabled={!supports3D}
              onClick={() => {
                setMode('3d');
              }}
            >
              3D
            </button>
            <button
              type="button"
              className={`office-mode-btn${mode === 'classic' ? ' office-mode-btn-active' : ''}`}
              onClick={() => {
                setMode('classic');
              }}
            >
              Classic
            </button>
          </div>

          {mode === '3d' && supports3D ? (
            <div className="office-mode-toggle" role="group" aria-label="Camera mode">
              <button
                type="button"
                className={`office-mode-btn${cameraMode === 'orbit' ? ' office-mode-btn-active' : ''}`}
                onClick={() => {
                  setCameraMode('orbit');
                }}
              >
                Orbit
              </button>
              <button
                type="button"
                className={`office-mode-btn${cameraMode === 'player' ? ' office-mode-btn-active' : ''}`}
                onClick={() => {
                  setCameraMode('player');
                }}
              >
                Walk
              </button>
              <button
                type="button"
                className={`office-mode-btn${cameraMode === 'fps' ? ' office-mode-btn-active' : ''}`}
                onClick={() => {
                  setCameraMode('fps');
                }}
              >
                FPS
              </button>
            </div>
          ) : null}

          <div className="office-legend">
            <span className="office-legend-item office-status-active">active</span>
            <span className="office-legend-item office-status-idle">idle</span>
            <span className="office-legend-item office-status-error">error</span>
            <span className="office-legend-item office-status-offline">offline</span>
          </div>
        </div>
      </div>

      {!props.selectedTargetId ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <IconBuilding width={28} height={28} />
          </div>
          <p>Select an OpenClaw target first.</p>
        </div>
      ) : selectedTargetIsTest ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <IconBuilding width={28} height={28} />
          </div>
          <p>Test target selected. Office shows only real connected OpenClaw agents.</p>
        </div>
      ) : !selectedTargetConnected ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <IconBuilding width={28} height={28} />
          </div>
          <p>Selected target is not connected to OpenClaw yet. Connect/sync target first.</p>
        </div>
      ) : desks.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <IconBuilding width={28} height={28} />
          </div>
          <p>No agents found for this OpenClaw target yet.</p>
        </div>
      ) : mode === '3d' && supports3D ? (
        <Suspense
          fallback={
            <div className="office-3d-loading">
              <span>Loading 3D scene...</span>
            </div>
          }
        >
          <OfficeScene3D
            desks={desks}
            onSelectDesk={() => {
              navigate('agents');
            }}
            cameraMode={cameraMode}
          />
        </Suspense>
      ) : (
        <>
          {!supports3D ? (
            <p className="office-rendering-note">
              3D unavailable on this device, switched to Classic mode.
            </p>
          ) : null}
          <div className="office-floor-wrap">
            <div className="office-floor">
              {desks.map((desk) => (
                <button
                  key={desk.id}
                  className={`office-desk office-status-${desk.status}`}
                  onClick={() => {
                    navigate('agents');
                  }}
                  title={`${desk.label} (${desk.type})`}
                >
                  <div className="office-desk-avatar">{desk.emoji}</div>
                  <div className="office-desk-title">
                    <IconBot width={12} height={12} />
                    <span>{desk.label}</span>
                  </div>
                  <div className="office-desk-meta">
                    <span>{desk.type}</span>
                    <span>
                      {desk.activeRuns > 0 ? `${desk.activeRuns.toString()} active` : desk.status}
                    </span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
