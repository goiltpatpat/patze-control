import { useState, useEffect, useCallback } from 'react';
import type { OpenClawCommandQueueState, OpenClawConfigDiff } from '@patze/telemetry-core';
import { emitConfigChanged } from '../utils/openclaw-events';
import { DiffViewer } from './DiffViewer';

export interface PendingChangesBarProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly connected: boolean;
  readonly targetId: string | null;
}

async function fetchQueue(
  baseUrl: string,
  token: string,
  targetId: string
): Promise<OpenClawCommandQueueState | null> {
  try {
    const res = await fetch(`${baseUrl}/openclaw/queue/${encodeURIComponent(targetId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return (await res.json()) as OpenClawCommandQueueState;
  } catch {
    return null;
  }
}

async function fetchPreview(
  baseUrl: string,
  token: string,
  targetId: string
): Promise<OpenClawConfigDiff | null> {
  try {
    const res = await fetch(`${baseUrl}/openclaw/queue/${encodeURIComponent(targetId)}/preview`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { available: boolean; diff: OpenClawConfigDiff | null };
    return data.diff;
  } catch {
    return null;
  }
}

async function applyQueue(
  baseUrl: string,
  token: string,
  targetId: string
): Promise<{ ok: boolean; error?: string | undefined }> {
  try {
    const res = await fetch(`${baseUrl}/openclaw/queue/${encodeURIComponent(targetId)}/apply`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'ui' }),
    });
    return (await res.json()) as { ok: boolean; error?: string };
  } catch (err: unknown) {
    return { ok: false, error: err instanceof Error ? err.message : 'Network error' };
  }
}

async function discardQueue(baseUrl: string, token: string, targetId: string): Promise<void> {
  try {
    await fetch(`${baseUrl}/openclaw/queue/${encodeURIComponent(targetId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch {
    /* ignore */
  }
}

type PreviewTab = 'commands' | 'diff';

export function PendingChangesBar(props: PendingChangesBarProps): JSX.Element | null {
  const { baseUrl, token, connected, targetId } = props;
  const [queue, setQueue] = useState<OpenClawCommandQueueState | null>(null);
  const [applying, setApplying] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<PreviewTab>('commands');
  const [diff, setDiff] = useState<OpenClawConfigDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!connected || !targetId) return;
    let active = true;
    const poll = (): void => {
      void fetchQueue(baseUrl, token, targetId).then((q) => {
        if (active) setQueue(q);
      });
    };
    poll();
    const id = setInterval(poll, 15_000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [baseUrl, token, connected, targetId]);

  const handlePreviewToggle = useCallback(async () => {
    if (previewOpen) {
      setPreviewOpen(false);
      setDiff(null);
      return;
    }
    setPreviewOpen(true);
    setActiveTab('commands');
    if (!targetId) return;
    setDiffLoading(true);
    const result = await fetchPreview(baseUrl, token, targetId);
    setDiff(result);
    setDiffLoading(false);
    if (result?.simulated) setActiveTab('diff');
  }, [previewOpen, baseUrl, token, targetId]);

  const handleApply = useCallback(async () => {
    if (!targetId) return;
    setApplying(true);
    setError(null);
    const result = await applyQueue(baseUrl, token, targetId);
    setApplying(false);
    if (!result.ok) {
      setError(result.error ?? 'Apply failed');
    } else {
      setQueue(null);
      setPreviewOpen(false);
      setDiff(null);
      emitConfigChanged();
    }
  }, [baseUrl, token, targetId]);

  const handleDiscard = useCallback(async () => {
    if (!targetId) return;
    await discardQueue(baseUrl, token, targetId);
    setQueue(null);
    setPreviewOpen(false);
    setDiff(null);
  }, [baseUrl, token, targetId]);

  if (!queue || queue.totalCount === 0) return null;

  const hasDiff = diff != null && diff.before !== diff.after;
  const commandsList =
    diff?.commands ??
    queue.commands.map((c) => ({
      description: c.description,
      cli: `${c.command} ${c.args.join(' ')}`,
    }));

  return (
    <>
      <div className="pending-changes-bar">
        <span className="pending-changes-count">
          <span className="pcb-dot" />
          {queue.totalCount} pending change{queue.totalCount !== 1 ? 's' : ''}
        </span>
        {error ? <span className="pending-changes-error">{error}</span> : null}
        <div className="pending-changes-actions">
          <button
            type="button"
            className={`pending-changes-btn pending-changes-preview${previewOpen ? ' pcb-active' : ''}`}
            onClick={() => void handlePreviewToggle()}
          >
            {previewOpen ? 'Close' : 'Preview'}
          </button>
          <button
            type="button"
            className="pending-changes-btn pending-changes-discard"
            onClick={() => void handleDiscard()}
          >
            Discard
          </button>
          <button
            type="button"
            className="pending-changes-btn pending-changes-apply"
            onClick={() => void handleApply()}
            disabled={applying}
          >
            {applying ? 'Applying\u2026' : 'Apply All'}
          </button>
        </div>
      </div>
      {previewOpen ? (
        <div className="pending-changes-preview-panel">
          <div className="pcb-tabs">
            <button
              type="button"
              className={`pcb-tab${activeTab === 'commands' ? ' pcb-tab-active' : ''}`}
              onClick={() => setActiveTab('commands')}
            >
              Commands ({commandsList.length})
            </button>
            <button
              type="button"
              className={`pcb-tab${activeTab === 'diff' ? ' pcb-tab-active' : ''}`}
              onClick={() => setActiveTab('diff')}
              disabled={!hasDiff && !diffLoading}
            >
              Config Diff
              {diffLoading ? ' \u2026' : ''}
              {diff?.simulated === false && !diffLoading ? ' (unavailable)' : ''}
            </button>
            <button type="button" className="pcb-tab-close" onClick={() => setPreviewOpen(false)}>
              &times;
            </button>
          </div>

          {activeTab === 'commands' ? (
            <div className="pcb-cmd-list">
              {commandsList.map((cmd, i) => (
                <div key={i} className="pcb-cmd">
                  <span className="pcb-cmd-idx">{i + 1}</span>
                  <div className="pcb-cmd-body">
                    <code className="pcb-cmd-cli">{cmd.cli}</code>
                    <span className="pcb-cmd-desc">{cmd.description}</span>
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {activeTab === 'diff' ? (
            <div className="pcb-diff-pane">
              {diffLoading ? (
                <div className="pcb-diff-loading">
                  <span className="pcb-spinner" />
                  Simulating changes\u2026
                </div>
              ) : hasDiff ? (
                <DiffViewer before={diff.before} after={diff.after} title="openclaw.json" />
              ) : (
                <div className="pcb-diff-fallback">
                  {diff?.simulationError ? (
                    <>
                      <span className="pcb-diff-warn">Simulation unavailable</span>
                      <code className="pcb-diff-err">{diff.simulationError}</code>
                      <p>
                        Commands will be applied directly via CLI. Review the command list to
                        verify.
                      </p>
                    </>
                  ) : (
                    <p>No config difference detected.</p>
                  )}
                </div>
              )}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
