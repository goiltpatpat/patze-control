import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
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

type TerminalScope = 'local' | 'remote_attachment';

interface TerminalMachine {
  readonly id: string;
  readonly scope: TerminalScope;
  readonly label: string;
  readonly status: 'connected' | 'degraded';
  readonly host: string;
}

interface InstallCheck {
  readonly id: string;
  readonly label: string;
  readonly status: 'ok' | 'warn' | 'error';
  readonly message: string;
}

type InstallStepKey = 'precheck' | 'run' | 'verify' | 'register';
type InstallStepTone = 'idle' | 'running' | 'success' | 'warning' | 'error';
type ReadinessTone = 'ready' | 'attention' | 'not_ready';

const TERMINAL_MACHINE_STORAGE_KEY = 'patze_terminal_selected_machine';
const TERMINAL_INSTALL_PREFS_PREFIX = 'patze_terminal_install_prefs:';

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
  { label: 'OpenClaw', command: 'openclaw --version' },
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
  const [machines, setMachines] = useState<TerminalMachine[]>([]);
  const [selectedMachineId, setSelectedMachineId] = useState('local');
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [serverInfo, setServerInfo] = useState<ServerInfo | null>(null);
  const [installPath, setInstallPath] = useState('~/.openclaw');
  const [installCommand, setInstallCommand] = useState('');
  const [installForce, setInstallForce] = useState(false);
  const [installBusy, setInstallBusy] = useState<'precheck' | 'run' | 'verify' | 'register' | null>(
    null
  );
  const [precheckChecks, setPrecheckChecks] = useState<readonly InstallCheck[]>([]);
  const [installLogs, setInstallLogs] = useState<readonly string[]>([]);
  const [verifyMessage, setVerifyMessage] = useState<string | null>(null);
  const [registerMessage, setRegisterMessage] = useState<string | null>(null);
  const [stepTone, setStepTone] = useState<Record<InstallStepKey, InstallStepTone>>({
    precheck: 'idle',
    run: 'idle',
    verify: 'idle',
    register: 'idle',
  });
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
        const [allowlistRes, machinesRes] = await Promise.all([
          fetch(`${baseUrl}/terminal/allowlist`, {
            headers: buildAuthHeaders(token),
            signal: AbortSignal.timeout(5_000),
          }),
          fetch(`${baseUrl}/terminal/machines`, {
            headers: buildAuthHeaders(token),
            signal: AbortSignal.timeout(5_000),
          }),
        ]);
        if (allowlistRes.ok) {
          const data = (await allowlistRes.json()) as { allowed?: string[] };
          if (mountedRef.current) setAllowlist(data.allowed ?? []);
        }
        if (machinesRes.ok) {
          const data = (await machinesRes.json()) as { machines?: TerminalMachine[] };
          const loadedMachines = data.machines ?? [];
          if (mountedRef.current) {
            setMachines(loadedMachines);
            if (!loadedMachines.some((machine) => machine.id === selectedMachineId)) {
              setSelectedMachineId('local');
            }
          }
        }
      } catch {
        /* silent */
      }
    })();
  }, [connected, baseUrl, token, selectedMachineId]);

  const selectedMachine = useMemo(
    () => machines.find((machine) => machine.id === selectedMachineId) ?? null,
    [machines, selectedMachineId]
  );

  const readiness = useMemo((): { tone: ReadinessTone; message: string } => {
    if (selectedMachine?.scope === 'remote_attachment' && selectedMachine.status === 'degraded') {
      return {
        tone: 'not_ready',
        message:
          'Remote machine is degraded. Reconnect and wait for healthy status before install.',
      };
    }
    if (stepTone.verify === 'success') {
      return { tone: 'ready', message: 'Machine ready for OpenClaw management.' };
    }
    if (
      stepTone.precheck === 'error' ||
      stepTone.run === 'error' ||
      stepTone.verify === 'error' ||
      stepTone.register === 'error'
    ) {
      return { tone: 'not_ready', message: 'Setup not ready. Run Precheck and fix failed steps.' };
    }
    if (
      stepTone.precheck === 'warning' ||
      stepTone.run === 'warning' ||
      stepTone.verify === 'warning'
    ) {
      return {
        tone: 'attention',
        message: 'Partially ready. Review warnings before production use.',
      };
    }
    return { tone: 'attention', message: 'Not verified yet. Run Verify to confirm readiness.' };
  }, [stepTone, selectedMachine]);

  const installActionsDisabled =
    installBusy !== null ||
    (selectedMachine?.scope === 'remote_attachment' && selectedMachine.status === 'degraded');

  const fixCommand = useMemo(() => {
    if (stepTone.precheck === 'error') {
      const missingNode = precheckChecks.find(
        (item) => item.id === 'node' && (item.status === 'warn' || item.status === 'error')
      );
      if (missingNode)
        return 'curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs';
      return 'openclaw --version || npm install -g openclaw';
    }
    if (stepTone.run === 'error') {
      return installCommand.trim().length > 0
        ? installCommand.trim()
        : 'npm install -g openclaw || pnpm add -g openclaw || bun add -g openclaw';
    }
    if (stepTone.verify === 'error') {
      return `openclaw --version && ls -la ${installPath}`;
    }
    if (stepTone.register === 'error') {
      return `curl -X POST ${baseUrl}/openclaw/targets -H "Content-Type: application/json" -d '{"label":"My OpenClaw","type":"local","openclawDir":"${installPath}","enabled":true}'`;
    }
    return '';
  }, [stepTone, precheckChecks, installCommand, installPath, baseUrl]);

  const buildScopeBody = useCallback((): Record<string, string> => {
    if (selectedMachine?.scope === 'remote_attachment') {
      return {
        scope: 'remote_attachment',
        attachmentId: selectedMachine.id,
      };
    }
    return { scope: 'local' };
  }, [selectedMachine]);

  useEffect(() => {
    try {
      const savedMachine = localStorage.getItem(TERMINAL_MACHINE_STORAGE_KEY);
      if (savedMachine && savedMachine.trim().length > 0) {
        setSelectedMachineId(savedMachine.trim());
      }
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(TERMINAL_MACHINE_STORAGE_KEY, selectedMachineId);
    } catch {
      /* ignore */
    }
  }, [selectedMachineId]);

  useEffect(() => {
    const prefsKey = `${TERMINAL_INSTALL_PREFS_PREFIX}${selectedMachineId}`;
    try {
      const raw = localStorage.getItem(prefsKey);
      if (!raw) return;
      const parsed = JSON.parse(raw) as {
        installPath?: string;
        installCommand?: string;
        installForce?: boolean;
      };
      if (typeof parsed.installPath === 'string' && parsed.installPath.trim().length > 0) {
        setInstallPath(parsed.installPath);
      } else {
        setInstallPath('~/.openclaw');
      }
      setInstallCommand(typeof parsed.installCommand === 'string' ? parsed.installCommand : '');
      setInstallForce(parsed.installForce === true);
    } catch {
      setInstallPath('~/.openclaw');
      setInstallCommand('');
      setInstallForce(false);
    }
  }, [selectedMachineId]);

  useEffect(() => {
    const prefsKey = `${TERMINAL_INSTALL_PREFS_PREFIX}${selectedMachineId}`;
    try {
      localStorage.setItem(
        prefsKey,
        JSON.stringify({
          installPath,
          installCommand,
          installForce,
        })
      );
    } catch {
      /* ignore */
    }
  }, [selectedMachineId, installPath, installCommand, installForce]);

  useEffect(() => {
    if (!connected) return;
    const probeServer = async (cmd: string): Promise<string> => {
      try {
        const res = await fetch(`${baseUrl}/terminal/exec`, {
          method: 'POST',
          headers: buildAuthHeaders(token, true),
          body: JSON.stringify({ command: cmd, ...buildScopeBody() }),
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
  }, [connected, baseUrl, token, selectedMachineId, buildScopeBody]);

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
          body: JSON.stringify({ command, ...buildScopeBody() }),
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
    [baseUrl, token, running, buildScopeBody]
  );

  const runInstallPrecheck = useCallback(async () => {
    if (installBusy) return;
    setInstallBusy('precheck');
    setStepTone((prev) => ({ ...prev, precheck: 'running' }));
    setRegisterMessage(null);
    try {
      const response = await fetch(`${baseUrl}/openclaw/install/precheck`, {
        method: 'POST',
        headers: buildAuthHeaders(token, true),
        body: JSON.stringify({
          ...buildScopeBody(),
          installPath,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = (await response.json()) as { checks?: InstallCheck[] };
      const checks = data.checks ?? [];
      setPrecheckChecks(checks);
      const hasError = checks.some((item) => item.status === 'error');
      const hasWarn = checks.some((item) => item.status === 'warn');
      setStepTone((prev) => ({
        ...prev,
        precheck: hasError ? 'error' : hasWarn ? 'warning' : response.ok ? 'success' : 'error',
      }));
      if (!response.ok) {
        setVerifyMessage('Precheck failed. Fix highlighted checks and retry.');
      }
    } catch {
      setStepTone((prev) => ({ ...prev, precheck: 'error' }));
      setVerifyMessage('Precheck failed due to network timeout. Retry after connection is stable.');
    } finally {
      setInstallBusy(null);
    }
  }, [installBusy, baseUrl, token, buildScopeBody, installPath]);

  const runInstall = useCallback(async () => {
    if (installBusy) return;
    setInstallBusy('run');
    setStepTone((prev) => ({ ...prev, run: 'running' }));
    setRegisterMessage(null);
    try {
      const response = await fetch(`${baseUrl}/openclaw/install/run`, {
        method: 'POST',
        headers: buildAuthHeaders(token, true),
        body: JSON.stringify({
          ...buildScopeBody(),
          installPath,
          installCommand: installCommand.trim() || undefined,
          force: installForce,
        }),
        signal: AbortSignal.timeout(320_000),
      });
      const data = (await response.json()) as {
        logs?: string[];
        ok?: boolean;
        installed?: boolean;
        alreadyInstalled?: boolean;
      };
      setInstallLogs(data.logs ?? []);
      if (!response.ok || data.ok === false) {
        setStepTone((prev) => ({ ...prev, run: 'error' }));
      } else if (data.alreadyInstalled) {
        setStepTone((prev) => ({ ...prev, run: 'warning' }));
      } else {
        setStepTone((prev) => ({ ...prev, run: 'success' }));
      }
    } finally {
      setInstallBusy(null);
    }
  }, [installBusy, baseUrl, token, buildScopeBody, installPath, installCommand, installForce]);

  const runInstallVerify = useCallback(async () => {
    if (installBusy) return;
    setInstallBusy('verify');
    setStepTone((prev) => ({ ...prev, verify: 'running' }));
    setRegisterMessage(null);
    try {
      const response = await fetch(`${baseUrl}/openclaw/install/verify`, {
        method: 'POST',
        headers: buildAuthHeaders(token, true),
        body: JSON.stringify({
          ...buildScopeBody(),
          installPath,
        }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = (await response.json()) as {
        ok?: boolean;
        message?: string;
        version?: string | null;
      };
      const versionText = data.version ? ` (version: ${data.version})` : '';
      setVerifyMessage(`${data.message ?? 'Verify completed.'}${versionText}`);
      setStepTone((prev) => ({
        ...prev,
        verify: response.ok && data.ok !== false ? 'success' : 'error',
      }));
    } catch {
      setStepTone((prev) => ({ ...prev, verify: 'error' }));
      setVerifyMessage('Verify failed due to network timeout. Check target health and retry.');
    } finally {
      setInstallBusy(null);
    }
  }, [installBusy, baseUrl, token, buildScopeBody, installPath]);

  const registerTarget = useCallback(async () => {
    if (installBusy) return;
    setInstallBusy('register');
    setStepTone((prev) => ({ ...prev, register: 'running' }));
    setRegisterMessage(null);
    try {
      const targetType = selectedMachine?.scope === 'remote_attachment' ? 'remote' : 'local';
      const labelPrefix = selectedMachine?.label ?? 'Terminal Machine';
      const response = await fetch(`${baseUrl}/openclaw/targets`, {
        method: 'POST',
        headers: buildAuthHeaders(token, true),
        body: JSON.stringify({
          label: `${labelPrefix} OpenClaw`,
          type: targetType,
          openclawDir: installPath,
          purpose: 'production',
          origin: 'user',
          enabled: true,
        }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        setRegisterMessage(`Register target failed: HTTP ${response.status}`);
        setStepTone((prev) => ({ ...prev, register: 'error' }));
        return;
      }
      setRegisterMessage('Target created successfully.');
      setStepTone((prev) => ({ ...prev, register: 'success' }));
    } catch {
      setRegisterMessage('Register target failed: network error');
      setStepTone((prev) => ({ ...prev, register: 'error' }));
    } finally {
      setInstallBusy(null);
    }
  }, [installBusy, selectedMachine, baseUrl, token, installPath]);

  const copyFixCommand = useCallback(async () => {
    if (!fixCommand) return;
    try {
      await navigator.clipboard.writeText(fixCommand);
      setVerifyMessage(
        'Copied fix command to clipboard. Paste it in terminal and retry failed step.'
      );
    } catch {
      setVerifyMessage('Could not copy command. Copy manually from the fix box.');
    }
  }, [fixCommand]);

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
        <select
          className="fleet-policy-select"
          value={selectedMachineId}
          onChange={(event) => setSelectedMachineId(event.target.value)}
          disabled={running || installBusy !== null}
          style={{ minWidth: 220 }}
        >
          {(machines.length > 0
            ? machines
            : [
                {
                  id: 'local',
                  scope: 'local',
                  label: 'Local',
                  status: 'connected',
                  host: 'localhost',
                },
              ]
          ).map((machine) => (
            <option key={machine.id} value={machine.id}>
              {machine.scope === 'local' ? machine.label : `${machine.label} (${machine.status})`}
            </option>
          ))}
        </select>
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
          <span className="term-server-url">
            {selectedMachine?.scope === 'remote_attachment'
              ? `${selectedMachine.host} via ${baseUrl}`
              : baseUrl}
          </span>
          <span className="term-server-badge">
            {selectedMachine?.scope === 'remote_attachment' ? 'Remote Machine' : 'Local Machine'}
          </span>
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

      <div className="panel term-install-panel">
        <div className="term-install-body">
          <div className="term-install-title-row">
            <div className="term-install-title">OpenClaw Install Wizard</div>
            <span className="term-install-subtitle">
              Guided setup: precheck {'->'} install {'->'} verify {'->'} register
            </span>
          </div>
          <div className={`term-readiness-card tone-${readiness.tone}`}>
            <span className="term-readiness-label">Readiness</span>
            <span>{readiness.message}</span>
          </div>
          <div className="term-install-steps">
            <span className={`term-step-badge tone-${stepTone.precheck}`}>1) Precheck</span>
            <span className={`term-step-badge tone-${stepTone.run}`}>2) Install</span>
            <span className={`term-step-badge tone-${stepTone.verify}`}>3) Verify</span>
            <span className={`term-step-badge tone-${stepTone.register}`}>4) Register</span>
          </div>
          <div className="term-install-form-grid">
            <label className="term-install-label">
              Install path
              <input
                className="text-input"
                value={installPath}
                onChange={(event) => setInstallPath(event.target.value)}
                disabled={installActionsDisabled}
                placeholder="~/.openclaw"
                style={{ marginTop: 4 }}
              />
              <span className="term-install-helper">
                Use absolute path when possible. Example: `/home/ubuntu/.openclaw`
              </span>
            </label>
            <label className="term-install-label">
              Custom install command (optional)
              <input
                className="text-input"
                value={installCommand}
                onChange={(event) => setInstallCommand(event.target.value)}
                disabled={installActionsDisabled}
                placeholder="npm install -g openclaw"
                style={{ marginTop: 4 }}
              />
              <span className="term-install-helper">
                Leave empty to use safe default order: npm {'->'} pnpm {'->'} bun.
              </span>
            </label>
            <label className="term-install-check-label">
              <input
                type="checkbox"
                checked={installForce}
                disabled={installActionsDisabled}
                onChange={(event) => setInstallForce(event.target.checked)}
              />
              Force reinstall even if OpenClaw already exists
            </label>
          </div>
          <div className="term-install-actions">
            <button
              className="btn-ghost"
              disabled={installActionsDisabled}
              onClick={() => void runInstallPrecheck()}
            >
              {installBusy === 'precheck' ? 'Prechecking…' : '1) Precheck'}
            </button>
            <button
              className="btn-primary"
              disabled={installActionsDisabled}
              onClick={() => void runInstall()}
            >
              {installBusy === 'run' ? 'Installing…' : '2) Install'}
            </button>
            <button
              className="btn-secondary"
              disabled={installActionsDisabled}
              onClick={() => void runInstallVerify()}
            >
              {installBusy === 'verify' ? 'Verifying…' : '3) Verify'}
            </button>
            <button
              className="btn-ghost"
              disabled={installActionsDisabled}
              onClick={() => void registerTarget()}
            >
              {installBusy === 'register' ? 'Registering…' : '4) Register Target'}
            </button>
          </div>
          <p className="term-install-note">
            Tip: run Precheck first on every new machine. If Verify fails, review logs and rerun
            only the failed step.
          </p>
          {precheckChecks.length > 0 ? (
            <div className="doctor-playbook-list" style={{ marginTop: 2 }}>
              {precheckChecks.map((check) => (
                <div key={check.id} className="doctor-playbook-item">
                  <span className="mono">{`${check.label} · ${check.status}`}</span>
                  <span className="doctor-hint">{check.message}</span>
                </div>
              ))}
            </div>
          ) : null}
          {installLogs.length > 0 ? (
            <pre className="term-stdout term-install-logs">{installLogs.join('\n')}</pre>
          ) : null}
          {fixCommand.length > 0 ? (
            <div className="term-fix-box">
              <div className="term-fix-title-row">
                <span className="term-fix-title">Suggested Fix Command</span>
                <button className="btn-ghost" onClick={() => void copyFixCommand()}>
                  Copy Fix Command
                </button>
              </div>
              <pre className="term-stdout">{fixCommand}</pre>
            </div>
          ) : null}
          {verifyMessage ? (
            <div className="doctor-hint term-install-feedback">{verifyMessage}</div>
          ) : null}
          {registerMessage ? (
            <div className="doctor-hint term-install-feedback">{registerMessage}</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
