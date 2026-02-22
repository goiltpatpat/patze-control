import fs from 'node:fs';
import path from 'node:path';
import type { TaskStoreData } from './types.js';

const MAX_SNAPSHOTS = 100;

export interface TaskSnapshot {
  readonly id: string;
  readonly createdAt: string;
  readonly source: 'add' | 'update' | 'remove' | 'rollback' | 'manual';
  readonly description: string;
  readonly taskCount: number;
}

interface SnapshotIndex {
  readonly snapshots: TaskSnapshot[];
}

/**
 * Every task mutation creates a snapshot of the full task list
 * before applying the change. Enables rollback to any point.
 * Inspired by ClawPal's config-level history/rollback system,
 * adapted for our task-level granularity.
 */
export class TaskSnapshotStore {
  private readonly snapshotDir: string;
  private readonly indexPath: string;

  public constructor(storeDir: string) {
    this.snapshotDir = path.join(storeDir, 'snapshots');
    this.indexPath = path.join(this.snapshotDir, 'index.json');
  }

  /**
   * Capture current state before a mutation.
   */
  public capture(
    data: TaskStoreData,
    source: TaskSnapshot['source'],
    description: string
  ): TaskSnapshot {
    this.ensureDir();

    const id = `${Date.now()}-${source}`;
    const snapshot: TaskSnapshot = {
      id,
      createdAt: new Date().toISOString(),
      source,
      description,
      taskCount: data.tasks.length,
    };

    const filePath = path.join(this.snapshotDir, `${id}.json`);
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf-8');

    const index = this.loadIndex();
    index.snapshots.push(snapshot);

    if (index.snapshots.length > MAX_SNAPSHOTS) {
      const removed = index.snapshots.splice(0, index.snapshots.length - MAX_SNAPSHOTS);
      for (const old of removed) {
        try {
          fs.unlinkSync(path.join(this.snapshotDir, `${old.id}.json`));
        } catch {
          /* ok */
        }
      }
    }

    this.persistIndex(index);
    return snapshot;
  }

  public list(limit = 20, offset = 0): readonly TaskSnapshot[] {
    const index = this.loadIndex();
    return index.snapshots
      .slice()
      .reverse()
      .slice(offset, offset + limit);
  }

  public getSnapshotData(snapshotId: string): TaskStoreData | null {
    const filePath = path.join(this.snapshotDir, `${sanitizeId(snapshotId)}.json`);
    if (!fs.existsSync(filePath)) return null;

    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as TaskStoreData;
    } catch {
      return null;
    }
  }

  private loadIndex(): { snapshots: TaskSnapshot[] } {
    try {
      if (!fs.existsSync(this.indexPath)) return { snapshots: [] };
      const raw = fs.readFileSync(this.indexPath, 'utf-8');
      const parsed = JSON.parse(raw) as SnapshotIndex;
      return { snapshots: [...parsed.snapshots] };
    } catch {
      return { snapshots: [] };
    }
  }

  private persistIndex(index: { snapshots: TaskSnapshot[] }): void {
    const content = JSON.stringify(index, null, 2);
    const tmpPath = `${this.indexPath}.tmp`;
    fs.writeFileSync(tmpPath, content, 'utf-8');
    fs.renameSync(tmpPath, this.indexPath);
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.snapshotDir)) {
      fs.mkdirSync(this.snapshotDir, { recursive: true });
    }
  }
}

function sanitizeId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}
