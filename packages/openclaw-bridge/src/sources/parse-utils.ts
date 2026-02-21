import type { AgentId, RunId, SessionId, SessionRunLifecycleState } from '@patze/telemetry-core';
import type { DetectedLogEntry, DetectedModelUsage, DetectedRun, DetectedToolCall } from '../types.js';

export interface RunRecordLike {
  runId?: string;
  id?: string;
  sessionId?: string;
  session_id?: string;
  agentId?: string;
  agent_id?: string;
  name?: string;
  runName?: string;
  startTime?: string;
  startedAt?: string;
  started_at?: string;
  state?: string;
  status?: string;
  toolCalls?: unknown[];
  tools?: unknown[];
  tool_calls?: unknown[];
  model?: string;
  provider?: string;
  tokens?: unknown;
  tokenUsage?: unknown;
  token_usage?: unknown;
  logs?: unknown[];
  log?: unknown[];
  output?: unknown[];
  error?: unknown;
  errorMessage?: string;
  error_message?: string;
  failureReason?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function asRunId(value: string): RunId {
  return value as RunId;
}

export function asSessionId(value: string): SessionId {
  return value as SessionId;
}

export function asAgentId(value: string): AgentId {
  return value as AgentId;
}

export function normalizeLifecycleState(value: unknown): SessionRunLifecycleState | null {
  if (typeof value !== 'string') {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'created': return 'created';
    case 'queued':
    case 'pending': return 'queued';
    case 'running':
    case 'active':
    case 'in_progress': return 'running';
    case 'waiting_tool':
    case 'waiting':
    case 'tool_wait': return 'waiting_tool';
    case 'streaming': return 'streaming';
    case 'completed':
    case 'done':
    case 'success': return 'completed';
    case 'failed':
    case 'error': return 'failed';
    case 'cancelled':
    case 'canceled': return 'cancelled';
    default: return null;
  }
}

export function isActiveState(state: SessionRunLifecycleState): boolean {
  return (
    state === 'created' ||
    state === 'queued' ||
    state === 'running' ||
    state === 'waiting_tool' ||
    state === 'streaming'
  );
}

function parseToolCalls(raw: unknown[] | undefined): DetectedToolCall[] | undefined {
  if (!raw || raw.length === 0) {
    return undefined;
  }
  const calls: DetectedToolCall[] = [];
  for (const entry of raw) {
    if (!isRecord(entry)) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    const id = (e.toolCallId ?? e.id ?? e.tool_call_id) as string | undefined;
    const name = (e.toolName ?? e.name ?? e.tool_name ?? e.function) as string | undefined;
    if (!id || !name) {
      continue;
    }
    const statusStr = (e.status ?? e.state ?? 'completed') as string;
    const status = (['started', 'completed', 'failed', 'cancelled'].includes(statusStr)
      ? statusStr
      : 'completed') as DetectedToolCall['status'];

    calls.push({
      toolCallId: id,
      toolName: name,
      status,
      ...(typeof e.startedAt === 'string' ? { startedAt: e.startedAt } : {}),
      ...(typeof e.durationMs === 'number' ? { durationMs: e.durationMs } : {}),
      ...(typeof e.success === 'boolean' ? { success: e.success } : {}),
      ...(typeof e.errorMessage === 'string' ? { errorMessage: e.errorMessage } : {}),
      ...(typeof e.error_message === 'string' ? { errorMessage: e.error_message } : {}),
    });
  }
  return calls.length > 0 ? calls : undefined;
}

function parseModelUsage(record: RunRecordLike): DetectedModelUsage | undefined {
  const model = record.model;
  const provider = record.provider ?? 'unknown';
  if (!model) {
    return undefined;
  }

  const usage = (record.tokenUsage ?? record.token_usage ?? record.tokens) as Record<string, unknown> | undefined;
  if (!isRecord(usage)) {
    return undefined;
  }

  const input = Number(usage.inputTokens ?? usage.input_tokens ?? usage.prompt_tokens ?? 0);
  const output = Number(usage.outputTokens ?? usage.output_tokens ?? usage.completion_tokens ?? 0);
  const total = Number(usage.totalTokens ?? usage.total_tokens ?? input + output);
  const cost = typeof usage.estimatedCostUsd === 'number' ? usage.estimatedCostUsd : undefined;

  return {
    provider,
    model,
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    ...(cost !== undefined ? { estimatedCostUsd: cost } : {}),
  };
}

function normLogLevel(raw: unknown): DetectedLogEntry['level'] {
  if (typeof raw !== 'string') {
    return 'info';
  }
  const n = raw.toLowerCase();
  if (n === 'critical' || n === 'fatal') { return 'critical'; }
  if (n === 'error' || n === 'err') { return 'error'; }
  if (n === 'warn' || n === 'warning') { return 'warn'; }
  if (n === 'debug' || n === 'trace') { return 'debug'; }
  return 'info';
}

function parseLogs(raw: unknown[] | undefined): DetectedLogEntry[] | undefined {
  if (!raw || raw.length === 0) {
    return undefined;
  }
  const entries: DetectedLogEntry[] = [];
  let idx = 0;
  for (const entry of raw) {
    if (typeof entry === 'string') {
      entries.push({ id: `log_${String(idx++)}`, level: 'info', message: entry, ts: new Date().toISOString() });
      continue;
    }
    if (!isRecord(entry)) {
      continue;
    }
    const e = entry as Record<string, unknown>;
    const message = (e.message ?? e.msg ?? e.text) as string | undefined;
    if (!message) {
      continue;
    }
    entries.push({
      id: (typeof e.id === 'string' ? e.id : `log_${String(idx++)}`),
      level: normLogLevel(e.level ?? e.severity),
      message,
      ts: (typeof e.ts === 'string' ? e.ts : typeof e.timestamp === 'string' ? e.timestamp : new Date().toISOString()),
    });
  }
  return entries.length > 0 ? entries : undefined;
}

export function parseRunRecord(input: unknown): DetectedRun | null {
  if (!isRecord(input)) {
    return null;
  }

  const record = input as RunRecordLike;
  const runId = record.runId ?? record.id;
  const sessionId = record.sessionId ?? record.session_id;
  const agentId = record.agentId ?? record.agent_id;
  if (!runId || !sessionId || !agentId) {
    return null;
  }

  const state = normalizeLifecycleState(record.state ?? record.status);
  if (!state) {
    return null;
  }

  const startedAt = record.startedAt ?? record.started_at ?? record.startTime;
  const toolCalls = parseToolCalls(record.toolCalls ?? record.tools ?? record.tool_calls);
  const modelUsage = parseModelUsage(record);
  const logs = parseLogs(record.logs ?? record.log ?? record.output);

  const errorMessage = typeof record.error === 'string'
    ? record.error
    : typeof record.errorMessage === 'string'
      ? record.errorMessage
      : typeof record.error_message === 'string'
        ? record.error_message
        : typeof record.failureReason === 'string'
          ? record.failureReason
          : isRecord(record.error) && typeof (record.error as Record<string, unknown>).message === 'string'
            ? (record.error as Record<string, unknown>).message as string
            : undefined;

  return {
    runId: asRunId(runId),
    sessionId: asSessionId(sessionId),
    agentId: asAgentId(agentId),
    state,
    ...(startedAt ? { startedAt } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(modelUsage ? { modelUsage } : {}),
    ...(logs ? { logs } : {}),
    ...(errorMessage ? { errorMessage } : {}),
  };
}

export function parseRunsPayload(payload: unknown): readonly DetectedRun[] {
  const runs: DetectedRun[] = [];
  if (Array.isArray(payload)) {
    for (const entry of payload) {
      const parsed = parseRunRecord(entry);
      if (parsed) {
        runs.push(parsed);
      }
    }
    return runs;
  }

  const parsed = parseRunRecord(payload);
  if (parsed) {
    runs.push(parsed);
  }
  return runs;
}
