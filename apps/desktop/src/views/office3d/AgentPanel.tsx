import { IconX, IconBot, IconClock, IconZap, IconLink, IconActivity, IconServer } from '../../components/Icons';
import { formatRelativeTime } from '../../utils/time';
import { navigate } from '../../shell/routes';

type DeskStatus = 'active' | 'idle' | 'error' | 'offline';

interface AgentPanelProps {
  readonly id: string;
  readonly label: string;
  readonly emoji: string;
  readonly type: 'local' | 'remote';
  readonly status: DeskStatus;
  readonly activeRuns: number;
  readonly lastSeen: string | null;
  readonly statusColor: string;
  readonly onClose: () => void;
}

function getStatusLabel(status: DeskStatus): string {
  switch (status) {
    case 'active': return 'Active';
    case 'idle': return 'Idle';
    case 'error': return 'Error';
    case 'offline': return 'Offline';
  }
}

function getStatusDescription(status: DeskStatus, activeRuns: number): string {
  switch (status) {
    case 'active': return `Processing ${activeRuns} run${activeRuns !== 1 ? 's' : ''}`;
    case 'idle': return 'Waiting for tasks';
    case 'error': return 'Sync failures detected';
    case 'offline': return 'Not reachable';
  }
}

export function AgentPanel(props: AgentPanelProps): JSX.Element {
  return (
    <div className="office-agent-panel">
      <div className="office-agent-panel-header">
        <div className="office-agent-panel-identity">
          <span className="office-agent-panel-emoji">{props.emoji}</span>
          <div>
            <h3 className="office-agent-panel-name">{props.label}</h3>
            <span className="office-agent-panel-type">
              <IconLink width={10} height={10} />
              {props.type}
            </span>
          </div>
        </div>
        <button
          type="button"
          className="office-agent-panel-close"
          onClick={props.onClose}
          aria-label="Close panel"
        >
          <IconX width={14} height={14} />
        </button>
      </div>

      {/* Status badge + description */}
      <div className="office-agent-panel-status-section">
        <div
          className="office-agent-panel-status-badge"
          style={{
            color: props.statusColor,
            borderColor: props.statusColor,
            background: `color-mix(in srgb, ${props.statusColor} 12%, transparent)`,
          }}
        >
          <span
            className="office-agent-panel-status-dot"
            style={{ background: props.statusColor }}
          />
          {getStatusLabel(props.status)}
        </div>
        <span className="office-agent-panel-status-desc">
          {getStatusDescription(props.status, props.activeRuns)}
        </span>
      </div>

      {/* Stats grid */}
      <div className="office-agent-panel-stats">
        <div className="office-agent-panel-stat">
          <IconBot width={13} height={13} />
          <span className="office-agent-panel-stat-label">ID</span>
          <span className="office-agent-panel-stat-value">{props.id}</span>
        </div>
        <div className="office-agent-panel-stat">
          <IconServer width={13} height={13} />
          <span className="office-agent-panel-stat-label">Type</span>
          <span className="office-agent-panel-stat-value">{props.type}</span>
        </div>
        <div className="office-agent-panel-stat">
          <IconZap width={13} height={13} />
          <span className="office-agent-panel-stat-label">Active Runs</span>
          <span className="office-agent-panel-stat-value" style={{ color: props.activeRuns > 0 ? props.statusColor : undefined }}>
            {props.activeRuns}
          </span>
        </div>
        <div className="office-agent-panel-stat">
          <IconClock width={13} height={13} />
          <span className="office-agent-panel-stat-label">Last Seen</span>
          <span className="office-agent-panel-stat-value">
            {props.lastSeen ? formatRelativeTime(props.lastSeen) : 'never'}
          </span>
        </div>
        <div className="office-agent-panel-stat">
          <IconActivity width={13} height={13} />
          <span className="office-agent-panel-stat-label">Status</span>
          <span className="office-agent-panel-stat-value" style={{ color: props.statusColor }}>
            {getStatusLabel(props.status)}
          </span>
        </div>
      </div>

      {/* Quick actions */}
      <div className="office-agent-panel-actions">
        <button
          type="button"
          className="office-agent-panel-action-btn office-agent-panel-action-primary"
          onClick={() => { navigate('tasks', { taskView: 'openclaw' }); }}
        >
          View Tasks
        </button>
        <button
          type="button"
          className="office-agent-panel-action-btn"
          onClick={() => { navigate('sessions'); }}
        >
          View Sessions
        </button>
        <button
          type="button"
          className="office-agent-panel-action-btn"
          onClick={() => { navigate('runs'); }}
        >
          View Runs
        </button>
        <button
          type="button"
          className="office-agent-panel-action-btn"
          onClick={() => { navigate('logs'); }}
        >
          View Logs
        </button>
      </div>
    </div>
  );
}
