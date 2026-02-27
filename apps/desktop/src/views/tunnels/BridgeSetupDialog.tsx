import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useFocusTrap } from '../../hooks/useFocusTrap';
import { IconServer } from '../../components/Icons';
import type { BridgeSetupInput } from './types';
import { buildAuthHeaders } from './utils';

interface PreflightDiagnosisCheck {
  readonly id: string;
  readonly label: string;
  readonly status: 'ok' | 'warn' | 'error';
  readonly detail: string;
}

interface PreflightDiagnosisPayload {
  readonly code: string;
  readonly title: string;
  readonly message: string;
  readonly hints: readonly string[];
  readonly checks: readonly PreflightDiagnosisCheck[];
}

interface PreflightRequestPayload {
  readonly sshHost: string;
  readonly sshPort: number;
  readonly sshUser: string;
  readonly sshKeyPath: string;
  readonly sshMode: 'alias' | 'explicit';
}

interface PreflightHistoryEntry {
  readonly id: string;
  readonly atMs: number;
  readonly status: 'passed' | 'failed';
  readonly code: string;
  readonly message: string;
  readonly sshHost: string;
  readonly sshUser: string;
  readonly sshPort: number;
  readonly sshMode: 'alias' | 'explicit';
  readonly authMethod: 'private_key' | 'ssh_agent' | 'unknown';
}

function historySeverity(entry: PreflightHistoryEntry): 'critical' | 'warn' | 'info' {
  if (entry.status === 'passed') return 'info';
  if (
    entry.code === 'ssh_auth_missing' ||
    entry.code === 'ssh_key_unreadable' ||
    entry.code === 'ssh_auth_failed' ||
    entry.code === 'ssh_network_unreachable' ||
    entry.code === 'ssh_timeout'
  ) {
    return 'critical';
  }
  return 'warn';
}

async function copyText(value: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(value);
    return true;
  } catch {
    return false;
  }
}

export function BridgeSetupDialog(props: {
  readonly baseUrl: string;
  readonly token: string;
  readonly onCancel: () => void;
  readonly onSubmit: (input: BridgeSetupInput) => Promise<void>;
  readonly loading: boolean;
}): JSX.Element {
  const PREFLIGHT_FRESH_MS = 120_000;
  const PREFLIGHT_REQUEST_TIMEOUT_MS = 35_000;
  const [preflightLoading, setPreflightLoading] = useState(false);
  const [preflightResult, setPreflightResult] = useState<string | null>(null);
  const [preflightNotes, setPreflightNotes] = useState<readonly string[]>([]);
  const [preflightError, setPreflightError] = useState<string | null>(null);
  const [preflightDiagnosis, setPreflightDiagnosis] = useState<PreflightDiagnosisPayload | null>(
    null
  );
  const [preflightHistory, setPreflightHistory] = useState<readonly PreflightHistoryEntry[]>([]);
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
  const [showSmartAssist, setShowSmartAssist] = useState(false);
  const [showTimeline, setShowTimeline] = useState(false);
  const [autoCopyCriticalSuggestion, setAutoCopyCriticalSuggestion] = useState(true);
  const [expiresIn, setExpiresIn] = useState('');
  const [openclawHome, setOpenclawHome] = useState('');
  const [copiedCommand, setCopiedCommand] = useState<string | null>(null);
  const [copiedDebug, setCopiedDebug] = useState(false);
  const [copiedLatestFailure, setCopiedLatestFailure] = useState(false);
  const [autoCopyNotice, setAutoCopyNotice] = useState<string | null>(null);
  const [highlightHistoryId, setHighlightHistoryId] = useState<string | null>(null);
  const timelineContainerRef = useRef<HTMLDivElement | null>(null);
  const latestHistoryIdRef = useRef<string | null>(null);
  const lastAutoCopiedSignatureRef = useRef<string | null>(null);
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
  const sshTarget = `${sshUser.trim() || 'root'}@${trimmedHost || '<host>'}`;
  const sshPortFlag = aliasDetected ? '' : ` -p ${String(parsedSshPort || 22)}`;
  const keyFlag = aliasDetected ? '' : ` -i ${sshKeyPath.trim() || '~/.ssh/id_rsa'}`;
  const manualSshCommand = `ssh${sshPortFlag}${keyFlag} ${sshTarget} "echo ok"`;
  const keyCheckCommand = `ls -l ${sshKeyPath.trim() || '~/.ssh/id_rsa'}`;
  const agentCommand = 'echo $SSH_AUTH_SOCK && ssh-add -l';
  const resetPreflightState = (): void => {
    setPreflightPassed(false);
    setPreflightCheckedAt(null);
    setPreflightKey(null);
    setAllowUnsafeConnect(false);
    setPreflightResult(null);
    setPreflightError(null);
    setPreflightDiagnosis(null);
    setPreflightNotes([]);
  };

  const appendPreflightHistory = useCallback(
    (entry: Omit<PreflightHistoryEntry, 'id' | 'atMs'>): void => {
      const next: PreflightHistoryEntry = {
        ...entry,
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
        atMs: Date.now(),
      };
      setPreflightHistory((prev) => [next, ...prev].slice(0, 8));
    },
    []
  );

  const buildPreflightKey = useCallback((payload: PreflightRequestPayload): string => {
    return JSON.stringify({
      sshHost: payload.sshHost,
      sshPort: payload.sshPort,
      sshUser: payload.sshUser,
      sshKeyPath: payload.sshKeyPath,
      sshMode: payload.sshMode,
    });
  }, []);

  const runPreflight = useCallback(
    (payload: PreflightRequestPayload, options?: { readonly skipGuard?: boolean }): void => {
      if (preflightLoading) return;
      if (!options?.skipGuard && !canRunPreflight) return;
      if (!payload.sshHost) return;

      const nextPreflightKey = buildPreflightKey(payload);
      setPreflightLoading(true);
      setPreflightResult(null);
      setPreflightNotes([]);
      setPreflightError(null);
      setPreflightDiagnosis(null);

      void (async () => {
        try {
          const requestBody =
            payload.sshMode === 'alias'
              ? {
                  sshHost: payload.sshHost,
                  sshPort: payload.sshPort,
                  sshUser: payload.sshUser,
                  sshKeyPath: payload.sshKeyPath,
                  sshMode: 'alias' as const,
                }
              : {
                  sshHost: payload.sshHost,
                  sshPort: payload.sshPort,
                  sshUser: payload.sshUser,
                  sshKeyPath: payload.sshKeyPath,
                  sshMode: 'explicit' as const,
                };

          const res = await fetch(`${props.baseUrl}/bridge/preflight`, {
            method: 'POST',
            headers: { ...buildAuthHeaders(props.token), 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
            signal: AbortSignal.timeout(PREFLIGHT_REQUEST_TIMEOUT_MS),
          });

          const raw = await res.text();
          const data = ((): {
            ok?: boolean;
            message?: string;
            mode?: 'alias' | 'explicit';
            sshHost?: string;
            sshUser?: string;
            sshPort?: number;
            authMethod?: 'private_key' | 'ssh_agent';
            acceptedNewHostKey?: boolean;
            hints?: string[];
            diagnosis?: PreflightDiagnosisPayload;
          } => {
            try {
              return JSON.parse(raw) as {
                ok?: boolean;
                message?: string;
                mode?: 'alias' | 'explicit';
                sshHost?: string;
                sshUser?: string;
                sshPort?: number;
                authMethod?: 'private_key' | 'ssh_agent';
                acceptedNewHostKey?: boolean;
                hints?: string[];
                diagnosis?: PreflightDiagnosisPayload;
              };
            } catch {
              return {};
            }
          })();

          if (!res.ok || !data.ok) {
            const message =
              data.message ??
              (raw.trim().length > 0
                ? raw.trim()
                : `Pre-flight failed (HTTP ${String(res.status)}).`);
            setPreflightPassed(false);
            setPreflightCheckedAt(Date.now());
            setPreflightKey(nextPreflightKey);
            setAllowUnsafeConnect(false);
            setPreflightError(message);
            setPreflightNotes([]);
            setPreflightDiagnosis(data.diagnosis ?? null);
            appendPreflightHistory({
              status: 'failed',
              code: data.diagnosis?.code ?? 'preflight_failed',
              message,
              sshHost: payload.sshHost,
              sshUser: payload.sshUser,
              sshPort: payload.sshPort,
              sshMode: payload.sshMode,
              authMethod: data.authMethod ?? 'unknown',
            });
            return;
          }

          setPreflightPassed(true);
          setPreflightCheckedAt(Date.now());
          setPreflightKey(nextPreflightKey);
          setAllowUnsafeConnect(false);
          setPreflightResult(
            `${data.message ?? 'Pre-flight passed.'} (${data.mode} ${data.sshUser}@${data.sshHost}:${data.sshPort}, auth: ${data.authMethod === 'ssh_agent' ? 'ssh-agent' : 'private key'})`
          );
          setPreflightNotes(data.hints ?? []);
          setPreflightDiagnosis(null);
          appendPreflightHistory({
            status: 'passed',
            code: data.acceptedNewHostKey ? 'ok_with_tofu' : 'ok',
            message: data.message ?? 'SSH pre-flight passed.',
            sshHost: data.sshHost ?? payload.sshHost,
            sshUser: data.sshUser ?? payload.sshUser,
            sshPort: data.sshPort ?? payload.sshPort,
            sshMode: data.mode ?? payload.sshMode,
            authMethod: data.authMethod ?? 'unknown',
          });
        } catch (error) {
          const isAbort =
            error instanceof DOMException
              ? error.name === 'AbortError'
              : typeof error === 'object' &&
                error !== null &&
                'name' in error &&
                (error as { name?: unknown }).name === 'AbortError';
          setPreflightError(
            isAbort
              ? 'Pre-flight timed out. Check SSH host/key/firewall and try again.'
              : error instanceof Error
                ? `Pre-flight request failed: ${error.message}`
                : 'Pre-flight request failed.'
          );
          if (isAbort) {
            setPreflightDiagnosis({
              code: 'ssh_timeout',
              title: 'SSH pre-flight timed out',
              message: 'The request exceeded timeout while waiting for SSH pre-flight.',
              hints: [
                'Verify SSH host/port is reachable from this machine.',
                'Check SSH firewall rules and security group.',
                'Run manual check: ssh -p <port> <user>@<host> "echo ok"',
              ],
              checks: [
                {
                  id: 'host',
                  label: 'SSH host',
                  status: 'warn',
                  detail: payload.sshHost || 'not set',
                },
                {
                  id: 'port',
                  label: 'SSH port',
                  status: 'warn',
                  detail: String(payload.sshPort || 0),
                },
              ],
            });
          } else {
            setPreflightDiagnosis(null);
          }
          setPreflightNotes([]);
          appendPreflightHistory({
            status: 'failed',
            code: isAbort ? 'ssh_timeout' : 'preflight_exception',
            message: isAbort
              ? 'Pre-flight timed out. Check SSH host/key/firewall and try again.'
              : error instanceof Error
                ? `Pre-flight request failed: ${error.message}`
                : 'Pre-flight request failed.',
            sshHost: payload.sshHost,
            sshUser: payload.sshUser,
            sshPort: payload.sshPort,
            sshMode: payload.sshMode,
            authMethod: 'unknown',
          });
        } finally {
          setPreflightLoading(false);
        }
      })();
    },
    [
      buildPreflightKey,
      canRunPreflight,
      appendPreflightHistory,
      preflightLoading,
      props.baseUrl,
      props.token,
      PREFLIGHT_REQUEST_TIMEOUT_MS,
    ]
  );

  const applyQuickFixAndRecheck = useCallback(
    (patch: {
      readonly sshUser?: string;
      readonly sshPort?: string;
      readonly sshKeyPath?: string;
    }): void => {
      const nextSshUser = patch.sshUser ?? sshUser;
      const nextSshPort = patch.sshPort ?? sshPort;
      const nextSshKeyPath = patch.sshKeyPath ?? sshKeyPath;

      if (patch.sshUser !== undefined) setSshUser(patch.sshUser);
      if (patch.sshPort !== undefined) setSshPort(patch.sshPort);
      if (patch.sshKeyPath !== undefined) setSshKeyPath(patch.sshKeyPath);

      resetPreflightState();
      runPreflight(
        {
          sshHost: trimmedHost,
          sshPort: Number(nextSshPort) || 0,
          sshUser: nextSshUser.trim() || 'root',
          sshKeyPath: nextSshKeyPath.trim() || '~/.ssh/id_rsa',
          sshMode: aliasDetected ? 'alias' : 'explicit',
        },
        { skipGuard: true }
      );
    },
    [aliasDetected, runPreflight, sshKeyPath, sshPort, sshUser, trimmedHost]
  );

  const quickFixActions = useMemo(() => {
    if (!preflightDiagnosis || aliasDetected)
      return [] as readonly { id: string; label: string; apply: () => void }[];

    const actions: Array<{ id: string; label: string; apply: () => void }> = [];

    if (
      preflightDiagnosis.code === 'ssh_key_unreadable' ||
      preflightDiagnosis.code === 'ssh_auth_missing'
    ) {
      if (sshKeyPath.trim() !== '~/.ssh/id_ed25519') {
        actions.push({
          id: 'set-ed25519-key',
          label: 'Apply + Recheck: ~/.ssh/id_ed25519',
          apply: () => applyQuickFixAndRecheck({ sshKeyPath: '~/.ssh/id_ed25519' }),
        });
      }
      if (sshKeyPath.trim() !== '~/.ssh/id_rsa') {
        actions.push({
          id: 'set-rsa-key',
          label: 'Apply + Recheck: ~/.ssh/id_rsa',
          apply: () => applyQuickFixAndRecheck({ sshKeyPath: '~/.ssh/id_rsa' }),
        });
      }
    }

    if (
      preflightDiagnosis.code === 'ssh_auth_failed' ||
      preflightDiagnosis.code === 'ssh_network_unreachable' ||
      preflightDiagnosis.code === 'ssh_timeout'
    ) {
      if ((sshUser.trim() || 'root') !== 'root') {
        actions.push({
          id: 'set-root-user',
          label: 'Apply + Recheck: user root',
          apply: () => applyQuickFixAndRecheck({ sshUser: 'root' }),
        });
      }
      if (String(parsedSshPort || 22) !== '22') {
        actions.push({
          id: 'set-port-22',
          label: 'Apply + Recheck: port 22',
          apply: () => applyQuickFixAndRecheck({ sshPort: '22' }),
        });
      }
    }

    return actions;
  }, [
    aliasDetected,
    applyQuickFixAndRecheck,
    parsedSshPort,
    preflightDiagnosis,
    sshKeyPath,
    sshUser,
  ]);

  const debugSnapshot = useMemo(
    () => ({
      generatedAt: new Date().toISOString(),
      endpoint: props.baseUrl,
      form: {
        sshHost: trimmedHost,
        sshPort: parsedSshPort,
        sshUser: sshUser.trim() || 'root',
        sshKeyPath: sshKeyPath.trim() || '~/.ssh/id_rsa',
        sshMode: aliasDetected ? 'alias' : 'explicit',
        remotePort: parsedRemotePort,
      },
      latest: {
        preflightPassed,
        preflightResult,
        preflightError,
        preflightDiagnosis,
        preflightCheckedAt,
      },
      history: preflightHistory,
    }),
    [
      aliasDetected,
      parsedRemotePort,
      parsedSshPort,
      preflightCheckedAt,
      preflightDiagnosis,
      preflightError,
      preflightHistory,
      preflightPassed,
      preflightResult,
      props.baseUrl,
      sshKeyPath,
      sshUser,
      trimmedHost,
    ]
  );
  const latestFailure = useMemo(
    () => preflightHistory.find((entry) => entry.status === 'failed') ?? null,
    [preflightHistory]
  );
  const autoCopySuggestion = useMemo(() => {
    if (!preflightDiagnosis) return null;
    switch (preflightDiagnosis.code) {
      case 'ssh_key_unreadable':
        return { id: 'key-check', label: 'key check', command: keyCheckCommand };
      case 'ssh_auth_missing':
        return { id: 'agent-check', label: 'ssh-agent check', command: agentCommand };
      case 'ssh_timeout':
        return { id: 'ssh-check', label: 'ssh test', command: manualSshCommand };
      default:
        return null;
    }
  }, [agentCommand, keyCheckCommand, manualSshCommand, preflightDiagnosis]);

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
    runPreflight({
      sshHost: trimmedHost,
      sshPort: parsedSshPort,
      sshUser: sshUser.trim() || 'root',
      sshKeyPath: sshKeyPath.trim() || '~/.ssh/id_rsa',
      sshMode: aliasDetected ? 'alias' : 'explicit',
    });
  };

  useEffect(() => {
    setAllowUnsafeConnect(false);
  }, [currentPreflightKey]);

  useEffect(() => {
    if (preflightDiagnosis || preflightError) {
      setShowSmartAssist(true);
    }
  }, [preflightDiagnosis, preflightError]);

  useEffect(() => {
    if (preflightHistory.length > 0) {
      setShowTimeline(true);
    }
  }, [preflightHistory.length]);

  useEffect(() => {
    if (!autoCopyCriticalSuggestion) return;
    if (!preflightDiagnosis || !autoCopySuggestion) return;

    const signature = `${preflightDiagnosis.code}|${autoCopySuggestion.command}`;
    if (lastAutoCopiedSignatureRef.current === signature) return;

    lastAutoCopiedSignatureRef.current = signature;
    void copyText(autoCopySuggestion.command).then((ok) => {
      if (!ok) return;
      setAutoCopyNotice(`Auto-copied ${autoCopySuggestion.label} command for quick fix.`);
      window.setTimeout(() => setAutoCopyNotice(null), 2200);
    });
  }, [autoCopyCriticalSuggestion, autoCopySuggestion, preflightDiagnosis]);

  useEffect(() => {
    const latest = preflightHistory[0];
    if (!latest) return;
    if (latestHistoryIdRef.current === latest.id) return;
    latestHistoryIdRef.current = latest.id;

    if (latest.status === 'failed') {
      setShowTimeline(true);
      setHighlightHistoryId(latest.id);
      window.setTimeout(
        () => setHighlightHistoryId((prev) => (prev === latest.id ? null : prev)),
        2500
      );
      window.requestAnimationFrame(() => {
        const node = timelineContainerRef.current?.querySelector(
          `#preflight-history-${latest.id}`
        ) as HTMLElement | null;
        node?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      });
    }
  }, [preflightHistory]);

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
            {preflightNotes.length > 0 ? (
              <ul style={{ margin: '6px 0 0', paddingLeft: 16, color: 'var(--text-secondary)' }}>
                {preflightNotes.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
            ) : null}
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
        {preflightDiagnosis ? (
          <div
            style={{
              marginTop: 10,
              border: '1px solid var(--yellow-dim)',
              borderRadius: 8,
              padding: '8px 10px',
              background: 'color-mix(in srgb, var(--yellow-dim) 14%, transparent)',
              fontSize: '0.73rem',
              color: 'var(--text-primary)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 10,
                marginBottom: 6,
              }}
            >
              <strong>{preflightDiagnosis.title}</strong>
              <span className="badge tone-warn">{preflightDiagnosis.code}</span>
            </div>
            <p style={{ margin: '0 0 8px', color: 'var(--text-muted)' }}>
              {preflightDiagnosis.message}
            </p>
            {preflightDiagnosis.checks.length > 0 ? (
              <div style={{ display: 'grid', gap: 4, marginBottom: 8 }}>
                {preflightDiagnosis.checks.map((check) => (
                  <div
                    key={check.id}
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '96px 1fr',
                      gap: 8,
                      alignItems: 'start',
                    }}
                  >
                    <span
                      className={`badge ${check.status === 'error' ? 'tone-bad' : check.status === 'warn' ? 'tone-warn' : 'tone-good'}`}
                      style={{ justifySelf: 'start' }}
                    >
                      {check.label}
                    </span>
                    <span style={{ color: 'var(--text-muted)' }}>{check.detail}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {preflightDiagnosis.hints.length > 0 ? (
              <ul style={{ margin: 0, paddingLeft: 16, color: 'var(--text-secondary)' }}>
                {preflightDiagnosis.hints.map((hint) => (
                  <li key={hint}>{hint}</li>
                ))}
              </ul>
            ) : null}
            {quickFixActions.length > 0 ? (
              <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {quickFixActions.map((action) => (
                  <button
                    key={action.id}
                    className="btn-ghost"
                    type="button"
                    style={{ height: 24, padding: '0 8px', fontSize: '0.72rem' }}
                    onClick={action.apply}
                  >
                    {action.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        ) : null}
        <div
          style={{
            marginTop: 10,
            border: '1px solid var(--border-muted)',
            borderRadius: 8,
            padding: '8px 10px',
            background: 'color-mix(in srgb, var(--bg-elevated) 55%, transparent)',
            display: 'grid',
            gap: 8,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 8,
            }}
          >
            <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
              Smart Assist (WSL/API terminal commands)
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 5,
                  fontSize: '0.68rem',
                  color: 'var(--text-dim)',
                  userSelect: 'none',
                }}
              >
                <input
                  type="checkbox"
                  checked={autoCopyCriticalSuggestion}
                  onChange={(event) => setAutoCopyCriticalSuggestion(event.target.checked)}
                />
                Auto-copy critical suggestion
              </label>
              <button
                className="btn-ghost"
                type="button"
                style={{ height: 22, padding: '0 8px', fontSize: '0.68rem' }}
                onClick={() => setShowSmartAssist((prev) => !prev)}
              >
                {showSmartAssist ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          {autoCopyNotice ? (
            <div style={{ fontSize: '0.68rem', color: 'var(--accent)', marginTop: -2 }}>
              {autoCopyNotice}
            </div>
          ) : null}
          {showSmartAssist ? (
            <div style={{ display: 'grid', gap: 6 }}>
              {(
                [
                  { id: 'ssh-check', label: 'Copy SSH test', command: manualSshCommand },
                  { id: 'key-check', label: 'Copy key check', command: keyCheckCommand },
                  { id: 'agent-check', label: 'Copy ssh-agent check', command: agentCommand },
                ] as const
              ).map((item) => (
                <div
                  key={item.id}
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '120px 1fr',
                    gap: 8,
                    alignItems: 'center',
                  }}
                >
                  <button
                    className="btn-ghost"
                    type="button"
                    onClick={() => {
                      void copyText(item.command).then((ok) => {
                        if (ok) {
                          setCopiedCommand(item.id);
                          window.setTimeout(() => {
                            setCopiedCommand((prev) => (prev === item.id ? null : prev));
                          }, 1200);
                        }
                      });
                    }}
                    style={{ height: 24, padding: '0 8px', fontSize: '0.72rem' }}
                  >
                    {copiedCommand === item.id ? 'Copied' : item.label}
                  </button>
                  <code
                    style={{
                      display: 'block',
                      whiteSpace: 'nowrap',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      fontSize: '0.68rem',
                      color: 'var(--text-secondary)',
                    }}
                    title={item.command}
                  >
                    {item.command}
                  </code>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {preflightHistory.length > 0 ? (
          <div
            style={{
              marginTop: 10,
              border: '1px solid var(--border-muted)',
              borderRadius: 8,
              padding: '8px 10px',
              background: 'color-mix(in srgb, var(--bg-elevated) 45%, transparent)',
              display: 'grid',
              gap: 6,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 8,
              }}
            >
              <span style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>
                Pre-flight Timeline
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button
                  className="btn-ghost"
                  type="button"
                  style={{ height: 22, padding: '0 8px', fontSize: '0.68rem' }}
                  disabled={!latestFailure}
                  onClick={() => {
                    if (!latestFailure) return;
                    void copyText(
                      JSON.stringify(
                        {
                          generatedAt: new Date().toISOString(),
                          latestFailure,
                        },
                        null,
                        2
                      )
                    ).then((ok) => {
                      if (ok) {
                        setCopiedLatestFailure(true);
                        window.setTimeout(() => setCopiedLatestFailure(false), 1200);
                      }
                    });
                  }}
                >
                  {copiedLatestFailure ? 'Copied Failure' : 'Copy Latest Failure'}
                </button>
                <button
                  className="btn-ghost"
                  type="button"
                  style={{ height: 22, padding: '0 8px', fontSize: '0.68rem' }}
                  onClick={() => {
                    void copyText(JSON.stringify(debugSnapshot, null, 2)).then((ok) => {
                      if (ok) {
                        setCopiedDebug(true);
                        window.setTimeout(() => setCopiedDebug(false), 1200);
                      }
                    });
                  }}
                >
                  {copiedDebug ? 'Copied JSON' : 'Copy Debug JSON'}
                </button>
                <button
                  className="btn-ghost"
                  type="button"
                  style={{ height: 22, padding: '0 8px', fontSize: '0.68rem' }}
                  onClick={() => setShowTimeline((prev) => !prev)}
                >
                  {showTimeline ? 'Hide' : 'Show'}
                </button>
                <button
                  className="btn-ghost"
                  type="button"
                  style={{ height: 22, padding: '0 8px', fontSize: '0.68rem' }}
                  onClick={() => setPreflightHistory([])}
                >
                  Clear
                </button>
              </div>
            </div>
            {showTimeline ? (
              <div ref={timelineContainerRef} style={{ display: 'grid', gap: 6 }}>
                {preflightHistory.map((entry) =>
                  (() => {
                    const severity = historySeverity(entry);
                    const severityBadgeClass =
                      severity === 'critical'
                        ? 'tone-bad'
                        : severity === 'warn'
                          ? 'tone-warn'
                          : 'tone-neutral';
                    const severityLabel =
                      severity === 'critical' ? 'critical' : severity === 'warn' ? 'warn' : 'info';
                    return (
                      <div
                        id={`preflight-history-${entry.id}`}
                        key={entry.id}
                        style={{
                          border:
                            highlightHistoryId === entry.id
                              ? '1px solid var(--accent)'
                              : '1px solid var(--border-muted)',
                          borderRadius: 6,
                          padding: '6px 8px',
                          display: 'grid',
                          gap: 4,
                          boxShadow:
                            highlightHistoryId === entry.id
                              ? '0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent)'
                              : undefined,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            flexWrap: 'wrap',
                          }}
                        >
                          <span
                            className={`badge ${entry.status === 'passed' ? 'tone-good' : 'tone-bad'}`}
                          >
                            {entry.status}
                          </span>
                          <span className="badge tone-neutral">{entry.code}</span>
                          <span className={`badge ${severityBadgeClass}`}>{severityLabel}</span>
                          <span style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>
                            {new Date(entry.atMs).toLocaleTimeString()}
                          </span>
                        </div>
                        <div style={{ fontSize: '0.72rem', color: 'var(--text-secondary)' }}>
                          {entry.message}
                        </div>
                        <div style={{ fontSize: '0.68rem', color: 'var(--text-dim)' }}>
                          {entry.sshMode} {entry.sshUser}@{entry.sshHost}:{entry.sshPort} • auth{' '}
                          {entry.authMethod}
                        </div>
                      </div>
                    );
                  })()
                )}
              </div>
            ) : (
              <div style={{ fontSize: '0.7rem', color: 'var(--text-dim)' }}>
                Timeline hidden to keep the dialog compact.
              </div>
            )}
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
