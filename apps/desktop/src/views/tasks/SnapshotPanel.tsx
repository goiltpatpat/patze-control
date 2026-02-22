import { formatRelativeTime } from '../../utils/time';
import type { TaskSnapshot } from './types';

interface SnapshotPanelProps {
  readonly snapshots: readonly TaskSnapshot[];
  readonly onRollback: (snapshotId: string) => void;
}

export function SnapshotPanel(props: SnapshotPanelProps): JSX.Element {
  if (props.snapshots.length === 0) {
    return (
      <div className="panel" style={{ padding: '14px 20px' }}>
        <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          No snapshots yet. A snapshot is created automatically before every task change.
        </span>
      </div>
    );
  }

  return (
    <div className="panel" style={{ padding: 0 }}>
      <div
        style={{
          padding: '10px 16px',
          borderBottom: '1px solid var(--border-subtle)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <strong style={{ fontSize: 12, color: 'var(--text-primary)' }}>Task Snapshots</strong>
        <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
          Rollback to any previous state
        </span>
      </div>
      <div className="table-scroll" style={{ maxHeight: 200 }}>
        <table className="data-table compact">
          <thead>
            <tr>
              <th>Time</th>
              <th>Action</th>
              <th>Description</th>
              <th>Tasks</th>
              <th style={{ width: 80 }}>Restore</th>
            </tr>
          </thead>
          <tbody>
            {props.snapshots.map((s) => (
              <tr key={s.id}>
                <td style={{ fontSize: 12 }}>{formatRelativeTime(s.createdAt)}</td>
                <td>
                  <span className="badge tone-neutral">{s.source}</span>
                </td>
                <td style={{ fontSize: 12 }}>{s.description}</td>
                <td className="mono" style={{ fontSize: 12 }}>
                  {s.taskCount}
                </td>
                <td>
                  <button
                    className="btn-secondary"
                    onClick={() => {
                      props.onRollback(s.id);
                    }}
                  >
                    Restore
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
