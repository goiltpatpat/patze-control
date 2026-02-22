import { Suspense, lazy, useEffect, useMemo, useState } from 'react';
import { IconBuilding, IconBot } from '../components/Icons';
import type { TargetSyncStatusEntry } from '../hooks/useOpenClawTargets';
import { navigate } from '../shell/routes';
import { formatRelativeTime } from '../utils/time';
import type { CameraMode } from './OfficeScene3D';

const OfficeScene3D = lazy(async () => import('./OfficeScene3D').then((mod) => ({ default: mod.OfficeScene3D })));

export interface OfficeViewProps {
  readonly openclawTargets: readonly TargetSyncStatusEntry[];
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

function deriveDeskStatus(target: TargetSyncStatusEntry): DeskStatus {
  if (!target.syncStatus.available || target.syncStatus.stale) {
    return 'offline';
  }
  if (target.syncStatus.lastError || target.syncStatus.consecutiveFailures > 0) {
    return 'error';
  }
  if (target.syncStatus.running && target.syncStatus.jobsCount > 0) {
    return 'active';
  }
  return 'idle';
}

function deriveDesk(target: TargetSyncStatusEntry): OfficeDesk {
  const status = deriveDeskStatus(target);
  const first = target.target.label.trim().charAt(0);
  const emoji = first.length > 0 ? first.toUpperCase() : 'O';
  return {
    id: target.target.id,
    label: target.target.label,
    type: target.target.type,
    status,
    activeRuns: status === 'active' ? Math.max(1, target.syncStatus.jobsCount) : 0,
    lastSeen: target.syncStatus.lastSuccessfulSyncAt ?? null,
    emoji,
  };
}

export function OfficeView(props: OfficeViewProps): JSX.Element {
  const [mode, setMode] = useState<'3d' | 'classic'>('3d');
  const [cameraMode, setCameraMode] = useState<CameraMode>('orbit');
  const [supports3D, setSupports3D] = useState(true);
  const desks = useMemo(() => props.openclawTargets.map(deriveDesk), [props.openclawTargets]);

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
              onClick={() => { setMode('3d'); }}
            >
              3D
            </button>
            <button
              type="button"
              className={`office-mode-btn${mode === 'classic' ? ' office-mode-btn-active' : ''}`}
              onClick={() => { setMode('classic'); }}
            >
              Classic
            </button>
          </div>

          {mode === '3d' && supports3D ? (
            <div className="office-mode-toggle" role="group" aria-label="Camera mode">
              <button
                type="button"
                className={`office-mode-btn${cameraMode === 'orbit' ? ' office-mode-btn-active' : ''}`}
                onClick={() => { setCameraMode('orbit'); }}
              >
                Orbit
              </button>
              <button
                type="button"
                className={`office-mode-btn${cameraMode === 'fps' ? ' office-mode-btn-active' : ''}`}
                onClick={() => { setCameraMode('fps'); }}
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

      {desks.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <IconBuilding width={28} height={28} />
          </div>
          <p>No OpenClaw targets found. Add targets in Connections/Tasks first.</p>
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
              navigate('tasks', { taskView: 'openclaw' });
            }}
            cameraMode={cameraMode}
          />
        </Suspense>
      ) : (
        <>
          {!supports3D ? <p className="office-rendering-note">3D unavailable on this device, switched to Classic mode.</p> : null}
        <div className="office-floor-wrap">
          <div className="office-floor">
            {desks.map((desk) => (
              <button
                key={desk.id}
                className={`office-desk office-status-${desk.status}`}
                onClick={() => {
                  navigate('tasks', { taskView: 'openclaw' });
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
                <div className="office-desk-seen">
                  {desk.lastSeen ? formatRelativeTime(desk.lastSeen) : 'never synced'}
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
