import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { IconBot, IconBrain, IconEdit, IconNote, IconSave } from '../components/Icons';
import { formatBytes } from '../utils/format';
import { formatRelativeTime } from '../utils/time';

export interface MemoryBrowserViewProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly connected: boolean;
}

interface MemoryFileEntry {
  readonly name: string;
  readonly path: string;
  readonly size: number;
  readonly modifiedAt: string;
}

interface MemoryAgentEntry {
  readonly agentId: string;
  readonly targetId: string;
  readonly targetType: 'local' | 'remote';
  readonly targetLabel: string;
  readonly workspacePath: string;
  readonly files: readonly MemoryFileEntry[];
}

interface FileContent {
  readonly path: string;
  readonly name: string;
  readonly extension: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly content: string;
}

const MEMORY_WRITE_ALLOWLIST: ReadonlySet<string> = new Set([
  'MEMORY.md',
  'SOUL.md',
  'TASKS.md',
  'CHANGELOG.md',
  'CONTEXT.md',
  'README.md',
]);

function buildAuthHeaders(token: string, json?: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }
  if (json) {
    headers['Content-Type'] = 'application/json';
  }
  return headers;
}

function getBaseName(filePath: string): string {
  const normalized = filePath.replaceAll('\\', '/');
  const parts = normalized.split('/');
  return parts[parts.length - 1] ?? filePath;
}

function canWrite(filePath: string): boolean {
  return MEMORY_WRITE_ALLOWLIST.has(getBaseName(filePath));
}

export function MemoryBrowserView(props: MemoryBrowserViewProps): JSX.Element {
  const [agents, setAgents] = useState<readonly MemoryAgentEntry[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<FileContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchAgents = useCallback(async () => {
    if (!props.connected) {
      return;
    }
    try {
      const res = await fetch(`${props.baseUrl}/workspace/memory-files`, {
        headers: buildAuthHeaders(props.token),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok || !mountedRef.current) {
        return;
      }
      const data = (await res.json()) as { agents: MemoryAgentEntry[] };
      if (!mountedRef.current) {
        return;
      }
      setAgents(data.agents);
      if (data.agents.length > 0) {
        const firstAgent = data.agents[0]!;
        setSelectedAgentId(firstAgent.agentId);
        if (firstAgent.files.length > 0) {
          setSelectedFilePath(firstAgent.files[0]!.path);
        }
      } else {
        setSelectedAgentId(null);
        setSelectedFilePath(null);
      }
    } catch {
      // Silent fetch failure.
    }
  }, [props.baseUrl, props.token, props.connected]);

  useEffect(() => {
    void fetchAgents();
  }, [fetchAgents]);

  const fetchFile = useCallback(
    async (filePath: string) => {
      setLoading(true);
      setEditing(false);
      setSaveMessage(null);
      try {
        const res = await fetch(
          `${props.baseUrl}/workspace/file?path=${encodeURIComponent(filePath)}`,
          {
            headers: buildAuthHeaders(props.token),
            signal: AbortSignal.timeout(8_000),
          }
        );
        if (!res.ok) {
          if (mountedRef.current) {
            setSelectedFile(null);
          }
          return;
        }
        const data = (await res.json()) as FileContent;
        if (mountedRef.current) {
          setSelectedFile(data);
        }
      } catch {
        if (mountedRef.current) {
          setSelectedFile(null);
        }
      } finally {
        if (mountedRef.current) {
          setLoading(false);
        }
      }
    },
    [props.baseUrl, props.token]
  );

  useEffect(() => {
    if (!selectedFilePath) {
      return;
    }
    void fetchFile(selectedFilePath);
  }, [selectedFilePath, fetchFile]);

  const selectedAgent = useMemo(
    () => agents.find((agent) => agent.agentId === selectedAgentId) ?? null,
    [agents, selectedAgentId]
  );

  const handleSave = useCallback(async () => {
    if (!selectedFile || !canWrite(selectedFile.path)) {
      return;
    }
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch(`${props.baseUrl}/workspace/memory-file`, {
        method: 'PUT',
        headers: buildAuthHeaders(props.token, true),
        body: JSON.stringify({ path: selectedFile.path, content: editContent }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        if (mountedRef.current) {
          setSaveMessage('Save failed');
        }
        return;
      }
      if (mountedRef.current) {
        setSelectedFile({ ...selectedFile, content: editContent, size: editContent.length });
        setEditing(false);
        setSaveMessage('Saved');
      }
    } catch {
      if (mountedRef.current) {
        setSaveMessage('Save failed');
      }
    } finally {
      if (mountedRef.current) {
        setSaving(false);
      }
    }
  }, [props.baseUrl, props.token, selectedFile, editContent]);

  if (!props.connected) {
    return (
      <section className="view-panel">
        <div className="view-header">
          <h2 className="view-title">Memory Browser</h2>
        </div>
        <div className="empty-state">Connect to a control plane to browse memory files.</div>
      </section>
    );
  }

  return (
    <section className="view-panel memory-view">
      <div className="view-header">
        <h2 className="view-title">Memory Browser</h2>
      </div>

      <div className="memory-layout">
        <div className="memory-agents-panel">
          <div className="memory-agents-title">Agents</div>
          <div className="memory-agents-list">
            {agents.length === 0 ? (
              <div className="memory-empty-hint">No memory files found</div>
            ) : (
              agents.map((agent) => (
                <button
                  key={`${agent.targetId}:${agent.agentId}`}
                  className={`memory-agent-item${selectedAgentId === agent.agentId ? ' active' : ''}`}
                  onClick={() => {
                    setSelectedAgentId(agent.agentId);
                    setSelectedFilePath(agent.files[0]?.path ?? null);
                  }}
                >
                  <div className="memory-agent-head">
                    <IconBot width={14} height={14} />
                    <span className="memory-agent-name">{agent.agentId}</span>
                  </div>
                  <div className="memory-agent-meta">
                    <span>{`${agent.targetLabel} · ${agent.targetType}`}</span>
                    <span>{`${agent.files.length.toString()} files`}</span>
                  </div>
                </button>
              ))
            )}
          </div>
        </div>

        <div className="memory-content-panel">
          {selectedAgent ? (
            <>
              <div className="memory-tabs">
                {selectedAgent.files.map((file) => (
                  <button
                    key={file.path}
                    className={`memory-tab${selectedFilePath === file.path ? ' active' : ''}`}
                    onClick={() => setSelectedFilePath(file.path)}
                  >
                    <IconNote width={12} height={12} />
                    <span>{file.name}</span>
                  </button>
                ))}
              </div>

              {loading ? (
                <div className="memory-loading">
                  <span className="mini-spinner" style={{ width: 18, height: 18 }} />
                  <span>Loading file...</span>
                </div>
              ) : selectedFile ? (
                <div className="memory-file-panel">
                  <div className="memory-file-header">
                    <div className="memory-file-meta">
                      <span className="memory-file-name">{selectedFile.name}</span>
                      <span className="memory-file-size">{formatBytes(selectedFile.size)}</span>
                      <span className="memory-file-updated">
                        {formatRelativeTime(selectedFile.modifiedAt)}
                      </span>
                    </div>
                    <div className="memory-file-actions">
                      {saveMessage ? (
                        <span
                          className="memory-save-message"
                          style={{ color: saveMessage === 'Saved' ? 'var(--green)' : 'var(--red)' }}
                        >
                          {saveMessage}
                        </span>
                      ) : null}
                      {editing ? (
                        <>
                          <button
                            className="btn-primary memory-action-btn"
                            onClick={() => void handleSave()}
                            disabled={saving || !canWrite(selectedFile.path)}
                          >
                            <IconSave width={14} height={14} />
                            {saving ? 'Saving...' : 'Save'}
                          </button>
                          <button
                            className="btn-ghost memory-action-btn"
                            onClick={() => setEditing(false)}
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <button
                          className="btn-secondary memory-action-btn"
                          onClick={() => {
                            setEditContent(selectedFile.content);
                            setEditing(true);
                          }}
                          disabled={!canWrite(selectedFile.path)}
                        >
                          <IconEdit width={14} height={14} />
                          Edit
                        </button>
                      )}
                    </div>
                  </div>
                  <div className="memory-file-body">
                    {editing ? (
                      <textarea
                        className="memory-editor"
                        value={editContent}
                        onChange={(e) => setEditContent(e.target.value)}
                        spellCheck={false}
                      />
                    ) : (
                      <pre className="memory-preview">
                        <code>{selectedFile.content}</code>
                      </pre>
                    )}
                  </div>
                  {!canWrite(selectedFile.path) ? (
                    <div className="memory-write-hint">
                      <IconBrain width={14} height={14} />
                      <span>This file is read-only in Memory Browser.</span>
                    </div>
                  ) : null}
                </div>
              ) : (
                <div className="memory-empty-hint">Select a memory file to view its contents</div>
              )}
            </>
          ) : (
            <div className="memory-empty-hint">No agents available</div>
          )}
        </div>
      </div>
    </section>
  );
}
