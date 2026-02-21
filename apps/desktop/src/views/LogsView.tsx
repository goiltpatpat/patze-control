import { useDeferredValue, useEffect, useRef, useState } from 'react';
import { FilterTabs, type FilterTab } from '../components/FilterTabs';
import { IconTerminal } from '../components/Icons';
import type { FrontendLogSnapshot, FrontendUnifiedSnapshot } from '../types';

export interface LogsViewProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
}

type LogFilter = 'all' | 'error' | 'warn' | 'info' | 'debug';

function levelTone(level: string): string {
  switch (level) {
    case 'critical': return 'critical';
    case 'error': return 'bad';
    case 'warn': return 'warn';
    case 'info': return 'info';
    case 'debug': return 'muted';
    default: return 'neutral';
  }
}

function formatLogTime(isoTs: string): string {
  const date = new Date(isoTs);
  if (Number.isNaN(date.getTime())) {
    return '--:--:--';
  }
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

function truncateId(id: string, maxLen: number): string {
  if (id.length <= maxLen) {
    return id;
  }
  return `${id.slice(0, maxLen - 1)}…`;
}

function matchesFilter(log: FrontendLogSnapshot, filter: LogFilter): boolean {
  switch (filter) {
    case 'all': return true;
    case 'error': return log.level === 'error' || log.level === 'critical';
    case 'warn': return log.level === 'warn';
    case 'info': return log.level === 'info';
    case 'debug': return log.level === 'debug';
  }
}

function matchesSearch(log: FrontendLogSnapshot, term: string): boolean {
  if (!term) return true;
  const lower = term.toLowerCase();
  return (
    log.message.toLowerCase().includes(lower) ||
    log.runId.toLowerCase().includes(lower) ||
    log.sessionId.toLowerCase().includes(lower) ||
    log.machineId.toLowerCase().includes(lower)
  );
}

export function LogsView(props: LogsViewProps): JSX.Element {
  const [filter, setFilter] = useState<LogFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const deferredSearch = useDeferredValue(searchInput);
  const logs = props.snapshot?.logs ?? [];
  const feedRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const levelFiltered = logs.filter((log) => matchesFilter(log, filter));
  const filtered = levelFiltered.filter((log) => matchesSearch(log, deferredSearch));

  const errorCount = logs.filter((l) => l.level === 'error' || l.level === 'critical').length;
  const warnCount = logs.filter((l) => l.level === 'warn').length;
  const infoCount = logs.filter((l) => l.level === 'info').length;
  const debugCount = logs.filter((l) => l.level === 'debug').length;

  const tabs: FilterTab<LogFilter>[] = [
    { id: 'all', label: 'All', count: logs.length },
    { id: 'error', label: 'Error', count: errorCount },
    { id: 'warn', label: 'Warn', count: warnCount },
    { id: 'info', label: 'Info', count: infoCount },
    { id: 'debug', label: 'Debug', count: debugCount },
  ];

  useEffect(() => {
    if (autoScroll && feedRef.current) {
      feedRef.current.scrollTop = feedRef.current.scrollHeight;
    }
  }, [filtered.length, autoScroll]);

  const handleScroll = (): void => {
    if (!feedRef.current) {
      return;
    }
    const { scrollTop, scrollHeight, clientHeight } = feedRef.current;
    setAutoScroll(scrollHeight - scrollTop - clientHeight < 30);
  };

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Logs</h2>
        <FilterTabs tabs={tabs} active={filter} onChange={setFilter} />
      </div>

      <div className="log-search-bar">
        <input
          className="log-search-input"
          type="text"
          placeholder="Search logs by message, runId, sessionId, machineId…"
          value={searchInput}
          onChange={(e) => { setSearchInput(e.target.value); }}
          aria-label="Search logs"
        />
        <span className="log-search-count">
          {deferredSearch
            ? `${String(filtered.length)} of ${String(levelFiltered.length)}`
            : `${String(levelFiltered.length)} logs`}
        </span>
        {searchInput ? (
          <button
            className="log-search-clear"
            onClick={() => { setSearchInput(''); }}
            aria-label="Clear search"
          >
            Clear
          </button>
        ) : null}
      </div>

      {filtered.length === 0 ? (
        <div className="panel">
          <div className="empty-state">
            <div className="empty-state-icon"><IconTerminal width={28} height={28} /></div>
            <p>{deferredSearch ? 'No logs match the search.' : 'No logs recorded yet.'}</p>
          </div>
        </div>
      ) : (
        <div className="panel log-panel">
          <div className="log-feed" ref={feedRef} onScroll={handleScroll}>
            {filtered.map((log) => (
              <div key={log.id} className="log-entry" data-level={log.level}>
                <span className="log-time">{formatLogTime(log.ts)}</span>
                <span className={`log-level-badge log-level-${levelTone(log.level)}`}>
                  {log.level.toUpperCase()}
                </span>
                <span className="log-machine-id" title={log.machineId}>{truncateId(log.machineId, 10)}</span>
                <span className="log-session-id" title={log.sessionId}>{truncateId(log.sessionId, 10)}</span>
                <span className="log-run-id" title={log.runId}>{truncateId(log.runId, 12)}</span>
                <span className="log-message">{log.message}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
