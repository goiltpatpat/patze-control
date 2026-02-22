import fs from 'node:fs';
import path from 'node:path';
import type { ScheduledTask, TaskRunRecord, TaskStoreData } from './types.js';
import { RUN_HISTORY_MAX } from './types.js';

const EMPTY_STORE: TaskStoreData = { version: 1, tasks: [] };

export class TaskStore {
  private readonly tasksPath: string;
  private readonly runLogPath: string;

  public constructor(storeDir: string) {
    this.tasksPath = path.join(storeDir, 'tasks.json');
    this.runLogPath = path.join(storeDir, 'run-history.jsonl');
  }

  public load(): TaskStoreData {
    try {
      if (!fs.existsSync(this.tasksPath)) return EMPTY_STORE;
      const raw = fs.readFileSync(this.tasksPath, 'utf-8');
      const parsed = JSON.parse(raw) as TaskStoreData;
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.tasks)) {
        return EMPTY_STORE;
      }
      return parsed;
    } catch {
      return EMPTY_STORE;
    }
  }

  public persist(data: TaskStoreData): void {
    const dir = path.dirname(this.tasksPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const content = JSON.stringify(data, null, 2);
    const tmpPath = `${this.tasksPath}.tmp`;

    fs.writeFileSync(tmpPath, content, 'utf-8');
    if (fs.existsSync(this.tasksPath)) {
      fs.copyFileSync(this.tasksPath, `${this.tasksPath}.bak`);
    }
    fs.renameSync(tmpPath, this.tasksPath);
  }

  public appendRunRecord(record: TaskRunRecord): void {
    const dir = path.dirname(this.runLogPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.appendFileSync(this.runLogPath, JSON.stringify(record) + '\n', 'utf-8');
    this.pruneRunLog();
  }

  public loadRunHistory(taskId?: string): readonly TaskRunRecord[] {
    try {
      if (!fs.existsSync(this.runLogPath)) return [];
      const raw = fs.readFileSync(this.runLogPath, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      const records = lines
        .map((line) => {
          try {
            return JSON.parse(line) as TaskRunRecord;
          } catch {
            return null;
          }
        })
        .filter((r): r is TaskRunRecord => r !== null);

      if (taskId) return records.filter((r) => r.taskId === taskId);
      return records;
    } catch {
      return [];
    }
  }

  private pruneRunLog(): void {
    try {
      if (!fs.existsSync(this.runLogPath)) return;
      const raw = fs.readFileSync(this.runLogPath, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);
      if (lines.length <= RUN_HISTORY_MAX) return;
      const kept = lines.slice(-RUN_HISTORY_MAX);
      fs.writeFileSync(this.runLogPath, kept.join('\n') + '\n', 'utf-8');
    } catch {
      // Best-effort pruning
    }
  }

  public updateTask(
    tasks: readonly ScheduledTask[],
    taskId: string,
    patch: Partial<ScheduledTask>
  ): readonly ScheduledTask[] {
    return tasks.map((t) => {
      if (t.id !== taskId) return t;
      return { ...t, ...patch, updatedAt: new Date().toISOString() };
    });
  }
}
