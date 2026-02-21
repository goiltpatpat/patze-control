import { useEffect, useRef, useState } from 'react';
import type { FrontendUnifiedSnapshot } from '../types';

export interface ActivityFeedProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
}

const EVENT_TYPE_COLORS: Record<string, string> = {
  'machine.registered': 'var(--accent)',
  'session.state.changed': 'var(--blue)',
  'run.state.changed': 'var(--green)',
  'run.tool.started': 'var(--amber)',
  'run.tool.completed': 'var(--amber)',
  'run.model.usage': 'var(--muted)',
  'agent.state.changed': 'var(--blue)',
  'run.log.emitted': 'var(--text-dim)',
  'run.resource.usage': 'var(--text-dim)',
  'trace.span.recorded': 'var(--text-dim)',
};

function formatEventTime(isoTs: string): string {
  const date = new Date(isoTs);
  if (Number.isNaN(date.getTime())) {
    return '--:--';
  }
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function shortType(type: string): string {
  const parts = type.split('.');
  if (parts.length >= 2) {
    return parts.slice(1).join('.');
  }
  return type;
}

export function ActivityFeed(props: ActivityFeedProps): JSX.Element {
  const events = props.snapshot?.recentEvents ?? [];
  const feedRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  useEffect(() => {
    if (autoScroll && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [events.length, autoScroll]);

  const handleScroll = (): void => {
    if (!feedRef.current) {
      return;
    }
    const { scrollTop, scrollHeight, clientHeight } = feedRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 30);
  };

  if (events.length === 0) {
    return (
      <div className="panel">
        <div className="panel-header">
          <h3 className="panel-title">Activity Feed</h3>
        </div>
        <div className="empty-state">No events recorded yet.</div>
      </div>
    );
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <h3 className="panel-title">Activity Feed</h3>
        <span className="stat-meta">{String(events.length)} events</span>
      </div>
      <div className="activity-feed" ref={feedRef} onScroll={handleScroll}>
        {events.map((event) => (
          <div key={event.id} className="activity-item">
            <span className="activity-time">{formatEventTime(event.ts)}</span>
            <span
              className="activity-type"
              style={{ color: EVENT_TYPE_COLORS[event.type] ?? 'var(--text-muted)' }}
            >
              {shortType(event.type)}
            </span>
            <span className="activity-desc">{event.summary}</span>
            <span className="activity-machine">{event.machineId}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
