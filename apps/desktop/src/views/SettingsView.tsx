import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../components/Toast';
import { IconActivity, IconLock } from '../components/Icons';
import { HealthBadge } from '../components/badges/HealthBadge';
import type { ConnectionStatus, FrontendUnifiedSnapshot } from '../types';

export interface SettingsViewProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly baseUrl: string;
  readonly token: string;
  readonly status: ConnectionStatus;
}

const STALE_THRESHOLD_MS = 5 * 60 * 1000;

interface AuthState {
  mode: 'none' | 'token';
  hasToken: boolean;
}

const TOKEN_CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TOKEN_PREFIX = 'pk_';
const GENERATED_TOKEN_LENGTH = 32;
const TOKEN_MIN_LENGTH = 16;

function generateSecureToken(): string {
  const values = crypto.getRandomValues(new Uint8Array(GENERATED_TOKEN_LENGTH));
  let token = TOKEN_PREFIX;
  for (const byte of values) {
    token += TOKEN_CHARSET[byte % TOKEN_CHARSET.length];
  }
  return token;
}

const LOCALSTORAGE_TOKEN_KEY = 'patze_token';

function getStoredToken(): string {
  try {
    return localStorage.getItem(LOCALSTORAGE_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function maskToken(token: string): string {
  if (token.length <= 8) return '••••••••';
  return token.slice(0, 6) + '••••' + token.slice(-4);
}

function buildAuthHeaders(token: string, json?: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token.length > 0) headers['Authorization'] = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

function AuthSettingsSection(props: {
  readonly baseUrl: string;
  readonly token: string;
  readonly connected: boolean;
}): JSX.Element {
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [loading, setLoading] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [editing, setEditing] = useState(false);
  const [revealed, setRevealed] = useState(false);
  const [storedRevealed, setStoredRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { addToast } = useToast();
  const mountedRef = useRef(true);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchAuthState = useCallback(async () => {
    try {
      const res = await fetch(`${props.baseUrl}/settings/auth`, {
        headers: buildAuthHeaders(props.token),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) return;
      const data = (await res.json()) as AuthState;
      if (mountedRef.current) setAuthState(data);
    } catch {
      /* silent */
    }
  }, [props.baseUrl, props.token]);

  useEffect(() => {
    if (!props.connected) {
      setAuthState(null);
      return;
    }
    void fetchAuthState();
  }, [props.connected, fetchAuthState]);

  const resetForm = (): void => {
    setEditing(false);
    setTokenInput('');
    setRevealed(false);
    setCopied(false);
    setError(null);
  };

  const openForm = (): void => {
    setEditing(true);
    setTokenInput('');
    setRevealed(false);
    setCopied(false);
    setError(null);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
    });
  };

  const handleGenerate = (): void => {
    const token = generateSecureToken();
    setTokenInput(token);
    setRevealed(true);
    setCopied(false);
    setError(null);
  };

  const handleCopy = async (text?: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(text ?? tokenInput);
      setCopied(true);
      setTimeout(() => {
        if (mountedRef.current) setCopied(false);
      }, 2000);
    } catch {
      inputRef.current?.select();
    }
  };

  const handleSave = useCallback(async () => {
    const trimmed = tokenInput.trim();
    if (trimmed.length < TOKEN_MIN_LENGTH) {
      setError(`Minimum ${TOKEN_MIN_LENGTH} characters required.`);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${props.baseUrl}/settings/auth`, {
        method: 'POST',
        headers: buildAuthHeaders(props.token, true),
        body: JSON.stringify({ mode: 'token', token: trimmed }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(data.message ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as AuthState;
      if (mountedRef.current) {
        setAuthState(data);
        resetForm();
        addToast('success', 'Token saved. Bridges must use this token to authenticate.');
      }
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : 'Save failed.');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [props.baseUrl, props.token, tokenInput, addToast]);

  const handleDisable = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${props.baseUrl}/settings/auth`, {
        method: 'POST',
        headers: buildAuthHeaders(props.token, true),
        body: JSON.stringify({ mode: 'none', confirm: 'DISABLE_AUTH' }),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as AuthState;
      if (mountedRef.current) {
        setAuthState(data);
        resetForm();
        addToast('warn', 'Auth disabled. API is now publicly accessible.');
      }
    } catch (err) {
      if (mountedRef.current) setError(err instanceof Error ? err.message : 'Failed.');
    } finally {
      if (mountedRef.current) setLoading(false);
    }
  }, [props.baseUrl, props.token, addToast]);

  const isValid = tokenInput.trim().length >= TOKEN_MIN_LENGTH;
  const isTokenMode = authState?.mode === 'token';
  const storedToken = getStoredToken();
  const hasStoredToken = isTokenMode && storedToken.length > 0;

  if (!props.connected) {
    return (
      <div className="settings-section">
        <h3 className="settings-section-title">
          <IconLock className="doctor-icon" />
          Authentication
        </h3>
        <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
          Connect to a control plane to manage authentication.
        </p>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h3 className="settings-section-title auth-title">
        <span className="auth-title-left">
          <IconLock className="doctor-icon" />
          Authentication
        </span>
        <span
          className={`badge ${isTokenMode ? 'tone-good' : 'tone-warn'}`}
          style={{ fontWeight: 400 }}
        >
          {isTokenMode ? 'Secured' : 'Open'}
        </span>
      </h3>

      {!editing ? (
        <>
          {isTokenMode ? (
            <div className="auth-secured-panel">
              <div className="auth-status-banner auth-status-good">
                <span className="auth-status-dot" />
                <span>Token authentication is active</span>
              </div>

              {hasStoredToken ? (
                <div className="auth-token-display">
                  <span className="auth-token-label">Current Token</span>
                  <div className="auth-token-row">
                    <code className="auth-token-value">
                      {storedRevealed ? storedToken : maskToken(storedToken)}
                    </code>
                    <button
                      className="btn-ghost auth-token-btn"
                      onClick={() => {
                        setStoredRevealed(!storedRevealed);
                      }}
                    >
                      {storedRevealed ? 'Hide' : 'Reveal'}
                    </button>
                    <button
                      className="btn-ghost auth-token-btn"
                      style={copied ? { color: 'var(--green)' } : undefined}
                      onClick={() => {
                        void handleCopy(storedToken);
                      }}
                    >
                      {copied ? 'Copied!' : 'Copy'}
                    </button>
                  </div>
                </div>
              ) : null}

              <div className="auth-info-hint">
                Bridges authenticate via <code>Authorization: Bearer &lt;token&gt;</code> header.
                Use the same token when setting up VPS bridge connections.
              </div>

              <div className="auth-actions">
                <button
                  className="btn-secondary auth-action-btn"
                  onClick={openForm}
                  disabled={loading}
                >
                  Change Token
                </button>
                <button
                  className="btn-danger auth-action-btn"
                  onClick={() => {
                    void handleDisable();
                  }}
                  disabled={loading}
                >
                  Disable Auth
                </button>
              </div>
            </div>
          ) : (
            <div className="auth-open-panel">
              <div className="auth-status-banner auth-status-warn">
                <span className="auth-status-dot" />
                <span>No authentication — API endpoints are publicly accessible</span>
              </div>
              <button className="btn-primary auth-enable-btn" onClick={openForm} disabled={loading}>
                Enable Token Auth
              </button>
            </div>
          )}
        </>
      ) : (
        <div className="auth-edit-form">
          <div className="auth-input-row">
            <input
              ref={inputRef}
              type={revealed ? 'text' : 'password'}
              value={tokenInput}
              onChange={(e) => {
                setTokenInput(e.target.value);
                setCopied(false);
                if (revealed) setRevealed(false);
                setError(null);
              }}
              placeholder="Enter or generate a token"
              className="auth-token-input"
              style={revealed ? { fontFamily: 'var(--font-mono)', fontSize: '0.78rem' } : undefined}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && isValid) void handleSave();
                if (e.key === 'Escape') resetForm();
              }}
            />
            <button
              className="btn-primary auth-gen-btn"
              onClick={handleGenerate}
              disabled={loading}
            >
              Generate
            </button>
          </div>

          {tokenInput.length > 0 ? (
            <div className="auth-token-meta">
              <button
                className="btn-ghost auth-token-btn"
                onClick={() => {
                  setRevealed(!revealed);
                }}
              >
                {revealed ? 'Hide' : 'Reveal'}
              </button>
              <button
                className="btn-ghost auth-token-btn"
                style={copied ? { color: 'var(--green)' } : undefined}
                onClick={() => {
                  void handleCopy();
                }}
              >
                {copied ? 'Copied!' : 'Copy'}
              </button>
              <span
                className="auth-char-count"
                style={isValid ? { color: 'var(--green)' } : undefined}
              >
                {tokenInput.trim().length} chars {isValid ? '✓' : `(min ${TOKEN_MIN_LENGTH})`}
              </span>
            </div>
          ) : (
            <p className="auth-info-hint" style={{ margin: 0 }}>
              Click <strong>Generate</strong> for a secure random token, or type your own.
            </p>
          )}

          {error ? <p className="auth-error">{error}</p> : null}

          <div className="auth-actions">
            <button
              className="btn-primary auth-action-btn"
              onClick={() => {
                void handleSave();
              }}
              disabled={loading || !isValid}
            >
              {loading ? 'Saving…' : 'Save'}
            </button>
            <button className="btn-ghost auth-action-btn" onClick={resetForm} disabled={loading}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsView(props: SettingsViewProps): JSX.Element {
  const { snapshot, baseUrl, status } = props;
  const health = snapshot?.health;
  const [doctorRun, setDoctorRun] = useState(false);
  const isConnected = status === 'connected' || status === 'degraded';

  const doctorResults = useMemo(() => {
    if (!snapshot) {
      return null;
    }

    const now = Date.now();
    const sessions = snapshot.sessions;
    const runs = snapshot.runs;
    const machines = snapshot.machines;

    const staleSessions = sessions.filter((s) => {
      const isActive = !['completed', 'failed', 'cancelled'].includes(s.state);
      if (!isActive) {
        return false;
      }
      const lastUpdate = new Date(s.updatedAt).getTime();
      return now - lastUpdate > STALE_THRESHOLD_MS;
    });

    const orphanedRuns = runs.filter((r) => {
      const hasSession = sessions.some((s) => s.sessionId === r.sessionId);
      return !hasSession;
    });

    const offlineMachines = machines.filter((m) => m.status === 'offline');

    const issues: Array<{ severity: 'warn' | 'error' | 'info'; message: string }> = [];

    if (staleSessions.length > 0) {
      issues.push({
        severity: 'warn',
        message: `${staleSessions.length} stale session(s) — active but no update for >5 minutes`,
      });
    }

    if (orphanedRuns.length > 0) {
      issues.push({
        severity: 'warn',
        message: `${orphanedRuns.length} orphaned run(s) — session no longer tracked`,
      });
    }

    if (offlineMachines.length > 0) {
      issues.push({
        severity: 'info',
        message: `${offlineMachines.length} offline machine(s)`,
      });
    }

    if ((health?.failedRunsTotal ?? 0) > 0) {
      issues.push({
        severity: 'error',
        message: `${health?.failedRunsTotal ?? 0} failed run(s) detected`,
      });
    }

    if (issues.length === 0) {
      issues.push({ severity: 'info', message: 'All systems healthy — no issues detected' });
    }

    return {
      issues,
      totalEvents: snapshot.recentEvents.length,
      totalLogs: snapshot.logs.length,
      totalSessions: sessions.length,
      totalRuns: runs.length,
    };
  }, [snapshot, health]);

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Settings</h2>
      </div>

      <div className="settings-grid">
        <div className="settings-section">
          <h3 className="settings-section-title">Connection</h3>
          <div className="settings-row">
            <span className="settings-row-label">Endpoint</span>
            <span className="settings-row-value">{baseUrl}</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Status</span>
            <span className="settings-row-value">{status}</span>
          </div>
        </div>

        <div className="settings-section">
          <h3 className="settings-section-title">Diagnostics</h3>
          <div className="settings-row">
            <span className="settings-row-label">Overall Health</span>
            <span className="settings-row-value">
              <HealthBadge health={health ? health.overall : 'not connected'} />
            </span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Machines</span>
            <span className="settings-row-value">{health?.machines.length ?? 0}</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Stale Machines</span>
            <span className="settings-row-value">{health?.staleMachinesTotal ?? 0}</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Active Runs</span>
            <span className="settings-row-value">{health?.activeRunsTotal ?? 0}</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Failed Runs</span>
            <span className="settings-row-value">{health?.failedRunsTotal ?? 0}</span>
          </div>
        </div>

        <div className="settings-section">
          <h3 className="settings-section-title">About</h3>
          <div className="settings-row">
            <span className="settings-row-label">App</span>
            <span className="settings-row-value">Patze Control Desktop</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Version</span>
            <span className="settings-row-value">{__APP_VERSION__}</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Telemetry Schema</span>
            <span className="settings-row-value">telemetry.v1</span>
          </div>
          <div className="settings-row">
            <span className="settings-row-label">Framework</span>
            <span className="settings-row-value">Tauri 2 + React 18</span>
          </div>
        </div>

        <AuthSettingsSection baseUrl={baseUrl} token={props.token} connected={isConnected} />

        <div className="settings-section doctor-section">
          <h3 className="settings-section-title">
            <IconActivity className="doctor-icon" />
            Doctor
          </h3>
          {!snapshot ? (
            <p className="doctor-hint">Connect to a control plane to run diagnostics.</p>
          ) : !doctorRun ? (
            <div>
              <p className="doctor-hint">Check for stale sessions, orphaned runs, and anomalies.</p>
              <button
                className="btn-primary"
                onClick={() => {
                  setDoctorRun(true);
                }}
              >
                Run Doctor
              </button>
            </div>
          ) : doctorResults ? (
            <div className="doctor-results">
              <div className="doctor-summary">
                <span className="doctor-stat">{doctorResults.totalSessions} sessions</span>
                <span className="doctor-stat">{doctorResults.totalRuns} runs</span>
                <span className="doctor-stat">{doctorResults.totalEvents} events</span>
                <span className="doctor-stat">{doctorResults.totalLogs} logs</span>
              </div>
              <div className="doctor-issues">
                {doctorResults.issues.map((issue, i) => (
                  <div key={i} className={`doctor-issue doctor-issue-${issue.severity}`}>
                    <span className="doctor-issue-badge">{issue.severity.toUpperCase()}</span>
                    <span>{issue.message}</span>
                  </div>
                ))}
              </div>
              <button
                className="btn-secondary"
                style={{ marginTop: 12 }}
                onClick={() => {
                  setDoctorRun(false);
                }}
              >
                Re-run
              </button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
