import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  BridgeControlCommand,
  BridgeControlCommandResult,
  BridgeControlIntent,
  BridgeLogger,
} from './types.js';

const execFileAsync = promisify(execFile);

interface BuiltCliCommand {
  readonly command: string;
  readonly args: readonly string[];
}

interface OpenClawControllerOptions {
  readonly openclawBin: string;
  readonly openclawHomeDir: string;
  readonly logger: BridgeLogger;
  readonly maxStdoutBytes: number;
  readonly maxStderrBytes: number;
}

function truncateOutput(value: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(value, 'utf-8');
  if (bytes.byteLength <= maxBytes) {
    return { text: value, truncated: false };
  }
  return {
    text: bytes.subarray(0, maxBytes).toString('utf-8'),
    truncated: true,
  };
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function asBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function asStringArray(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function buildCommand(
  intent: BridgeControlIntent,
  args: Readonly<Record<string, unknown>>
): BuiltCliCommand {
  switch (intent) {
    case 'trigger_job': {
      const jobId = asString(args.jobId);
      if (!jobId) throw new Error('trigger_job requires args.jobId');
      return { command: 'openclaw', args: ['cron', 'run', jobId] };
    }
    case 'agent_set_enabled': {
      const agentId = asString(args.agentId);
      const enabled = asBoolean(args.enabled);
      if (!agentId || enabled === null) {
        throw new Error('agent_set_enabled requires args.agentId and args.enabled');
      }
      return {
        command: 'openclaw',
        args: ['config', 'set', `agents.${agentId}.enabled`, enabled ? 'true' : 'false'],
      };
    }
    case 'approve_request': {
      const requestId = asString(args.requestId);
      if (!requestId) throw new Error('approve_request requires args.requestId');
      return { command: 'openclaw', args: ['approvals', 'approve', requestId] };
    }
    case 'run_command': {
      const command = asString(args.command);
      const commandArgs = asStringArray(args.args);
      if (!command) throw new Error('run_command requires args.command');
      if (command !== 'openclaw') throw new Error('run_command only allows command=openclaw');
      return { command, args: commandArgs };
    }
    default: {
      const _exhaustive: never = intent;
      return _exhaustive;
    }
  }
}

export class OpenClawController {
  private readonly options: OpenClawControllerOptions;

  public constructor(options: OpenClawControllerOptions) {
    this.options = options;
  }

  public async execute(command: BridgeControlCommand): Promise<BridgeControlCommandResult> {
    const startedAtMs = Date.now();
    try {
      const built = buildCommand(command.snapshot.intent, command.snapshot.args);
      const cliCommand = built.command === 'openclaw' ? this.options.openclawBin : built.command;
      const { stdout, stderr } = await execFileAsync(cliCommand, [...built.args], {
        cwd: this.options.openclawHomeDir,
        timeout: 30_000,
        maxBuffer: 5 * 1024 * 1024,
      });
      const trimmedStdout = truncateOutput(stdout ?? '', this.options.maxStdoutBytes);
      const trimmedStderr = truncateOutput(stderr ?? '', this.options.maxStderrBytes);
      return {
        status: 'succeeded',
        exitCode: 0,
        durationMs: Date.now() - startedAtMs,
        stdout: trimmedStdout.text,
        stderr: trimmedStderr.text,
        truncated: trimmedStdout.truncated || trimmedStderr.truncated,
      };
    } catch (error) {
      const err = error as NodeJS.ErrnoException & {
        readonly stdout?: string;
        readonly stderr?: string;
        readonly code?: number | string | undefined;
      };
      this.options.logger.warn('bridge_control_exec_failed', {
        commandId: command.id,
        intent: command.snapshot.intent,
      });
      const trimmedStdout = truncateOutput(err.stdout ?? '', this.options.maxStdoutBytes);
      const trimmedStderr = truncateOutput(err.stderr ?? err.message, this.options.maxStderrBytes);
      return {
        status: 'failed',
        exitCode: typeof err.code === 'number' ? err.code : 1,
        durationMs: Date.now() - startedAtMs,
        stdout: trimmedStdout.text,
        stderr: trimmedStderr.text,
        truncated: trimmedStdout.truncated || trimmedStderr.truncated,
      };
    }
  }
}
