import { useEffect, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { IconServer } from '../../components/Icons';
import type { BridgeSetupInput } from './types';
import { buildAuthHeaders } from './utils';

export function BridgeSetupDialog(props: {
  readonly baseUrl: string;
  readonly token: string;
  readonly onCancel: () => void;
  readonly onSubmit: (input: BridgeSetupInput) => Promise<void>;
  readonly loading: boolean;
}): JSX.Element {
  const PREFLIGHT_FRESH_MS = 120_000;
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightResult, setPreflightResult] = useState<string | null>(null);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [preflightPassed, setPreflightPassed] = useState(false);
  const [preflightCheckedAt, setPreflightCheckedAt] = useState<number | null>(null);
  const [preflightKey, setPreflightKey] = useState<string | null>(null);
  const [allowUnsafeConnect, setAllowUnsafeConnect] = useState(false);
  const [label, setLabel] = useState('');
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('root');
  const [sshKeyPath, setSshKeyPath] = useState('~/.ssh/id_rsa');
  const [authToken, setAuthToken] = useState('');
  const [sshAliases, setSshAliases] = useState<string[]>([]);
  const [aliasFetchError, setAliasFetchError] = useState<string | null>(null);
  const [autoFilledToken, setAutoFilledToken] = useState(false);
  const [remotePort, setRemotePort] = useState('19700');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [expiresIn, setExpiresIn] = useState('');
  const [openclawHome, setOpenclawHome] = useState('');
  const { containerRef: dialogRef, handleKeyDown: trapKeyDown } = useFocusTrap(props.onCancel);
  const trimmedHost = sshHost.trim();
  const matchedAlias = sshAliases.find((alias) => alias === trimmedHost);
  const aliasDetected = Boolean(matchedAlias);

  useEffect(() => {
    const storedToken = localStorage.getItem('patze_token') ?? '';
    if (storedToken && !authToken) {
      setAuthToken(storedToken);
      setAutoFilledToken(true);
    }
  }, [authToken]);

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();

    const run = async (): Promise<void> => {
      try {
        const res = await fetch(`${props.baseUrl}/ssh/config-hosts`, {
          headers: buildAuthHeaders(props.token),
          signal: controller.signal,
        });
        if (!res.ok) {
          if (!cancelled) {
            setAliasFetchError('Unable to load SSH aliases.');
          }
          return;
        }
        const data = (await res.json()) as { aliases?: string[] };
        if (!cancelled) {
          setSshAliases(data.aliases ?? []);
          setAliasFetchError(null);
        }
      } catch {
        if (!cancelled) {
          setAliasFetchError('Unable to load SSH aliases.');
        }
      }
    };

    void run();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [props.baseUrl, props.token]);

  const parsedSshPort = Number(sshPort) || 0;
  const parsedRemotePort = Number(remotePort) || 0;
  const remotePortIsControlPlanePort = parsedRemotePort === 9700;
  const isPortValid = (p: number): boolean => p >= 1 && p <= 65535;
  const sshKeyOk =
    sshKeyPath.trim().startsWith('~/.ssh/') || sshKeyPath.trim().startsWith('~/.ssh');
  const currentPreflightKey = JSON.stringify({
    sshHost: trimmedHost,
    sshPort: parsedSshPort,
    sshUser: sshUser.trim() || 'root',
    sshKeyPath: sshKeyPath.trim() || '~/.ssh/id_rsa',
    sshMode: aliasDetected ? 'alias' : 'explicit',
  });

  const validationErrors: string[] = [];
  if (!trimmedHost) validationErrors.push('SSH Host is required.');
  if (!aliasDetected && !isPortValid(parsedSshPort))
    validationErrors.push('SSH Port must be 1–65535.');
  if (!isPortValid(parsedRemotePort)) validationErrors.push('Remote Port must be 1–65535.');
  if (!aliasDetected && !sshKeyOk) validationErrors.push('SSH Key must be under ~/.ssh/.');

  const canSubmit = validationErrors.length === 0 && !props.loading;
  const canRunPreflight = validationErrors.length === 0 && !props.loading && !preflightLoading;
  const preflightIsFresh =
    preflightPassed &&
    preflightKey === currentPreflightKey &&
    preflightCheckedAt !== null &&
    Date.now() - preflightCheckedAt <= PREFLIGHT_FRESH_MS;
  const canConnectNow = canSubmit && !preflightLoading && (preflightIsFresh || allowUnsafeConnect);

  const handleSubmit = (): void => {
    if (!canSubmit || preflightLoading) return;
    if (!preflightIsFresh && !allowUnsafeConnect) {
      setPreflightError('Run pre-flight first, or use Connect anyway (advanced).');
      return;
    }
    void props.onSubmit({
      label: label.trim() || trimmedHost,
      sshHost: trimmedHost,
      sshPort: parsedSshPort,
      sshUser: sshUser.trim() || 'root',
      sshKeyPath: sshKeyPath.trim() || '~/.ssh/id_rsa',
      ...(aliasDetected ? { sshMode: 'alias' as const } : { sshMode: 'explicit' as const }),
      authToken: authToken.trim(),
      remotePort: parsedRemotePort,
      expiresIn: expiresIn.trim() || undefined,
      openclawHome: openclawHome.trim() || undefined,
    });
  };

  const handlePreflight = (): void => {
    if (!canRunPreflight) return;
    setPreflightLoading(true);
    setPreflightResult(null);
    setPreflightError(null);

    const payload = {
      sshHost: trimmedHost,
      sshPort: parsedSshPort,
      sshUser: sshUser.trim() || 'root',
      sshKeyPath: sshKeyPath.trim() || '~/.ssh/id_rsa',
      ...(aliasDetected ? { sshMode: 'alias' as const } : { sshMode: 'explicit' as const }),
    };

    void fetch(`${props.baseUrl}/bridge/preflight`, {
      method: 'POST',
      headers: { ...buildAuthHeaders(props.token), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    })
      .then(async (res) => {
        const data = (await res.json()) as {
          ok?: boolean;
          message?: string;
          mode?: 'alias' | 'explicit';
          sshHost?: string;
          sshUser?: string;
          sshPort?: number;
        };
        if (!res.ok || !data.ok) {
          setPreflightPassed(false);
          setPreflightCheckedAt(Date.now());
          setPreflightKey(currentPreflightKey);
          setAllowUnsafeConnect(false);
          setPreflightError(data.message ?? 'Pre-flight failed.');
          return;
        }
        setPreflightPassed(true);
        setPreflightCheckedAt(Date.now());
        setPreflightKey(currentPreflightKey);
        setAllowUnsafeConnect(false);
        setPreflightResult(
          `${data.message ?? 'Pre-flight passed.'} (${data.mode} ${data.sshUser}@${data.sshHost}:${data.sshPort})`
        );
      })
      .catch(() => {
        setPreflightError('Pre-flight request failed.');
      })
      .finally(() => {
        setPreflightLoading(false);
      });
  };

  useEffect(() => {
    setAllowUnsafeConnect(false);
  }, [currentPreflightKey]);

  return (
    <div
      className="dialog-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="bridge-setup-title"
      onKeyDown={(e) => {
        trapKeyDown(e);
        if (e.key === 'Enter' && canSubmit) handleSubmit();
      }}
    >
      <div
        className="dialog-card"
        ref={dialogRef}
        style={{
          maxWidth: 480,
          maxHeight: 'min(640px, calc(100vh - 40px))',
          overflowY: 'auto',
          overscrollBehavior: 'contain',
        }}
      >
        <h3 id="bridge-setup-title">
          <IconServer
            width={18}
            height={18}
            style={{ marginRight: 6, verticalAlign: 'text-bottom' }}
          />
          Connect VPS Bridge
        </h3>
        <p style={{ fontSize: '0.78rem', color: 'var(--text-muted)', margin: '4px 0 14px' }}>
          Establishes a reverse SSH tunnel to your VPS and optionally installs the bridge agent.
        </p>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
            marginBottom: 10,
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid var(--border-muted)',
            background: 'color-mix(in srgb, var(--bg-elevated) 45%, transparent)',
            boxShadow: 'inset 0 1px 0 color-mix(in srgb, var(--text-muted) 12%, transparent)',
            transition: 'border-color 160ms ease, box-shadow 160ms ease',
          }}
        >
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            <span
              style={{
                display: 'block',
                fontSize: '0.66rem',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
            >
              Mode
            </span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 600 }}>
              {aliasDetected ? 'SSH Alias' : 'Explicit Host'}
            </span>
          </div>
          <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
            <span
              style={{
                display: 'block',
                fontSize: '0.66rem',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
              }}
            >
              Pre-flight
            </span>
            <span
              style={{
                color: preflightIsFresh ? 'var(--green)' : 'var(--yellow)',
                fontWeight: 600,
              }}
            >
              {preflightIsFresh ? 'Passed' : 'Required'}
            </span>
          </div>
        </div>
        <p style={{ margin: '0 0 12px', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
          Default remote port: 19700{autoFilledToken ? ' • Saved token loaded' : ''}
        </p>
        {aliasDetected ? (
          <div
            style={{
              marginBottom: 10,
              border: '1px solid var(--accent-dim)',
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: '0.72rem',
              color: 'var(--text-secondary)',
              background: 'color-mix(in srgb, var(--accent-dim) 10%, transparent)',
            }}
          >
            Alias mode active: user/port/key are resolved automatically from `~/.ssh/config`.
          </div>
        ) : null}

        <div className="dialog-form-grid">
          <div className="dialog-form-row cols-2">
            <div className="dialog-field">
              <span className="dialog-field-label">Label</span>
              <input
                type="text"
                value={label}
                onChange={(e) => {
                  setLabel(e.target.value);
                }}
                placeholder="My VPS"
              />
            </div>
            <div className="dialog-field">
              <span className="dialog-field-label">SSH Host *</span>
              <input
                type="text"
                value={sshHost}
                onChange={(e) => {
                  setSshHost(e.target.value);
                }}
                placeholder="192.168.1.100"
                list="ssh-alias-list"
              />
              <datalist id="ssh-alias-list">
                {sshAliases.map((alias) => (
                  <option key={alias} value={alias} />
                ))}
              </datalist>
              {aliasDetected ? (
                <p style={{ margin: '6px 0 0', fontSize: '0.72rem', color: 'var(--accent)' }}>
                  SSH alias detected (`{matchedAlias}`) — user/port/key will use `~/.ssh/config`.
                </p>
              ) : null}
              {!aliasDetected && aliasFetchError ? (
                <p style={{ margin: '6px 0 0', fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                  {aliasFetchError}
                </p>
              ) : null}
            </div>
          </div>
          <div className="dialog-form-row cols-2">
            <div className="dialog-field">
              <span className="dialog-field-label">SSH User</span>
              <input
                type="text"
                value={sshUser}
                onChange={(e) => {
                  setSshUser(e.target.value);
                }}
                placeholder="root"
                disabled={aliasDetected}
                style={aliasDetected ? { opacity: 0.6 } : undefined}
              />
            </div>
            <div className="dialog-field">
              <span className="dialog-field-label">SSH Port</span>
              <input
                type="number"
                value={sshPort}
                onChange={(e) => {
                  setSshPort(e.target.value);
                }}
                disabled={aliasDetected}
                style={aliasDetected ? { opacity: 0.6 } : undefined}
              />
            </div>
          </div>
          <div className="dialog-field">
            <span className="dialog-field-label">SSH Key Path</span>
            <input
              type="text"
              value={sshKeyPath}
              onChange={(e) => {
                setSshKeyPath(e.target.value);
              }}
              placeholder="~/.ssh/id_rsa"
              disabled={aliasDetected}
              style={aliasDetected ? { opacity: 0.6 } : undefined}
            />
          </div>
          <div className="dialog-form-row cols-2">
            <div className="dialog-field">
              <span className="dialog-field-label">Auth Token</span>
              <input
                type="password"
                value={authToken}
                onChange={(e) => {
                  setAuthToken(e.target.value);
                }}
                placeholder="Token for bridge auth"
              />
            </div>
            <div className="dialog-field">
              <span className="dialog-field-label">Remote Port</span>
              <input
                type="number"
                value={remotePort}
                onChange={(e) => {
                  setRemotePort(e.target.value);
                }}
              />
            </div>
          </div>
        </div>
        {remotePortIsControlPlanePort ? (
          <div
            style={{
              marginTop: 10,
              border: '1px solid var(--yellow-dim)',
              borderRadius: 8,
              padding: '8px 10px',
              fontSize: '0.72rem',
              color: 'var(--yellow)',
              background: 'color-mix(in srgb, var(--yellow-dim) 16%, transparent)',
            }}
          >
            Recommended: use a remote port other than 9700 to avoid overlapping with control plane
            endpoint.
          </div>
        ) : null}
        <p
          style={{ marginTop: 8, marginBottom: 0, fontSize: '0.72rem', color: 'var(--text-muted)' }}
        >
          Security note: reverse tunnel binds to `127.0.0.1` by default; review SSHD `GatewayPorts`
          policy on VPS.
        </p>

        <button
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--accent)',
            cursor: 'pointer',
            fontSize: '0.75rem',
            padding: '8px 0 0',
            textDecoration: 'underline',
          }}
          onClick={() => {
            setShowAdvanced(!showAdvanced);
          }}
        >
          {showAdvanced ? 'Hide advanced options' : 'Show advanced options'}
        </button>

        {showAdvanced ? (
          <div className="dialog-form-grid" style={{ marginTop: 8 }}>
            <p style={{ margin: 0, fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              Advanced options are optional: set token TTL or custom OpenClaw home when needed.
            </p>
            <div className="dialog-form-row cols-2">
              <div className="dialog-field">
                <span className="dialog-field-label">Token Expires In</span>
                <input
                  type="text"
                  value={expiresIn}
                  onChange={(e) => {
                    setExpiresIn(e.target.value);
                  }}
                  placeholder="24h, 7d"
                />
              </div>
              <div className="dialog-field">
                <span className="dialog-field-label">OpenClaw Home</span>
                <input
                  type="text"
                  value={openclawHome}
                  onChange={(e) => {
                    setOpenclawHome(e.target.value);
                  }}
                  placeholder="~/.openclaw"
                />
              </div>
            </div>
          </div>
        ) : null}

        <div style={{ marginTop: 10, borderTop: '1px solid var(--border-muted)' }} />
        {validationErrors.length > 0 && trimmedHost.length > 0 ? (
          <ul
            style={{
              margin: '10px 0 0',
              padding: '0 0 0 16px',
              fontSize: '0.75rem',
              color: 'var(--error)',
              listStyle: 'disc',
            }}
          >
            {validationErrors.map((msg) => (
              <li key={msg}>{msg}</li>
            ))}
          </ul>
        ) : null}
        {preflightResult ? (
          <div
            style={{
              marginTop: 10,
              fontSize: '0.74rem',
              color: 'var(--green)',
              border: '1px solid var(--green-dim)',
              borderRadius: 8,
              padding: '7px 10px',
              background: 'color-mix(in srgb, var(--green-dim) 12%, transparent)',
            }}
          >
            {preflightResult}
          </div>
        ) : null}
        {preflightError ? (
          <div
            style={{
              marginTop: 10,
              fontSize: '0.74rem',
              color: 'var(--red)',
              border: '1px solid var(--red-dim)',
              borderRadius: 8,
              padding: '7px 10px',
              background: 'color-mix(in srgb, var(--red-dim) 12%, transparent)',
            }}
          >
            {preflightError}
          </div>
        ) : null}

        <div style={{ marginTop: 16, display: 'grid', gap: 10 }}>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button className="btn-ghost" onClick={handlePreflight} disabled={!canRunPreflight}>
              {preflightLoading ? 'Testing SSH…' : 'Run Pre-flight'}
            </button>
            {!preflightIsFresh && preflightCheckedAt !== null ? (
              <button
                className="btn-ghost"
                onClick={() => {
                  setAllowUnsafeConnect(true);
                }}
                disabled={!canSubmit || preflightLoading}
                title="Bypass pre-flight for advanced scenarios only."
              >
                Connect anyway
              </button>
            ) : null}
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn-secondary" onClick={props.onCancel} disabled={props.loading}>
              Cancel
            </button>
            <button className="btn-primary" onClick={handleSubmit} disabled={!canConnectNow}>
              {props.loading ? 'Connecting…' : 'Connect'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
