import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import type { FastifyInstance } from 'fastify';
import type { TelemetryAggregator, ScheduledTask, TaskExecutor } from '@patze/telemetry-core';
import type { RemoteNodeAttachmentOrchestrator } from './remote-node-attachment-orchestrator.js';

const execFileAsync = promisify(execFile);

function isBlockedWebhookHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const blocked = [
    'localhost',
    '127.0.0.1',
    '0.0.0.0',
    '::1',
    '0000:0000:0000:0000:0000:0000:0000:0001',
  ];
  if (blocked.includes(h)) return true;
  const parts = h.split('.').map(Number);
  if (parts.length === 4 && parts.every((n) => !isNaN(n))) {
    if (parts[0] === 10) return true;
    if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
  }
  return false;
}

interface ExecutorDeps {
  orchestrator: RemoteNodeAttachmentOrchestrator;
  telemetryAggregator: TelemetryAggregator;
  app: FastifyInstance;
}

export function createTaskExecutor(deps: ExecutorDeps): TaskExecutor {
  return async (task: ScheduledTask) => {
    switch (task.action.action) {
      case 'health_check':
        return executeHealthCheck(deps);

      case 'reconnect_endpoints':
        return executeReconnectEndpoints(deps);

      case 'cleanup_sessions':
        return executeCleanupSessions(deps);

      case 'generate_report':
        return executeGenerateReport(deps);

      case 'custom_webhook':
        return executeCustomWebhook(task);

      case 'openclaw_cron_run':
        return executeOpenClawCronRun(task, deps);

      default:
        return { ok: false, error: `Unknown action: ${task.action.action}` };
    }
  };
}

async function executeHealthCheck(deps: ExecutorDeps): Promise<{ ok: boolean; error?: string }> {
  const attachments = deps.orchestrator.listAttachments();
  const errors: string[] = [];

  for (const attachment of attachments) {
    try {
      const healthUrl = `${attachment.tunnel.localBaseUrl}/health`;
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) {
        errors.push(`${attachment.endpointId}: HTTP ${res.status}`);
      }
    } catch (err) {
      errors.push(
        `${attachment.endpointId}: ${err instanceof Error ? err.message : 'unreachable'}`
      );
    }
  }

  if (errors.length > 0) {
    deps.app.log.warn({ errors }, 'Scheduled health check found issues');
    return { ok: false, error: errors.join('; ') };
  }

  deps.app.log.info(`Scheduled health check passed (${attachments.length} endpoints)`);
  return { ok: true };
}

async function executeReconnectEndpoints(
  deps: ExecutorDeps
): Promise<{ ok: boolean; error?: string }> {
  const attachments = deps.orchestrator.listAttachments();
  let cycled = 0;
  const errors: string[] = [];

  for (const attachment of attachments) {
    let healthy = false;
    try {
      const healthUrl = `${attachment.tunnel.localBaseUrl}/health`;
      const res = await fetch(healthUrl, { signal: AbortSignal.timeout(5_000) });
      healthy = res.ok;
    } catch {
      /* unreachable */
    }

    if (healthy) continue;

    const endpoint = deps.orchestrator.getEndpointConfig(attachment.endpointId);
    try {
      await deps.orchestrator.detachEndpoint(attachment.endpointId, { closeTunnel: true });
    } catch {
      /* best effort teardown */
    }

    if (endpoint) {
      try {
        await deps.orchestrator.attachEndpoint(endpoint);
        cycled++;
        deps.app.log.info(`Reconnected endpoint ${attachment.endpointId}`);
      } catch (err) {
        errors.push(
          `${attachment.endpointId}: re-attach failed — ${err instanceof Error ? err.message : 'unknown'}`
        );
      }
    } else {
      errors.push(`${attachment.endpointId}: no stored config, cannot re-attach`);
    }
  }

  deps.app.log.info(`Reconnect check: ${cycled} endpoints cycled, ${errors.length} errors`);
  if (errors.length > 0) {
    return { ok: false, error: errors.join('; ') };
  }
  return { ok: true };
}

async function executeCleanupSessions(
  deps: ExecutorDeps
): Promise<{ ok: boolean; error?: string }> {
  try {
    const snapshot = deps.telemetryAggregator.getUnifiedSnapshot();
    const now = Date.now();
    const STALE_THRESHOLD_MS = 30 * 60 * 1000;
    let staleCount = 0;

    for (const [sessionId, session] of Object.entries(snapshot.sessions)) {
      const updatedAt = new Date(session.updatedAt).getTime();
      const isTerminal =
        session.state === 'completed' ||
        session.state === 'failed' ||
        session.state === 'cancelled';
      if (!isTerminal && now - updatedAt > STALE_THRESHOLD_MS) {
        staleCount++;
        deps.app.log.info(
          `Stale session detected: ${sessionId} (last update ${Math.round((now - updatedAt) / 60_000)}m ago)`
        );
      }
    }

    deps.app.log.info(
      `Cleanup check: ${staleCount} stale session(s) found out of ${Object.keys(snapshot.sessions).length} total`
    );
    return {
      ok: true,
      ...(staleCount > 0 ? { error: `${staleCount} stale session(s) detected` } : {}),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'cleanup_failed' };
  }
}

async function executeGenerateReport(deps: ExecutorDeps): Promise<{ ok: boolean; error?: string }> {
  try {
    const snapshot = deps.telemetryAggregator.getUnifiedSnapshot();

    const machines = Object.keys(snapshot.machines).length;
    const sessions = Object.keys(snapshot.sessions).length;
    const runs = Object.keys(snapshot.runs).length;
    const activeSessions = Object.values(snapshot.sessions).filter(
      (s) => s.state !== 'completed' && s.state !== 'failed' && s.state !== 'cancelled'
    ).length;
    const activeRuns = Object.values(snapshot.runs).filter(
      (r) => r.state !== 'completed' && r.state !== 'failed' && r.state !== 'cancelled'
    ).length;
    const failedRuns = Object.values(snapshot.runs).filter((r) => r.state === 'failed').length;

    deps.app.log.info(
      {
        machines,
        sessions,
        activeSessions,
        runs,
        activeRuns,
        failedRuns,
      },
      'Scheduled report generated'
    );

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'report_failed' };
  }
}

async function executeCustomWebhook(task: ScheduledTask): Promise<{ ok: boolean; error?: string }> {
  const url = task.action.params?.url as string | undefined;
  if (!url) {
    return { ok: false, error: 'No webhook URL configured' };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    return { ok: false, error: 'Invalid webhook URL' };
  }
  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return { ok: false, error: 'Webhook URL must use http/https' };
  }
  if (isBlockedWebhookHost(parsedUrl.hostname)) {
    return { ok: false, error: 'Webhook URL targets a blocked host (localhost/private/metadata)' };
  }

  try {
    const timeoutMs = Math.min(task.timeoutMs ?? 60_000, 600_000);
    const methodRaw = ((task.action.params?.method as string) ?? 'POST').toUpperCase();
    const allowedMethods = new Set(['GET', 'POST', 'PUT', 'PATCH']);
    if (!allowedMethods.has(methodRaw)) {
      return { ok: false, error: `Webhook method not allowed: ${methodRaw}` };
    }
    const body = task.action.params?.body ? JSON.stringify(task.action.params.body) : null;

    const res = await fetch(url, {
      method: methodRaw,
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });

    if (!res.ok) {
      return { ok: false, error: `Webhook returned ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : 'webhook_failed' };
  }
}

/**
 * Trigger an OpenClaw native cron job via the CLI, following
 * ClawPal's `trigger_cron_job` pattern: `openclaw cron run <jobId>`
 */
async function executeOpenClawCronRun(
  task: ScheduledTask,
  deps: ExecutorDeps
): Promise<{ ok: boolean; error?: string }> {
  const jobId = task.action.params?.jobId as string | undefined;
  if (!jobId) {
    return { ok: false, error: 'No jobId configured for openclaw_cron_run' };
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(jobId)) {
    return { ok: false, error: 'Invalid jobId format for openclaw_cron_run' };
  }

  const openclawBin = (task.action.params?.openclawBin as string | undefined) ?? 'openclaw';
  if (!path.isAbsolute(openclawBin) && path.basename(openclawBin) !== openclawBin) {
    return { ok: false, error: 'Invalid openclawBin path' };
  }

  try {
    const timeoutMs = Math.min(task.timeoutMs ?? 60_000, 600_000);
    const { stdout, stderr } = await execFileAsync(openclawBin, ['cron', 'run', jobId], {
      timeout: timeoutMs,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env },
    });

    deps.app.log.info({ jobId, stdout: stdout.trim() }, 'OpenClaw cron run completed');

    if (stderr && stderr.trim().length > 0) {
      deps.app.log.warn({ jobId, stderr: stderr.trim() }, 'OpenClaw cron run stderr');
    }

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.app.log.error({ jobId, error: message }, 'OpenClaw cron run failed');
    return { ok: false, error: message };
  }
}
