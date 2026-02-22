import { IconClock } from '../../components/Icons';
import { formatPollInterval } from '../../utils/openclaw';
import { formatRelativeTime } from '../../utils/time';
import type { TargetSyncStatusEntry } from './types';
import { targetHealthLabel, targetHealthTone } from './utils';

interface TargetCardsBarProps {
  readonly targets: readonly TargetSyncStatusEntry[];
  readonly selectedTargetId: string | null;
  readonly onSelect: (id: string) => void;
  readonly onToggle: (id: string, enabled: boolean) => void;
  readonly onDelete: (id: string) => void;
}

export function TargetCardsBar(props: TargetCardsBarProps): JSX.Element {
  if (props.targets.length === 0) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">
          <IconClock width={28} height={28} />
        </div>
        <p>No OpenClaw targets configured.</p>
        <p style={{ fontSize: 11, marginTop: 4 }}>
          Click "+ Target" to add a local or remote OpenClaw instance.
        </p>
      </div>
    );
  }

  return (
    <div className="target-cards-grid">
      {props.targets.map((entry) => {
        const isSelected = entry.target.id === props.selectedTargetId;
        const tone = targetHealthTone(entry);
        return (
          <div
            key={entry.target.id}
            className={`target-card ${isSelected ? 'target-card-selected' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => {
              props.onSelect(entry.target.id);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                props.onSelect(entry.target.id);
              }
            }}
          >
            <div className="target-card-header">
              <div className="target-card-title">
                <span className="target-card-label">{entry.target.label}</span>
                <span className={`badge ${tone}`} style={{ fontSize: 10 }}>
                  {targetHealthLabel(entry)}
                </span>
              </div>
              <span
                className={`badge ${entry.target.type === 'remote' ? 'tone-neutral' : 'tone-muted'}`}
                style={{ fontSize: 9 }}
              >
                {entry.target.type}
              </span>
            </div>
            <div className="target-card-meta">
              <span className="target-card-path" title={entry.target.openclawDir}>
                {entry.target.openclawDir}
              </span>
              <span className="target-card-stat">
                {entry.syncStatus.available ? (
                  <>
                    <span style={{ color: 'var(--green)', fontWeight: 600 }}>
                      {entry.syncStatus.jobsCount}
                    </span>{' '}
                    jobs
                  </>
                ) : (
                  'standby'
                )}
                {entry.syncStatus.lastSuccessfulSyncAt ? (
                  <> &middot; sync {formatRelativeTime(entry.syncStatus.lastSuccessfulSyncAt)}</>
                ) : null}
              </span>
              <span className="target-card-stat">
                Polling every {formatPollInterval(entry.target.pollIntervalMs)}
                {' · '}
                added {formatRelativeTime(entry.target.createdAt)}
              </span>
              <span className="target-card-stat">
                {entry.syncStatus.lastAttemptAt
                  ? `last attempt ${formatRelativeTime(entry.syncStatus.lastAttemptAt)}`
                  : 'no sync attempt yet'}
              </span>
            </div>
            <div
              className="target-card-actions"
              onClick={(e) => {
                e.stopPropagation();
              }}
            >
              <button
                className="btn-ghost"
                style={{ height: 22, padding: '0 8px', fontSize: 11 }}
                onClick={() => {
                  props.onToggle(entry.target.id, !entry.target.enabled);
                }}
              >
                {entry.target.enabled ? 'Pause' : 'Resume'}
              </button>
              {props.targets.length > 1 ? (
                <button
                  className="btn-ghost"
                  style={{ height: 22, padding: '0 8px', fontSize: 11, color: 'var(--red)' }}
                  onClick={() => {
                    props.onDelete(entry.target.id);
                  }}
                >
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        );
      })}
    </div>
  );
}
