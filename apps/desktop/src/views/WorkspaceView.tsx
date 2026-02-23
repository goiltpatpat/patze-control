import { useCallback, useEffect, useRef, useState } from 'react';
import {
  IconBot,
  IconChevronDown,
  IconChevronRight,
  IconEdit,
  IconFile,
  IconFolder,
  IconFolderOpen,
  IconNote,
  IconSave,
  IconSearch,
  IconServer,
  IconX,
} from '../components/Icons';

export interface WorkspaceViewProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly connected: boolean;
  readonly initialFilePath?: string;
  readonly initialLine?: string;
}

interface WorkspaceRoot {
  path: string;
  label: string;
  type?: 'openclaw' | 'config';
  targetId?: string;
  targetType?: string;
}

const OPENCLAW_SPECIAL_FILES: ReadonlySet<string> = new Set([
  'MEMORY.md',
  'SOUL.md',
  'TASKS.md',
  'CHANGELOG.md',
  'CONTEXT.md',
  'README.md',
  'openclaw.json',
]);

function isOpenClawSpecial(name: string): boolean {
  return OPENCLAW_SPECIAL_FILES.has(name);
}

interface WorkspaceEntry {
  name: string;
  path: string;
  type: 'file' | 'directory';
  size?: number;
  modifiedAt?: string;
}

interface FileContent {
  path: string;
  name: string;
  extension: string;
  size: number;
  modifiedAt: string;
  content: string;
}

interface TreeNode {
  entry: WorkspaceEntry;
  children: TreeNode[] | null;
  expanded: boolean;
  loading: boolean;
}

function buildAuthHeaders(token: string, json?: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token.length > 0) headers['Authorization'] = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function getLanguageClass(ext: string): string {
  const map: Record<string, string> = {
    ts: 'lang-typescript',
    tsx: 'lang-typescript',
    js: 'lang-javascript',
    jsx: 'lang-javascript',
    json: 'lang-json',
    md: 'lang-markdown',
    css: 'lang-css',
    html: 'lang-html',
    sh: 'lang-shell',
    bash: 'lang-shell',
    yml: 'lang-yaml',
    yaml: 'lang-yaml',
    toml: 'lang-toml',
    rs: 'lang-rust',
    py: 'lang-python',
  };
  return map[ext] ?? 'lang-plain';
}

function relativePath(fullPath: string, roots: readonly WorkspaceRoot[]): string {
  for (const root of roots) {
    if (fullPath.startsWith(root.path)) {
      return `${root.label}${fullPath.slice(root.path.length)}`;
    }
  }
  return fullPath;
}

function TreeEntry(props: {
  node: TreeNode;
  depth: number;
  onToggle: (path: string) => void;
  onSelect: (path: string) => void;
  selectedPath: string | null;
}): JSX.Element {
  const { node, depth, onToggle, onSelect, selectedPath } = props;
  const isDir = node.entry.type === 'directory';
  const isSelected = selectedPath === node.entry.path;

  return (
    <>
      <button
        className={`ws-tree-item${isSelected ? ' ws-tree-selected' : ''}`}
        style={{ paddingLeft: 12 + depth * 16 }}
        onClick={() => {
          if (isDir) onToggle(node.entry.path);
          else onSelect(node.entry.path);
        }}
      >
        <span className="ws-tree-icon">
          {isDir ? (
            node.expanded ? (
              <IconChevronDown width={14} height={14} />
            ) : (
              <IconChevronRight width={14} height={14} />
            )
          ) : null}
        </span>
        <span className="ws-tree-type-icon">
          {isDir ? (
            node.expanded ? (
              <IconFolderOpen width={15} height={15} />
            ) : (
              <IconFolder width={15} height={15} />
            )
          ) : isOpenClawSpecial(node.entry.name) ? (
            <IconNote width={15} height={15} className="ws-special-icon" />
          ) : (
            <IconFile width={15} height={15} />
          )}
        </span>
        <span
          className={`ws-tree-name${isOpenClawSpecial(node.entry.name) ? ' ws-tree-special' : ''}`}
        >
          {node.entry.name}
        </span>
        {node.loading ? <span className="mini-spinner ws-tree-spinner" /> : null}
      </button>
      {isDir && node.expanded && node.children
        ? node.children.map((child) => (
            <TreeEntry
              key={child.entry.path}
              node={child}
              depth={depth + 1}
              onToggle={onToggle}
              onSelect={onSelect}
              selectedPath={selectedPath}
            />
          ))
        : null}
    </>
  );
}

export function WorkspaceView(props: WorkspaceViewProps): JSX.Element {
  const { baseUrl, token, connected, initialFilePath } = props;
  const [roots, setRoots] = useState<WorkspaceRoot[]>([]);
  const [trees, setTrees] = useState<Map<string, TreeNode[]>>(new Map());
  const [selectedFile, setSelectedFile] = useState<FileContent | null>(null);
  const [fileLoading, setFileLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const mountedRef = useRef(true);
  const handledInitialFileRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const fetchRoots = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/workspace/roots`, {
        headers: buildAuthHeaders(token),
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok || !mountedRef.current) return;
      const data = (await res.json()) as { roots?: WorkspaceRoot[] };
      if (mountedRef.current) setRoots(data.roots ?? []);
    } catch {
      /* silent */
    }
  }, [baseUrl, token]);

  const fetchTree = useCallback(
    async (dirPath: string): Promise<TreeNode[]> => {
      try {
        const res = await fetch(`${baseUrl}/workspace/tree?path=${encodeURIComponent(dirPath)}`, {
          headers: buildAuthHeaders(token),
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) return [];
        const data = (await res.json()) as { entries?: WorkspaceEntry[] };
        return (data.entries ?? []).map((entry) => ({
          entry,
          children: null,
          expanded: false,
          loading: false,
        }));
      } catch {
        return [];
      }
    },
    [baseUrl, token]
  );

  useEffect(() => {
    if (!connected) return;
    void fetchRoots();
  }, [connected, fetchRoots]);

  useEffect(() => {
    if (roots.length === 0) return;
    void (async () => {
      const newTrees = new Map<string, TreeNode[]>();
      for (const root of roots) {
        newTrees.set(root.path, await fetchTree(root.path));
      }
      if (mountedRef.current) setTrees(newTrees);
    })();
  }, [roots, fetchTree]);

  const handleToggle = useCallback(
    async (dirPath: string) => {
      setTrees((prev) => {
        const updated = new Map(prev);
        const toggle = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map((n) => {
            if (n.entry.path === dirPath) {
              return { ...n, expanded: !n.expanded, loading: !n.expanded && !n.children };
            }
            if (n.children) return { ...n, children: toggle(n.children) };
            return n;
          });
        for (const [rp, rn] of updated) updated.set(rp, toggle(rn));
        return updated;
      });

      const children = await fetchTree(dirPath);
      setTrees((prev) => {
        const updated = new Map(prev);
        const apply = (nodes: TreeNode[]): TreeNode[] =>
          nodes.map((n) => {
            if (n.entry.path === dirPath) return { ...n, children, expanded: true, loading: false };
            if (n.children) return { ...n, children: apply(n.children) };
            return n;
          });
        for (const [rp, rn] of updated) updated.set(rp, apply(rn));
        return updated;
      });
    },
    [fetchTree]
  );

  const handleSelectFile = useCallback(
    async (filePath: string) => {
      setFileLoading(true);
      setEditing(false);
      setSaveMessage(null);
      try {
        const res = await fetch(`${baseUrl}/workspace/file?path=${encodeURIComponent(filePath)}`, {
          headers: buildAuthHeaders(token),
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) {
          if (mountedRef.current) setSelectedFile(null);
          return;
        }
        const data = (await res.json()) as FileContent;
        if (mountedRef.current) setSelectedFile(data);
      } catch {
        if (mountedRef.current) setSelectedFile(null);
      } finally {
        if (mountedRef.current) setFileLoading(false);
      }
    },
    [baseUrl, token]
  );

  useEffect(() => {
    if (!connected || !initialFilePath) {
      return;
    }
    if (handledInitialFileRef.current === initialFilePath) {
      return;
    }
    handledInitialFileRef.current = initialFilePath;
    void handleSelectFile(initialFilePath);
  }, [connected, initialFilePath, handleSelectFile]);

  const handleSave = useCallback(async () => {
    if (!selectedFile) return;
    setSaving(true);
    setSaveMessage(null);
    try {
      const res = await fetch(`${baseUrl}/workspace/file`, {
        method: 'PUT',
        headers: buildAuthHeaders(token, true),
        body: JSON.stringify({ path: selectedFile.path, content: editContent }),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok && mountedRef.current) {
        setSelectedFile({ ...selectedFile, content: editContent, size: editContent.length });
        setEditing(false);
        setSaveMessage('Saved');
        setTimeout(() => {
          if (mountedRef.current) setSaveMessage(null);
        }, 2000);
      }
    } catch {
      if (mountedRef.current) setSaveMessage('Save failed');
    } finally {
      if (mountedRef.current) setSaving(false);
    }
  }, [baseUrl, token, selectedFile, editContent]);

  const renderTree = (nodes: TreeNode[], depth: number): JSX.Element[] =>
    nodes
      .filter(
        (n) =>
          search.length === 0 ||
          n.entry.name.toLowerCase().includes(search.toLowerCase()) ||
          n.entry.type === 'directory'
      )
      .map((node) => (
        <TreeEntry
          key={node.entry.path}
          node={node}
          depth={depth}
          onToggle={(p) => void handleToggle(p)}
          onSelect={(p) => void handleSelectFile(p)}
          selectedPath={selectedFile?.path ?? null}
        />
      ));

  if (!connected) {
    return (
      <section className="view-panel">
        <div className="view-header">
          <h2 className="view-title">Workspace</h2>
        </div>
        <div className="empty-state">Connect to a control plane to browse workspace files.</div>
      </section>
    );
  }

  const host = (() => {
    try {
      const url = new URL(baseUrl);
      return url.hostname === '127.0.0.1' || url.hostname === 'localhost'
        ? 'localhost'
        : url.hostname;
    } catch {
      return baseUrl;
    }
  })();

  return (
    <section className="view-panel ws-view">
      <div className="view-header">
        <h2 className="view-title">Workspace</h2>
        <div className="ws-server-info">
          <IconServer width={13} height={13} />
          <span className="ws-server-host">{host}</span>
        </div>
      </div>
      <div className="ws-layout">
        <div className="ws-sidebar">
          <div className="ws-search-bar">
            <IconSearch width={14} height={14} className="ws-search-icon" />
            <input
              type="text"
              placeholder="Filter files..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="ws-search-input"
            />
            {search.length > 0 ? (
              <button className="ws-search-clear" onClick={() => setSearch('')}>
                <IconX width={12} height={12} />
              </button>
            ) : null}
          </div>
          <div className="ws-tree">
            {roots.map((root) => (
              <div key={root.path} className="ws-tree-root">
                <div className="ws-tree-root-label">
                  {root.type === 'openclaw' ? (
                    <IconBot width={12} height={12} className="ws-root-icon" />
                  ) : (
                    <IconServer width={12} height={12} className="ws-root-icon" />
                  )}
                  <span>{root.label}</span>
                  {root.targetType === 'remote' ? (
                    <span className="ws-root-badge ws-root-remote">remote</span>
                  ) : null}
                  {root.type === 'openclaw' ? (
                    <span className="ws-root-badge ws-root-oc">OC</span>
                  ) : null}
                </div>
                {root.targetType === 'remote' ? (
                  <div className="ws-remote-hint">Remote files require bridge extension</div>
                ) : (
                  renderTree(trees.get(root.path) ?? [], 0)
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="ws-content">
          {fileLoading ? (
            <div className="ws-content-loading">
              <span className="mini-spinner" style={{ width: 18, height: 18 }} />
              <span>Loading file...</span>
            </div>
          ) : selectedFile ? (
            <div className="ws-file-panel">
              <div className="ws-file-header">
                <div className="ws-file-meta">
                  <span className="ws-file-name">{selectedFile.name}</span>
                  <span className="ws-file-path">{relativePath(selectedFile.path, roots)}</span>
                  <span className="ws-file-size">{formatBytes(selectedFile.size)}</span>
                </div>
                <div className="ws-file-actions">
                  {saveMessage ? (
                    <span
                      className="ws-save-msg"
                      style={{ color: saveMessage === 'Saved' ? 'var(--green)' : 'var(--red)' }}
                    >
                      {saveMessage}
                    </span>
                  ) : null}
                  {editing ? (
                    <>
                      <button
                        className="btn-primary ws-action-btn"
                        onClick={() => void handleSave()}
                        disabled={saving}
                      >
                        <IconSave width={14} height={14} />
                        {saving ? 'Saving...' : 'Save'}
                      </button>
                      <button className="btn-ghost ws-action-btn" onClick={() => setEditing(false)}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <button
                      className="btn-secondary ws-action-btn"
                      onClick={() => {
                        setEditContent(selectedFile.content);
                        setEditing(true);
                      }}
                    >
                      <IconEdit width={14} height={14} />
                      Edit
                    </button>
                  )}
                </div>
              </div>
              <div className="ws-file-body">
                {editing ? (
                  <textarea
                    className="ws-editor"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    spellCheck={false}
                  />
                ) : (
                  <pre className={`ws-code ${getLanguageClass(selectedFile.extension)}`}>
                    <code>
                      {selectedFile.content.split('\n').map((line, i) => (
                        <span key={i} className="ws-code-line">
                          <span className="ws-line-number">{i + 1}</span>
                          <span className="ws-line-content">{line}</span>
                          {'\n'}
                        </span>
                      ))}
                    </code>
                  </pre>
                )}
              </div>
            </div>
          ) : (
            <div className="ws-content-empty">
              <IconFolder width={32} height={32} style={{ opacity: 0.3 }} />
              <span>Select a file from the tree to view its contents</span>
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
