import { useEffect, useMemo, useRef, useState } from 'react';
import { useToast } from '../components/Toast';
import { NotificationCenter } from '../components/NotificationCenter';
import type { UseNotificationsResult } from '../hooks/useNotifications';
import type { OpenClawTargetInfo } from '../hooks/useOpenClawTargets';
import type { ConnectionStatus } from '../types';
import { IconSearch } from '../components/Icons';
import { isSmokeTarget } from '../features/openclaw/selection/smoke-targets';

export interface TopMachineContextBarProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly status: ConnectionStatus;
  readonly errorMessage: string | null;
  readonly onBaseUrlChange: (value: string) => void;
  readonly onTokenChange: (value: string) => void;
  readonly onConnect: () => void;
  readonly onDisconnect: () => void;
  readonly notifications: UseNotificationsResult;
  readonly onOpenPalette: () => void;
  readonly openclawTargets: readonly OpenClawTargetInfo[];
  readonly openclawTargetsIssue?: string | null;
  readonly selectedTargetId: string | null;
  readonly targetSelectionMode: 'auto' | 'manual';
  readonly onSelectedTargetIdChange: (targetId: string | null) => void;
}

function toStatusLabel(status: ConnectionStatus): string {
  switch (status) {
    case 'connected':
      return 'Connected';
    case 'degraded':
      return 'Degraded';
    case 'connecting':
      return 'Connecting…';
    case 'error':
      return 'Error';
    case 'idle':
      return 'Idle';
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}

export function TopMachineContextBar(props: TopMachineContextBarProps): JSX.Element {
  const isConnecting = props.status === 'connecting';
  const isConnected = props.status === 'connected' || props.status === 'degraded';
  const [editorOpen, setEditorOpen] = useState(false);
  const [authRequired, setAuthRequired] = useState(false);
  const endpointInputRef = useRef<HTMLInputElement>(null);
  const editorPopoverRef = useRef<HTMLDivElement>(null);
  const { addToast } = useToast();

  const tokenMissingForAuth = authRequired && props.token.trim().length === 0;
  const hiddenSmokeTargetCount = useMemo(
    () => props.openclawTargets.filter((target) => isSmokeTarget(target)).length,
    [props.openclawTargets]
  );
  const targetOptions = useMemo(() => {
    type TargetCandidate = OpenClawTargetInfo;
    const groups = new Map<string, TargetCandidate[]>();

    for (const target of props.openclawTargets) {
      if (isSmokeTarget(target)) continue;
      const key = `${target.type}::${target.label.trim().toLowerCase()}`;
      const list = groups.get(key);
      if (list) {
        list.push(target);
      } else {
        groups.set(key, [target]);
      }
    }

    const resolvedTargets: TargetCandidate[] = [];
    for (const candidates of groups.values()) {
      let chosen = candidates[0];
      if (!chosen) continue;

      for (const candidate of candidates) {
        if (props.selectedTargetId && candidate.id === props.selectedTargetId) {
          chosen = candidate;
          break;
        }
        if (candidate.updatedAt > chosen.updatedAt) {
          chosen = candidate;
        }
      }
      resolvedTargets.push(chosen);
    }

    resolvedTargets.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'remote' ? -1 : 1;
      return a.label.localeCompare(b.label);
    });

    return resolvedTargets.map((target) => ({
      id: target.id,
      value: target.id,
      compactLabel: target.label,
      expandedLabel: `${target.label} (${target.type})`,
    }));
  }, [props.openclawTargets, props.selectedTargetId]);
  const hasTargetChoice = targetOptions.length > 1;
  const singleTargetOption = targetOptions.length === 1 ? targetOptions[0] : null;
  const compactSelectedValue =
    props.targetSelectionMode === 'auto'
      ? ''
      : (props.selectedTargetId ?? singleTargetOption?.value ?? '');
  const compactSelectedLabel =
    targetOptions.find((option) => option.id === compactSelectedValue)?.compactLabel ?? 'No target';
  const showHiddenTargetBadge = import.meta.env.DEV && editorOpen && hiddenSmokeTargetCount > 0;

  useEffect(() => {
    if (isConnected) {
      setEditorOpen(false);
    }
  }, [isConnected]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent): void => {
      const withMeta = event.metaKey || event.ctrlKey;
      if (!withMeta || event.key !== ',') return;

      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isTypingTarget =
        tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable;
      if (isTypingTarget) return;

      event.preventDefault();
      setEditorOpen((current) => !current);
    };

    window.addEventListener('keydown', onShortcut);
    return () => {
      window.removeEventListener('keydown', onShortcut);
    };
  }, []);

  useEffect(() => {
    if (!editorOpen) return;
    endpointInputRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setEditorOpen(false);
        return;
      }
      if (event.key !== 'Tab') return;

      const container = editorPopoverRef.current;
      if (!container) return;
      const focusables = container.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [editorOpen]);

  useEffect(() => {
    if (isConnected) {
      setAuthRequired(false);
      return;
    }

    let cancelled = false;

    const probeAuthMode = async (): Promise<void> => {
      try {
        const response = await fetch(`${props.baseUrl}/health`, {
          signal: AbortSignal.timeout(3_000),
        });
        if (!response.ok || cancelled) return;
        const payload = (await response.json()) as {
          authMode?: 'none' | 'token';
          authRequired?: boolean;
        };
        if (cancelled) return;
        setAuthRequired(payload.authMode === 'token' || payload.authRequired === true);
      } catch {
        if (!cancelled) {
          setAuthRequired(false);
        }
      }
    };

    void probeAuthMode();
    const interval = setInterval(() => {
      void probeAuthMode();
    }, 30_000);

    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [props.baseUrl, isConnected]);

  const handlePasteToken = async (): Promise<void> => {
    try {
      const clipboard = await navigator.clipboard.readText();
      const nextToken = clipboard.trim();
      if (nextToken.length === 0) {
        addToast('warn', 'Clipboard is empty.');
        return;
      }
      props.onTokenChange(nextToken);
      addToast('success', 'Token pasted from clipboard.');
    } catch {
      addToast('error', 'Clipboard access denied. Paste manually into TOKEN field.');
    }
  };

  return (
    <header className="context-bar">
      <div className="context-brand">
        <img className="brand-icon" src="/Patzeclaw.svg" alt="Patze Control" />
        <h1>Patze Control</h1>
      </div>

      <div className="context-divider" />

      <div className="context-controls context-controls-compact">
        <span className="context-compact-endpoint mono" title={props.baseUrl}>
          {props.baseUrl}
        </span>
        {targetOptions.length > 0 ? (
          hasTargetChoice ? (
            <select
              className="context-target-select context-target-select-compact"
              aria-label="Active OpenClaw target"
              value={compactSelectedValue}
              onChange={(event) => {
                const value = event.target.value;
                props.onSelectedTargetIdChange(value.length > 0 ? value : null);
              }}
            >
              <option value="">Auto</option>
              {targetOptions.map((option) => (
                <option key={option.id} value={option.value}>
                  {option.compactLabel}
                </option>
              ))}
            </select>
          ) : (
            <span className="badge tone-info context-target-pill" title="Auto-selected target">
              {props.targetSelectionMode === 'auto'
                ? `Auto: ${singleTargetOption?.compactLabel ?? compactSelectedLabel}`
                : compactSelectedLabel}
            </span>
          )
        ) : null}
        <button
          className="btn-primary context-mini-btn"
          onClick={props.onConnect}
          disabled={isConnecting || isConnected || tokenMissingForAuth}
          title={tokenMissingForAuth ? 'Token is required by server auth mode.' : undefined}
        >
          {isConnecting ? 'Connecting…' : 'Connect'}
        </button>
        <button
          className="btn-secondary context-mini-btn"
          onClick={props.onDisconnect}
          disabled={!isConnected && !isConnecting}
        >
          Disconnect
        </button>
        <button
          className="btn-secondary context-mini-btn"
          onClick={() => {
            setEditorOpen((current) => !current);
          }}
          title="Edit connection settings (Cmd/Ctrl + ,)"
        >
          {editorOpen ? 'Close' : 'Edit'}
        </button>
        {tokenMissingForAuth ? (
          <span
            className="error-hint context-inline-error"
            title="Server requires token authentication."
          >
            Token required
          </span>
        ) : null}
      </div>

      {editorOpen ? (
        <div
          className="context-editor-backdrop"
          onClick={() => {
            setEditorOpen(false);
          }}
        >
          <div
            ref={editorPopoverRef}
            className="context-editor-popover"
            role="dialog"
            aria-modal="true"
            aria-label="Connection settings"
            onClick={(event) => {
              event.stopPropagation();
            }}
          >
            <div className="context-editor-header">
              <strong>Connection Settings</strong>
              <button
                className="btn-secondary context-mini-btn"
                onClick={() => {
                  setEditorOpen(false);
                }}
              >
                Close
              </button>
            </div>
            <div className="context-editor-grid">
              <div className="context-field">
                <span className="context-field-label">Endpoint</span>
                <input
                  ref={endpointInputRef}
                  type="url"
                  data-field="url"
                  aria-label="Control plane endpoint URL"
                  value={props.baseUrl}
                  placeholder="http://localhost:9700"
                  onChange={(event) => {
                    props.onBaseUrlChange(event.target.value);
                  }}
                  disabled={isConnecting}
                />
              </div>
              <div className="context-field">
                <span className="context-field-label">Token</span>
                <div className="context-token-row">
                  <input
                    type="password"
                    data-field="token"
                    aria-label="Authentication token"
                    value={props.token}
                    placeholder="optional"
                    onChange={(event) => {
                      props.onTokenChange(event.target.value);
                    }}
                    disabled={isConnecting}
                  />
                  <button
                    className="btn-ghost context-token-paste-btn"
                    type="button"
                    onClick={() => {
                      void handlePasteToken();
                    }}
                    disabled={isConnecting}
                    title="Paste token from clipboard"
                  >
                    Paste
                  </button>
                </div>
              </div>
              {targetOptions.length > 0 ? (
                <div className="context-field">
                  <span className="context-field-label">OpenClaw Target</span>
                  <select
                    className="context-target-select"
                    aria-label="Active OpenClaw target"
                    value={
                      props.targetSelectionMode === 'auto' ? '' : (props.selectedTargetId ?? '')
                    }
                    onChange={(event) => {
                      const value = event.target.value;
                      props.onSelectedTargetIdChange(value.length > 0 ? value : null);
                    }}
                    disabled={isConnecting}
                  >
                    <option value="">Auto</option>
                    {targetOptions.map((option) => (
                      <option key={option.id} value={option.value}>
                        {option.expandedLabel}
                      </option>
                    ))}
                  </select>
                </div>
              ) : null}
            </div>
            {showHiddenTargetBadge ? (
              <div className="context-editor-footnote">
                Hidden smoke targets: {hiddenSmokeTargetCount}
              </div>
            ) : null}
            <div className="context-editor-footnote">Shortcut: Cmd/Ctrl + ,</div>
          </div>
        </div>
      ) : null}

      {/* Search + Notifications + Status */}
      <div className="context-status-indicator">
        <button
          className="notification-bell"
          title="Search (⌘K)"
          onClick={props.onOpenPalette}
          style={{ marginRight: 2 }}
        >
          <IconSearch width={15} height={15} />
        </button>
        <NotificationCenter notifications={props.notifications} />
        <span className="context-divider" style={{ height: 18, margin: '0 6px' }} />
        <span className="context-connection-pill" data-status={props.status}>
          <span className="status-dot" data-status={props.status} />
          <span className="status-label">{toStatusLabel(props.status)}</span>
        </span>
        {props.openclawTargetsIssue ? (
          <span className="badge tone-warn" title={props.openclawTargetsIssue}>
            OpenClaw targets degraded
          </span>
        ) : null}
        {props.errorMessage ? (
          <span className="error-hint" title={props.errorMessage}>
            {props.errorMessage}
          </span>
        ) : null}
      </div>
    </header>
  );
}
