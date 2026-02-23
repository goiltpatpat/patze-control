import { useCallback, useEffect, useRef, useState } from 'react';
import { useToast } from '../../components/Toast';
import { IconLock } from '../../components/Icons';

interface AuthState {
  mode: 'none' | 'token';
  hasToken: boolean;
}

interface HealthAuthInfo {
  authMode: 'none' | 'token';
  authRequired: boolean;
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

export function AuthSettingsSection(props: {
  readonly baseUrl: string;
  readonly token: string;
  readonly connected: boolean;
}): JSX.Element {
  const [authState, setAuthState] = useState<AuthState | null>(null);
  const [healthAuth, setHealthAuth] = useState<HealthAuthInfo | null>(null);
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

  useEffect(() => {
    let cancelled = false;
    const probe = async (): Promise<void> => {
      try {
        const res = await fetch(`${props.baseUrl}/health`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (!res.ok || cancelled) return;
        const data = (await res.json()) as Record<string, unknown>;
        if (cancelled) return;
        const mode = data.authMode === 'token' ? 'token' : 'none';
        setHealthAuth({ authMode: mode, authRequired: mode === 'token' });
      } catch {
        if (!cancelled) setHealthAuth(null);
      }
    };
    void probe();
    return () => {
      cancelled = true;
    };
  }, [props.baseUrl]);

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
    const serverReachable = healthAuth !== null;
    const authRequired = healthAuth?.authRequired === true;

    return (
      <div className="settings-section">
        <h3 className="settings-section-title auth-title">
          <span className="auth-title-left">
            <IconLock className="doctor-icon" />
            Authentication
          </span>
          {serverReachable ? (
            <span
              className={`badge ${authRequired ? 'tone-warn' : 'tone-good'}`}
              style={{ fontWeight: 400 }}
            >
              {authRequired ? 'Token Required' : 'Open'}
            </span>
          ) : null}
        </h3>

        {!serverReachable ? (
          <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            Cannot reach the API server. Check that the server is running.
          </p>
        ) : authRequired ? (
          <div className="auth-disconnected-guide">
            <div className="auth-status-banner auth-status-warn">
              <span className="auth-status-dot" />
              <span>Token authentication is active on the server</span>
            </div>
            <div className="auth-info-hint" style={{ marginTop: 8 }}>
              Enter the correct token in the <strong>TOKEN</strong> field in the top bar, then click{' '}
              <strong>Connect</strong>.
            </div>
            <div className="auth-info-hint" style={{ marginTop: 4, fontSize: '0.78rem' }}>
              Token is stored in <code>~/.patze-control/auth.json</code> on the server machine. To
              reset, delete this file and restart the API server.
            </div>
          </div>
        ) : (
          <div className="auth-disconnected-guide">
            <div className="auth-status-banner auth-status-good">
              <span className="auth-status-dot" />
              <span>No authentication required</span>
            </div>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', margin: '8px 0 0' }}>
              Click <strong>Connect</strong> in the top bar. No token is needed.
            </p>
          </div>
        )}
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
