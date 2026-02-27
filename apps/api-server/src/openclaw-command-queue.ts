import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import type {
  OpenClawQueuedCommand,
  OpenClawCommandQueueState,
  OpenClawConfigDiff,
  OpenClawConfigSnapshot,
} from '@patze/telemetry-core';
import { readRawConfigString, getConfigPath } from './openclaw-config-reader.js';

const execFileAsync = promisify(execFile);

const SAFE_ID_RE = /^[a-zA-Z0-9_-]+$/;
function sanitizeId(id: string): string {
  if (!SAFE_ID_RE.test(id)) throw new Error(`Invalid id: ${id}`);
  return id;
}

function generateId(): string {
  return `cmd_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

function hashConfig(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
}

function resolveCommandBinary(command: string): string {
  if (command === 'openclaw') {
    const override = process.env.OPENCLAW_BIN?.trim();
    if (override) return override;
  }
  return command;
}

interface TargetQueue {
  targetId: string;
  openclawDir: string;
  commands: OpenClawQueuedCommand[];
}

export interface OpenClawCommandInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly description: string;
}

export class OpenClawCommandQueue {
  private readonly queues = new Map<string, TargetQueue>();
  private readonly snapshotDir: string;

  public constructor(dataDir: string) {
    this.snapshotDir = path.join(dataDir, 'config-snapshots');
  }

  public queue(
    targetId: string,
    openclawDir: string,
    commands: readonly OpenClawCommandInput[]
  ): OpenClawCommandQueueState {
    let tq = this.queues.get(targetId);
    if (!tq) {
      tq = { targetId, openclawDir, commands: [] };
      this.queues.set(targetId, tq);
    }
    for (const cmd of commands) {
      tq.commands.push({
        id: generateId(),
        targetId,
        command: cmd.command,
        args: cmd.args,
        description: cmd.description,
        createdAt: new Date().toISOString(),
      });
    }
    return this.getState(targetId);
  }

  public getState(targetId: string): OpenClawCommandQueueState {
    const tq = this.queues.get(targetId);
    return {
      targetId,
      commands: tq?.commands ?? [],
      totalCount: tq?.commands.length ?? 0,
    };
  }

  public discard(targetId: string): void {
    this.queues.delete(targetId);
  }

  public async preview(targetId: string): Promise<OpenClawConfigDiff | null> {
    const tq = this.queues.get(targetId);
    if (!tq || tq.commands.length === 0) return null;
    return this.previewCommands(tq.openclawDir, tq.commands);
  }

  public async apply(
    targetId: string,
    source: string
  ): Promise<{ ok: boolean; error?: string | undefined; snapshotId?: string | undefined }> {
    const tq = this.queues.get(targetId);
    if (!tq || tq.commands.length === 0) {
      return { ok: false, error: 'No pending commands' };
    }
    const result = await this.applyCommands(targetId, tq.openclawDir, tq.commands, source);
    this.queues.delete(targetId);
    return result;
  }

  public async previewCommands(
    openclawDir: string,
    commandsInput: readonly OpenClawCommandInput[]
  ): Promise<OpenClawConfigDiff> {
    const before = readRawConfigString(openclawDir) ?? '{}';
    const commands = commandsInput.map((cmd) => ({
      description: cmd.description,
      cli: `${cmd.command} ${cmd.args.join(' ')}`,
    }));

    const configPath = getConfigPath(openclawDir);
    if (!configPath) {
      return {
        before,
        after: before,
        commandCount: commandsInput.length,
        commands,
        simulated: false,
      };
    }

    const tmpDir = path.join(
      os.tmpdir(),
      `patze-preview-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
    );
    try {
      const relPath = path.relative(openclawDir, configPath);
      const tmpConfigPath = path.join(tmpDir, relPath);
      fs.mkdirSync(path.dirname(tmpConfigPath), { recursive: true });
      fs.copyFileSync(configPath, tmpConfigPath);

      for (const cmd of commandsInput) {
        await execFileAsync(resolveCommandBinary(cmd.command), [...cmd.args], {
          timeout: 10_000,
          maxBuffer: 2 * 1024 * 1024,
          cwd: tmpDir,
        });
      }

      const after = fs.readFileSync(tmpConfigPath, 'utf-8');
      return { before, after, commandCount: commandsInput.length, commands, simulated: true };
    } catch (err: unknown) {
      const simulationError = err instanceof Error ? err.message : String(err);
      return {
        before,
        after: before,
        commandCount: commandsInput.length,
        commands,
        simulated: false,
        simulationError,
      };
    } finally {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        /* ignore cleanup errors */
      }
    }
  }

  public async applyCommands(
    targetId: string,
    openclawDir: string,
    commandsInput: readonly OpenClawCommandInput[],
    source: string
  ): Promise<{ ok: boolean; error?: string | undefined; snapshotId?: string | undefined }> {
    if (commandsInput.length === 0) {
      return { ok: false, error: 'No commands to apply' };
    }

    const beforeConfig = readRawConfigString(openclawDir);
    const snapshotId = await this.createSnapshot(
      targetId,
      beforeConfig ?? '{}',
      source,
      `Before applying ${commandsInput.length} command(s)`
    );

    const errors: string[] = [];
    for (const cmd of commandsInput) {
      try {
        await execFileAsync(resolveCommandBinary(cmd.command), [...cmd.args], {
          timeout: 30_000,
          maxBuffer: 5 * 1024 * 1024,
          cwd: openclawDir,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${cmd.description}: ${message}`);
        await this.rollbackToSnapshot(snapshotId, openclawDir);
        return { ok: false, error: errors.join('; '), snapshotId };
      }
    }

    return { ok: true, snapshotId };
  }

  public async createSnapshot(
    targetId: string,
    configContent: string,
    source: string,
    description: string
  ): Promise<string> {
    const id = `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    const snapshot: OpenClawConfigSnapshot = {
      id,
      targetId,
      timestamp: new Date().toISOString(),
      source,
      description,
      configContent,
      configHash: hashConfig(configContent),
    };

    const targetDir = path.join(this.snapshotDir, sanitizeId(targetId));
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
    }
    const snapshotPath = path.join(targetDir, `${id}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), 'utf-8');
    return id;
  }

  public listSnapshots(targetId: string, limit = 20): readonly OpenClawConfigSnapshot[] {
    const targetDir = path.join(this.snapshotDir, sanitizeId(targetId));
    if (!fs.existsSync(targetDir)) return [];
    try {
      const files = fs.readdirSync(targetDir).filter((f) => f.endsWith('.json'));
      files.sort().reverse();
      const result: OpenClawConfigSnapshot[] = [];
      for (const file of files.slice(0, limit)) {
        try {
          const raw = fs.readFileSync(path.join(targetDir, file), 'utf-8');
          result.push(JSON.parse(raw) as OpenClawConfigSnapshot);
        } catch {
          /* skip corrupt files */
        }
      }
      return result;
    } catch {
      return [];
    }
  }

  public getSnapshot(targetId: string, snapshotId: string): OpenClawConfigSnapshot | null {
    const snapshotPath = path.join(
      this.snapshotDir,
      sanitizeId(targetId),
      `${sanitizeId(snapshotId)}.json`
    );
    if (!fs.existsSync(snapshotPath)) return null;
    try {
      const raw = fs.readFileSync(snapshotPath, 'utf-8');
      return JSON.parse(raw) as OpenClawConfigSnapshot;
    } catch {
      return null;
    }
  }

  public async rollbackToSnapshot(
    snapshotId: string,
    openclawDir: string
  ): Promise<{ ok: boolean; error?: string | undefined }> {
    const configPath = getConfigPath(openclawDir);
    if (!configPath) return { ok: false, error: 'Config file not found' };

    const targetDirs = fs.existsSync(this.snapshotDir) ? fs.readdirSync(this.snapshotDir) : [];
    const safeSnapshotId = sanitizeId(snapshotId);
    for (const dir of targetDirs) {
      const snapshotPath = path.join(this.snapshotDir, dir, `${safeSnapshotId}.json`);
      if (fs.existsSync(snapshotPath)) {
        try {
          const raw = fs.readFileSync(snapshotPath, 'utf-8');
          const snapshot = JSON.parse(raw) as OpenClawConfigSnapshot;
          const tmpPath = `${configPath}.tmp`;
          fs.writeFileSync(tmpPath, snapshot.configContent, 'utf-8');
          fs.renameSync(tmpPath, configPath);
          return { ok: true };
        } catch (err: unknown) {
          return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
      }
    }
    return { ok: false, error: 'Snapshot not found' };
  }
}
