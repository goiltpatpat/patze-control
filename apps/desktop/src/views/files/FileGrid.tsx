import { useCallback, useMemo, useRef, useState } from 'react';
import {
  IconFolder,
  IconFile,
  IconDownload,
  IconClipboard,
  IconEdit,
  IconTrash,
} from '../../components/Icons';
import type { RemoteEntry, SortDir, SortKey } from './types';

export interface FileGridProps {
  readonly entries: readonly RemoteEntry[];
  readonly loading: boolean;
  readonly onNavigate: (name: string) => void;
  readonly onDownload: (entry: RemoteEntry) => void;
  readonly onDownloadFolder: (entry: RemoteEntry) => void;
  readonly onCopyContent: (entry: RemoteEntry) => void;
  readonly onRename: (entry: RemoteEntry) => void;
  readonly onDelete: (entry: RemoteEntry) => void;
  readonly onContextMenu: (entry: RemoteEntry, x: number, y: number) => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function FileGrid(props: FileGridProps): JSX.Element {
  const {
    entries,
    loading,
    onNavigate,
    onDownload,
    onDownloadFolder,
    onCopyContent,
    onRename,
    onDelete,
    onContextMenu,
  } = props;
  const [sortKey, setSortKey] = useState<SortKey>('name');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [contextEntry, setContextEntry] = useState<RemoteEntry | null>(null);
  const [contextPos, setContextPos] = useState<{ x: number; y: number } | null>(null);
  const contextRef = useRef<HTMLDivElement>(null);

  const handleSort = useCallback(
    (key: SortKey) => {
      if (sortKey === key) {
        setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortKey(key);
        setSortDir('asc');
      }
    },
    [sortKey]
  );

  const sorted = useMemo(() => {
    const arr = [...entries];
    arr.sort((a, b) => {
      if (a.type === 'directory' && b.type !== 'directory') return -1;
      if (a.type !== 'directory' && b.type === 'directory') return 1;

      let cmp = 0;
      switch (sortKey) {
        case 'name':
          cmp = a.name.localeCompare(b.name);
          break;
        case 'size':
          cmp = a.size - b.size;
          break;
        case 'mtime':
          cmp = a.mtime - b.mtime;
          break;
      }
      return sortDir === 'asc' ? cmp : -cmp;
    });
    return arr;
  }, [entries, sortKey, sortDir]);

  const handleRowDoubleClick = useCallback(
    (entry: RemoteEntry) => {
      if (entry.type === 'directory') {
        onNavigate(entry.name);
      }
    },
    [onNavigate]
  );

  const handleRowContext = useCallback(
    (e: React.MouseEvent, entry: RemoteEntry) => {
      e.preventDefault();
      setContextEntry(entry);
      setContextPos({ x: e.clientX, y: e.clientY });
      onContextMenu(entry, e.clientX, e.clientY);
    },
    [onContextMenu]
  );

  const closeContext = useCallback(() => {
    setContextEntry(null);
    setContextPos(null);
  }, []);

  const sortIndicator = (key: SortKey) => {
    if (sortKey !== key) return '';
    return sortDir === 'asc' ? ' ↑' : ' ↓';
  };

  if (loading) {
    return (
      <div className="fm-grid-loading">
        <div className="fm-spinner" />
        Loading...
      </div>
    );
  }

  if (entries.length === 0) {
    return <div className="fm-grid-empty">Empty directory</div>;
  }

  return (
    <>
      <div className="fm-grid">
        <div className="fm-grid-header">
          <button className="fm-grid-col fm-col-name" onClick={() => handleSort('name')}>
            Name{sortIndicator('name')}
          </button>
          <button className="fm-grid-col fm-col-size" onClick={() => handleSort('size')}>
            Size{sortIndicator('size')}
          </button>
          <button className="fm-grid-col fm-col-date" onClick={() => handleSort('mtime')}>
            Modified{sortIndicator('mtime')}
          </button>
          <span className="fm-grid-col fm-col-perm">Perms</span>
          <span className="fm-grid-col fm-col-actions">Actions</span>
        </div>
        <div className="fm-grid-body">
          {sorted.map((entry) => (
            <div
              key={entry.name}
              className={`fm-grid-row${entry.type === 'directory' ? ' fm-row-dir' : ''}`}
              onDoubleClick={() => handleRowDoubleClick(entry)}
              onContextMenu={(e) => handleRowContext(e, entry)}
            >
              <span className="fm-grid-col fm-col-name">
                {entry.type === 'directory' ? (
                  <IconFolder className="fm-entry-icon fm-icon-dir" />
                ) : (
                  <IconFile className="fm-entry-icon fm-icon-file" />
                )}
                <span className="fm-entry-name">{entry.name}</span>
              </span>
              <span className="fm-grid-col fm-col-size">
                {entry.type === 'directory' ? '—' : formatSize(entry.size)}
              </span>
              <span className="fm-grid-col fm-col-date">{formatDate(entry.mtime)}</span>
              <span className="fm-grid-col fm-col-perm">{entry.permissions}</span>
              <span className="fm-grid-col fm-col-actions">
                {entry.type === 'directory' && (
                  <button
                    className="fm-action-btn"
                    title="Download folder (.zip)"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDownloadFolder(entry);
                    }}
                  >
                    <IconDownload />
                  </button>
                )}
                {entry.type === 'file' && (
                  <button
                    className="fm-action-btn"
                    title="Download"
                    onClick={(e) => {
                      e.stopPropagation();
                      onDownload(entry);
                    }}
                  >
                    <IconDownload />
                  </button>
                )}
                {entry.type === 'file' && (
                  <button
                    className="fm-action-btn"
                    title="Copy content"
                    onClick={(e) => {
                      e.stopPropagation();
                      onCopyContent(entry);
                    }}
                  >
                    <IconClipboard />
                  </button>
                )}
                <button
                  className="fm-action-btn"
                  title="Rename"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRename(entry);
                  }}
                >
                  <IconEdit />
                </button>
                <button
                  className="fm-action-btn fm-action-danger"
                  title="Delete"
                  onClick={(e) => {
                    e.stopPropagation();
                    onDelete(entry);
                  }}
                >
                  <IconTrash />
                </button>
              </span>
            </div>
          ))}
        </div>
      </div>
      {contextEntry && contextPos && (
        <>
          <div className="fm-context-backdrop" onClick={closeContext} />
          <div
            ref={contextRef}
            className="fm-context-menu"
            style={{ left: contextPos.x, top: contextPos.y }}
          >
            {contextEntry.type === 'directory' && (
              <button
                className="fm-context-item"
                onClick={() => {
                  onDownloadFolder(contextEntry);
                  closeContext();
                }}
              >
                <IconDownload /> Download Folder (.zip)
              </button>
            )}
            {contextEntry.type === 'file' && (
              <button
                className="fm-context-item"
                onClick={() => {
                  onDownload(contextEntry);
                  closeContext();
                }}
              >
                <IconDownload /> Download
              </button>
            )}
            {contextEntry.type === 'file' && (
              <button
                className="fm-context-item"
                onClick={() => {
                  onCopyContent(contextEntry);
                  closeContext();
                }}
              >
                <IconClipboard /> Copy Content
              </button>
            )}
            <button
              className="fm-context-item"
              onClick={() => {
                onRename(contextEntry);
                closeContext();
              }}
            >
              <IconEdit /> Rename
            </button>
            <button
              className="fm-context-item fm-context-danger"
              onClick={() => {
                onDelete(contextEntry);
                closeContext();
              }}
            >
              <IconTrash /> Delete
            </button>
          </div>
        </>
      )}
    </>
  );
}
