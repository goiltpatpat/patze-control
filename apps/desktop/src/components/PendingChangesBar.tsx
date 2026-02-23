import { useState, useEffect, useCallback } from 'react';
import type { OpenClawCommandQueueState } from '@patze/telemetry-core';

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

export function PendingChangesBar(props: PendingChangesBarProps): JSX.Element | null {
  const { baseUrl, token, connected, targetId } = props;
  const [queue, setQueue] = useState<OpenClawCommandQueueState | null>(null);
  const [applying, setApplying] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
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
    const id = setInterval(poll, 3000);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, [baseUrl, token, connected, targetId]);

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
    }
  }, [baseUrl, token, targetId]);

  const handleDiscard = useCallback(async () => {
    if (!targetId) return;
    await discardQueue(baseUrl, token, targetId);
    setQueue(null);
  }, [baseUrl, token, targetId]);

  if (!queue || queue.totalCount === 0) return null;

  return (
    <>
      <div className="pending-changes-bar">
        <span className="pending-changes-count">
          {queue.totalCount} pending change{queue.totalCount !== 1 ? 's' : ''}
        </span>
        {error ? <span className="pending-changes-error">{error}</span> : null}
        <div className="pending-changes-actions">
          <button
            type="button"
            className="pending-changes-btn pending-changes-preview"
            onClick={() => setPreviewOpen(!previewOpen)}
          >
            Preview
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
            {applying ? 'Applying...' : 'Apply All'}
          </button>
        </div>
      </div>
      {previewOpen ? (
        <div className="pending-changes-preview-panel">
          <div className="pending-changes-preview-header">
            <strong>Queued Commands</strong>
            <button type="button" onClick={() => setPreviewOpen(false)}>
              &times;
            </button>
          </div>
          <ul className="pending-changes-list">
            {queue.commands.map((cmd) => (
              <li key={cmd.id} className="pending-changes-item">
                <code>
                  {cmd.command} {cmd.args.join(' ')}
                </code>
                <span className="pending-changes-desc">{cmd.description}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );
}
