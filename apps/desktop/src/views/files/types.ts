export interface FileConnection {
  readonly id: string;
  readonly label: string;
  readonly type: 'bridge' | 'custom';
  readonly host: string;
  readonly user: string;
  readonly status: 'connected' | 'available' | 'error';
}

export interface RemoteEntry {
  readonly name: string;
  readonly type: 'file' | 'directory' | 'symlink';
  readonly size: number;
  readonly mtime: number;
  readonly permissions: string;
}

export interface TransferItem {
  readonly id: string;
  readonly name: string;
  readonly direction: 'upload' | 'download';
  readonly size: number;
  progress: number;
  status: 'pending' | 'active' | 'done' | 'error';
  error?: string;
}

export type SortKey = 'name' | 'size' | 'mtime';
export type SortDir = 'asc' | 'desc';
