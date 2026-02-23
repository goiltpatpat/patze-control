import { useCallback, useEffect, useRef, useState } from 'react';
import { IconServer } from '../components/Icons';

export interface TerminalViewProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly connected: boolean;
}

interface TerminalEntry {
  id: number;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number;
  timestamp: string;
}

interface ServerInfo {
  hostname: string;
  user: string;
}

function buildAuthHeaders(token: string, json?: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token.length > 0) headers['Authorization'] = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

const QUICK_COMMANDS: ReadonlyArray<{ label: string; command: string }> = [
  { label: 'Uptime', command: 'uptime' },
  { label: 'Memory', command: 'free -h' },
  { label: 'Disk', command: 'df -h' },
  { label: 'Hostname', command: 'hostname' },
  { label: 'Processes', command: 'ps aux --sort=-pcpu' },
  { label: 'Date', command: 'date' },
  { label: 'Kernel', command: 'uname -a' },
  { label: 'Who', command: 'whoami' },
];

let entryIdCounter = 0;

function extractHost(baseUrl: string): string {
  try {
    const url = new URL(baseUrl);
    return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
      ? 'localhost'
      : url.hostname;
  } catch {
    return baseUrl;
  }
}

export function TerminalView(props: TerminalViewProps): JSX.Element {
  const { baseUrl, token, connected } = props;
  const [input, setInput] = useState('');
  const [entries, setEntries] = useState<TerminalEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const outputRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!connected) return;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/terminal/allowlist`, {
          headers: buildAuthHeaders(token),
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return;
        const data = (await res.json()) as { allowed?: string[] };
        if (mountedRef.current) setAllowlist(data.allowed ?? []);
      } catch {
        /* silent */
      }
    })();
  }, [connected, baseUrl, token]);

  useEffect(() => {
    if (!connected) return;
    const probeServer = async (cmd: string): Promise<string> => {
      try {
        const res = await fetch(`${baseUrl}/terminal/exec`, {
          method: 'POST',
          headers: buildAuthHeaders(token, true),
          body: JSON.stringify({ command: cmd }),
          signal: AbortSignal.timeout(5_000),
        });
        if (!res.ok) return '';
        const data = (await res.json()) as { stdout?: string };
        return (data.stdout ?? '').trim();
      } catch {
        return '';
      }
    };

    void (async () => {
      const [hostname, user] = await Promise.all([probeServer('hostname'), probeServer('whoami')]);
      if (mountedRef.current && hostname) {
        setServerInfo({ hostname, user: user || 'unknown' });
      }
    })();
  }, [connected, baseUrl, token]);

  const executeCommand = useCallback(
    async (command: string) => {
      if (command.trim().length === 0 || running) return;
      setRunning(true);
      setHistory((prev) => {
        const next = prev.filter((c) => c !== command);
        next.unshift(command);
        return next.slice(0, 50);
      });
      setHistoryIndex(-1);

      try {
        const res = await fetch(`${baseUrl}/terminal/exec`, {
          method: 'POST',
          headers: buildAuthHeaders(token, true),
          body: JSON.stringify({ command }),
          signal: AbortSignal.timeout(20_000),
        });
        const data = (await res.json()) as {
          command?: string;
          exitCode?: number;
          stdout?: string;
          stderr?: string;
        };
        if (mountedRef.current) {
          entryIdCounter += 1;
          setEntries((prev) => [
            ...prev,
            {
              id: entryIdCounter,
              command: data.command ?? command,
              stdout: data.stdout ?? '',
              stderr: data.stderr ?? '',
              exitCode: data.exitCode ?? 0,
              timestamp: new Date().toLocaleTimeString(),
            },
          ]);
        }
      } catch (err) {
        if (mountedRef.current) {
          entryIdCounter += 1;
          setEntries((prev) => [
            ...prev,
            {
              id: entryIdCounter,
              command,
              stdout: '',
              stderr: err instanceof Error ? err.message : 'Request failed',
              exitCode: -1,
              timestamp: new Date().toLocaleTimeString(),
            },
          ]);
        }
      } finally {
        if (mountedRef.current) {
          setRunning(false);
          setInput('');
          requestAnimationFrame(() => {
            outputRef.current?.scrollTo(0, outputRef.current.scrollHeight);
            inputRef.current?.focus();
          });
        }
      }
    },
    [baseUrl, token, running]
  );

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      void executeCommand(input);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (history.length > 0) {
        const next = Math.min(historyIndex + 1, history.length - 1);
        setHistoryIndex(next);
        setInput(history[next] ?? '');
      }
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex > 0) {
        const next = historyIndex - 1;
        setHistoryIndex(next);
        setInput(history[next] ?? '');
      } else {
        setHistoryIndex(-1);
        setInput('');
      }
    } else if (e.key === 'l' && e.ctrlKey) {
      e.preventDefault();
      setEntries([]);
    }
  };

  const host = extractHost(baseUrl);
  const promptLabel = serverInfo ? `${serverInfo.user}@${serverInfo.hostname}` : host;

  if (!connected) {
    return (
      <section className="view-panel">
        <div className="view-header">
          <h2 className="view-title">Terminal</h2>
        </div>
        <div className="empty-state">Connect to a control plane to use the terminal.</div>
      </section>
    );
  }

  return (
    <section className="view-panel term-view">
      <div className="view-header">
        <h2 className="view-title">Terminal</h2>
        <div className="term-quick-cmds">
          {QUICK_COMMANDS.map((qc) => (
            <button
              key={qc.command}
              className="term-quick-btn"
              onClick={() => void executeCommand(qc.command)}
              disabled={running}
            >
              {qc.label}
            </button>
          ))}
        </div>
      </div>

      <div className="term-body">
        <div className="term-server-banner">
          <IconServer width={14} height={14} />
          <span className="term-server-host">{promptLabel}</span>
          <span className="term-server-url">{baseUrl}</span>
          <span className="term-server-badge">API Server</span>
        </div>

        <div className="term-output" ref={outputRef}>
          {allowlist.length > 0 ? (
            <div className="term-welcome">Allowed: {allowlist.join(', ')}</div>
          ) : null}
          {entries.map((entry) => (
            <div key={entry.id} className="term-entry">
              <div className="term-prompt-line">
                <span className="term-prompt">{promptLabel}$</span>
                <span className="term-cmd">{entry.command}</span>
                <span className="term-timestamp">{entry.timestamp}</span>
                <span
                  className={`term-exit ${entry.exitCode === 0 ? 'term-exit-ok' : 'term-exit-err'}`}
                >
                  {entry.exitCode === 0 ? '\u2713' : `exit ${entry.exitCode}`}
                </span>
              </div>
              {entry.stdout ? <pre className="term-stdout">{entry.stdout}</pre> : null}
              {entry.stderr ? <pre className="term-stderr">{entry.stderr}</pre> : null}
            </div>
          ))}
          {running ? (
            <div className="term-running">
              <span className="mini-spinner" style={{ width: 14, height: 14 }} />
              <span>Running...</span>
            </div>
          ) : null}
        </div>

        <div className="term-input-bar">
          <span className="term-prompt">{promptLabel}$</span>
          <input
            ref={inputRef}
            type="text"
            className="term-input"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type a command..."
            disabled={running}
            autoFocus
          />
          <span className="term-hint">Ctrl+L clear</span>
        </div>
      </div>
    </section>
  );
}
