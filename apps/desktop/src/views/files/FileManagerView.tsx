import { useCallback, useEffect, useRef, useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';
import { IconFolder, IconRefresh, IconUpload } from '../../components/Icons';
import { ConnectionSelector } from './ConnectionSelector';
import { PathBreadcrumb } from './PathBreadcrumb';
import { FileGrid } from './FileGrid';
import { DropZone } from './DropZone';
import { TransferQueue } from './TransferQueue';
import { AddConnectionDialog } from './AddConnectionDialog';
import { RenameDialog } from './RenameDialog';
import { NewFolderDialog } from './NewFolderDialog';
import type { FileConnection, RemoteEntry, TransferItem } from './types';

export interface FileManagerViewProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly connected: boolean;
}

let transferIdCounter = 0;

function joinRemotePath(base: string, name: string): string {
  return base === '/' ? `/${name}` : `${base}/${name}`;
}

export function FileManagerView(props: FileManagerViewProps): JSX.Element {
  const { baseUrl, token, connected } = props;
  const [connections, setConnections] = useState<FileConnection[]>([]);
  const [selectedConn, setSelectedConn] = useState<string | null>(null);
  const [currentPath, setCurrentPath] = useState('/');
  const [entries, setEntries] = useState<RemoteEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [transfers, setTransfers] = useState<TransferItem[]>([]);
  const [showAddConn, setShowAddConn] = useState(false);
  const [renameEntry, setRenameEntry] = useState<RemoteEntry | null>(null);
  const [showNewFolder, setShowNewFolder] = useState(false);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<RemoteEntry | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const headers = useCallback(
    () => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }),
    [token]
  );

  const fetchConnections = useCallback(async () => {
    try {
      const res = await fetch(`${baseUrl}/files/connections`, { headers: headers() });
      if (!res.ok) return;
      const data = (await res.json()) as FileConnection[] | undefined;
      setConnections(Array.isArray(data) ? data : []);
    } catch {
      /* ignore */
    }
  }, [baseUrl, headers]);

  const fetchEntries = useCallback(
    async (connId: string, dirPath: string) => {
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(
          `${baseUrl}/files/${encodeURIComponent(connId)}/ls?path=${encodeURIComponent(dirPath)}`,
          { headers: headers(), signal: ctrl.signal }
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as { path?: string; entries?: RemoteEntry[] };
        if (!ctrl.signal.aborted) {
          setEntries(data.entries ?? []);
          setCurrentPath(data.path ?? dirPath);
        }
      } catch (err: unknown) {
        if (err instanceof DOMException && err.name === 'AbortError') return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        if (message.toLowerCase().includes('not connected')) {
          void fetchConnections();
        }
        setEntries([]);
      } finally {
        if (!ctrl.signal.aborted) setLoading(false);
      }
    },
    [baseUrl, fetchConnections, headers]
  );

  useEffect(() => {
    if (connected) void fetchConnections();
  }, [connected, fetchConnections]);

  useEffect(() => {
    if (!selectedConn) return;
    const exists = connections.some((conn) => conn.id === selectedConn);
    if (exists) return;
    setSelectedConn(connections[0]?.id ?? null);
    setEntries([]);
    setError('Connection was reset. Please reselect or reconnect VPS bridge.');
  }, [connections, selectedConn]);

  useEffect(() => {
    if (selectedConn) void fetchEntries(selectedConn, '/');
  }, [selectedConn, fetchEntries]);

  const navigateTo = useCallback(
    (pathOrName: string) => {
      if (!selectedConn) return;
      let targetPath: string;
      if (pathOrName.startsWith('/')) {
        targetPath = pathOrName;
      } else {
        targetPath = currentPath === '/' ? `/${pathOrName}` : `${currentPath}/${pathOrName}`;
      }
      setCurrentPath(targetPath);
      void fetchEntries(selectedConn, targetPath);
    },
    [selectedConn, currentPath, fetchEntries]
  );

  const goUp = useCallback(() => {
    if (currentPath === '/') return;
    const parts = currentPath.split('/').filter(Boolean);
    parts.pop();
    const parentPath = parts.length === 0 ? '/' : '/' + parts.join('/');
    navigateTo(parentPath);
  }, [currentPath, navigateTo]);

  const refresh = useCallback(() => {
    if (selectedConn) void fetchEntries(selectedConn, currentPath);
  }, [selectedConn, currentPath, fetchEntries]);

  const handleDownload = useCallback(
    async (entry: RemoteEntry) => {
      if (!selectedConn) return;
      const filePath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
      const downloadUrl = `${baseUrl}/files/${encodeURIComponent(selectedConn)}/download?path=${encodeURIComponent(filePath)}`;

      const transferId = `dl-${++transferIdCounter}`;
      const item: TransferItem = {
        id: transferId,
        name: entry.name,
        direction: 'download',
        size: entry.size,
        progress: 0,
        status: 'active',
      };
      setTransfers((t) => [item, ...t]);

      try {
        if (token.trim().length === 0) {
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.download = entry.name;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTransfers((t) =>
            t.map((x) => (x.id === transferId ? { ...x, status: 'done', progress: 1 } : x))
          );
          return;
        }

        const res = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }

        const contentLength = Number(res.headers.get('Content-Length') ?? 0);
        const reader = res.body?.getReader();
        if (!reader) throw new Error('No response body');

        const chunks: BlobPart[] = [];
        let received = 0;

        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value as unknown as BlobPart);
          received += value.byteLength;
          const progress = contentLength > 0 ? received / contentLength : 0;
          setTransfers((t) => t.map((x) => (x.id === transferId ? { ...x, progress } : x)));
        }

        const blob = new Blob(chunks);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = entry.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        setTransfers((t) =>
          t.map((x) => (x.id === transferId ? { ...x, status: 'done', progress: 1 } : x))
        );
      } catch (err: unknown) {
        setTransfers((t) =>
          t.map((x) =>
            x.id === transferId
              ? { ...x, status: 'error', error: err instanceof Error ? err.message : String(err) }
              : x
          )
        );
      }
    },
    [selectedConn, currentPath, baseUrl, token]
  );

  const handleDownloadFolder = useCallback(
    async (entry: RemoteEntry) => {
      if (!selectedConn) return;
      const rootPath = joinRemotePath(currentPath, entry.name);
      const downloadUrl = `${baseUrl}/files/${encodeURIComponent(selectedConn)}/download-folder?path=${encodeURIComponent(rootPath)}`;
      const transferId = `dl-folder-${++transferIdCounter}`;
      setTransfers((t) => [
        {
          id: transferId,
          name: `${entry.name}.zip`,
          direction: 'download',
          size: 0,
          progress: 0,
          status: 'active',
        },
        ...t,
      ]);

      try {
        if (token.trim().length === 0) {
          const a = document.createElement('a');
          a.href = downloadUrl;
          a.download = `${entry.name}.zip`;
          document.body.appendChild(a);
          a.click();
          a.remove();
          setTransfers((t) =>
            t.map((x) => (x.id === transferId ? { ...x, status: 'done', progress: 1 } : x))
          );
          return;
        }

        const res = await fetch(downloadUrl, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as { error?: string } | null;
          throw new Error(body?.error ?? `HTTP ${res.status}`);
        }
        const contentLength = Number(res.headers.get('Content-Length') ?? 0);
        const reader = res.body?.getReader();
        if (!reader) {
          throw new Error('No response body');
        }
        const chunks: BlobPart[] = [];
        let received = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          chunks.push(value as unknown as BlobPart);
          received += value.byteLength;
          const progress = contentLength > 0 ? received / contentLength : 0;
          setTransfers((t) =>
            t.map((x) => (x.id === transferId ? { ...x, progress: Math.min(0.95, progress) } : x))
          );
        }
        const zipBlob = new Blob(chunks, { type: 'application/zip' });

        const url = URL.createObjectURL(zipBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${entry.name}.zip`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);

        setTransfers((t) =>
          t.map((x) => (x.id === transferId ? { ...x, status: 'done', progress: 1 } : x))
        );
      } catch (err: unknown) {
        setTransfers((t) =>
          t.map((x) =>
            x.id === transferId
              ? { ...x, status: 'error', error: err instanceof Error ? err.message : String(err) }
              : x
          )
        );
      }
    },
    [selectedConn, currentPath, baseUrl, token]
  );

  const uploadFiles = useCallback(
    async (files: File[]) => {
      if (!selectedConn) return;

      for (const file of files) {
        const transferId = `ul-${++transferIdCounter}`;
        const item: TransferItem = {
          id: transferId,
          name: file.name,
          direction: 'upload',
          size: file.size,
          progress: 0,
          status: 'active',
        };
        setTransfers((t) => [item, ...t]);

        try {
          await new Promise<void>((resolve, reject) => {
            const xhr = new XMLHttpRequest();
            xhr.open('POST', `${baseUrl}/files/${encodeURIComponent(selectedConn)}/upload`);
            xhr.setRequestHeader('Authorization', `Bearer ${token}`);

            xhr.upload.onprogress = (e) => {
              if (e.lengthComputable) {
                const progress = e.loaded / e.total;
                setTransfers((t) => t.map((x) => (x.id === transferId ? { ...x, progress } : x)));
              }
            };

            xhr.onload = () => {
              if (xhr.status >= 200 && xhr.status < 300) {
                setTransfers((t) =>
                  t.map((x) => (x.id === transferId ? { ...x, status: 'done', progress: 1 } : x))
                );
                resolve();
              } else {
                reject(new Error(`HTTP ${xhr.status}`));
              }
            };

            xhr.onerror = () => reject(new Error('Network error'));

            const formData = new FormData();
            formData.append('remotePath', currentPath);
            formData.append('file', file);
            xhr.send(formData);
          });
        } catch (err: unknown) {
          setTransfers((t) =>
            t.map((x) =>
              x.id === transferId
                ? {
                    ...x,
                    status: 'error',
                    error: err instanceof Error ? err.message : String(err),
                  }
                : x
            )
          );
        }
      }
      refresh();
    },
    [selectedConn, currentPath, baseUrl, token, refresh]
  );

  const handleCopyContent = useCallback(
    async (entry: RemoteEntry) => {
      if (!selectedConn) return;
      const filePath = currentPath === '/' ? `/${entry.name}` : `${currentPath}/${entry.name}`;
      setCopyNotice(null);
      try {
        const res = await fetch(
          `${baseUrl}/files/${encodeURIComponent(selectedConn)}/download?path=${encodeURIComponent(filePath)}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const contentType = (res.headers.get('Content-Type') ?? '').toLowerCase();
        const isLikelyText =
          contentType.startsWith('text/') ||
          contentType.includes('json') ||
          contentType.includes('xml') ||
          contentType.includes('javascript') ||
          contentType.includes('x-sh') ||
          contentType.includes('x-yaml') ||
          contentType.includes('x-toml');
        if (!isLikelyText) {
          throw new Error('This file looks binary. Copy content supports text files only.');
        }
        const text = await res.text();
        if (!navigator.clipboard?.writeText) {
          throw new Error('Clipboard API is not available in this environment.');
        }
        await navigator.clipboard.writeText(text);
        setCopyNotice(`Copied content: ${entry.name}`);
      } catch (err: unknown) {
        setCopyNotice(`Copy failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    },
    [selectedConn, currentPath, baseUrl, token]
  );

  const handleRename = useCallback(
    async (newName: string) => {
      if (!selectedConn || !renameEntry) return;
      const oldPath =
        currentPath === '/' ? `/${renameEntry.name}` : `${currentPath}/${renameEntry.name}`;
      const newPath = currentPath === '/' ? `/${newName}` : `${currentPath}/${newName}`;
      try {
        await fetch(`${baseUrl}/files/${encodeURIComponent(selectedConn)}/rename`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ oldPath, newPath }),
        });
        setRenameEntry(null);
        refresh();
      } catch {
        /* ignore */
      }
    },
    [selectedConn, renameEntry, currentPath, baseUrl, headers, refresh]
  );

  const handleDelete = useCallback((entry: RemoteEntry) => {
    setDeleteTarget(entry);
  }, []);

  const doDelete = useCallback(async () => {
    if (!deleteTarget || !selectedConn) return;
    const entryPath =
      currentPath === '/' ? `/${deleteTarget.name}` : `${currentPath}/${deleteTarget.name}`;
    setDeleteTarget(null);
    try {
      await fetch(
        `${baseUrl}/files/${encodeURIComponent(selectedConn)}/rm?path=${encodeURIComponent(entryPath)}&recursive=true`,
        { method: 'DELETE', headers: headers() }
      );
      refresh();
    } catch {
      /* ignore */
    }
  }, [deleteTarget, selectedConn, currentPath, baseUrl, headers, refresh]);

  const handleNewFolder = useCallback(
    async (name: string) => {
      if (!selectedConn) return;
      const folderPath = currentPath === '/' ? `/${name}` : `${currentPath}/${name}`;
      try {
        await fetch(`${baseUrl}/files/${encodeURIComponent(selectedConn)}/mkdir`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify({ path: folderPath }),
        });
        setShowNewFolder(false);
        refresh();
      } catch {
        /* ignore */
      }
    },
    [selectedConn, currentPath, baseUrl, headers, refresh]
  );

  const handleAddConnection = useCallback(
    async (conn: { label: string; host: string; port: number; user: string; keyPath: string }) => {
      try {
        await fetch(`${baseUrl}/files/connections`, {
          method: 'POST',
          headers: headers(),
          body: JSON.stringify(conn),
        });
        setShowAddConn(false);
        void fetchConnections();
      } catch {
        /* ignore */
      }
    },
    [baseUrl, headers, fetchConnections]
  );

  const clearCompleted = useCallback(() => {
    setTransfers((t) => t.filter((x) => x.status === 'active' || x.status === 'pending'));
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'Backspace') {
        e.preventDefault();
        goUp();
      } else if (e.key === 'F5') {
        e.preventDefault();
        refresh();
      } else if (e.key === 'F2' && renameEntry) {
        e.preventDefault();
      } else if (e.key === 'Delete') {
        // handled by grid selection in future
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [goUp, refresh, renameEntry]);

  if (!connected) {
    return (
      <section className="view-panel">
        <div className="view-header">
          <h2>File Manager</h2>
        </div>
        <p className="fm-disconnected">Connect to a server to browse files.</p>
      </section>
    );
  }

  return (
    <section className="view-panel fm-view">
      <div className="view-header">
        <h2>File Manager</h2>
        <div className="fm-toolbar">
          <ConnectionSelector
            connections={connections}
            selected={selectedConn}
            onSelect={(id) => {
              setSelectedConn(id);
              setCurrentPath('/');
            }}
            onAddConnection={() => setShowAddConn(true)}
          />
          {selectedConn && (
            <>
              <button
                className="fm-btn fm-btn-icon"
                onClick={() => fileInputRef.current?.click()}
                title="Upload files"
              >
                <IconUpload />
              </button>
              <button
                className="fm-btn fm-btn-icon"
                onClick={() => setShowNewFolder(true)}
                title="New folder"
              >
                <IconFolder />
              </button>
              <button className="fm-btn fm-btn-icon" onClick={refresh} title="Refresh (F5)">
                <IconRefresh />
              </button>
            </>
          )}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="fm-hidden-input"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? []);
              if (files.length > 0) void uploadFiles(files);
              e.target.value = '';
            }}
          />
        </div>
      </div>

      {selectedConn && <PathBreadcrumb path={currentPath} onNavigate={navigateTo} />}

      {error && <div className="fm-error">{error}</div>}
      {copyNotice && <div className="fm-copy-notice">{copyNotice}</div>}

      {selectedConn ? (
        <DropZone onDrop={(files) => void uploadFiles(files)}>
          <FileGrid
            entries={entries}
            loading={loading}
            onNavigate={navigateTo}
            onDownload={(e) => void handleDownload(e)}
            onDownloadFolder={(e) => void handleDownloadFolder(e)}
            onCopyContent={(e) => void handleCopyContent(e)}
            onRename={(e) => setRenameEntry(e)}
            onDelete={(e) => void handleDelete(e)}
            onContextMenu={() => {}}
          />
        </DropZone>
      ) : (
        <div className="fm-no-conn">
          <p>Select a connection to browse files on your VPS</p>
        </div>
      )}

      <TransferQueue items={transfers} onClear={clearCompleted} />

      <AddConnectionDialog
        open={showAddConn}
        onClose={() => setShowAddConn(false)}
        onAdd={(c) => void handleAddConnection(c)}
      />
      <RenameDialog
        open={renameEntry !== null}
        currentName={renameEntry?.name ?? ''}
        onClose={() => setRenameEntry(null)}
        onRename={(n) => void handleRename(n)}
      />
      <NewFolderDialog
        open={showNewFolder}
        onClose={() => setShowNewFolder(false)}
        onCreate={(n) => void handleNewFolder(n)}
      />

      {deleteTarget ? (
        <ConfirmDialog
          title="Delete File"
          message={`Delete "${deleteTarget.name}"? This cannot be undone.`}
          variant="danger"
          confirmLabel="Delete"
          onConfirm={() => void doDelete()}
          onCancel={() => setDeleteTarget(null)}
        />
      ) : null}
    </section>
  );
}
