#!/usr/bin/env node

const BASE_URL = process.env.PATZE_API_URL ?? 'http://127.0.0.1:9700';
const TOKEN = process.env.CONTROL_PLANE_TOKEN ?? '';

interface ScheduledTask {
  id: string;
  name: string;
  status: string;
  schedule: { kind: string; expr?: string; everyMs?: number; at?: string };
  action: { action: string };
  lastRunAt?: string;
  lastRunStatus?: string;
  nextRunAtMs?: number;
  totalRuns: number;
  consecutiveErrors: number;
}

interface RunRecord {
  taskId: string;
  runId: string;
  startedAt: string;
  status: string;
  error?: string;
  durationMs?: number;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { 'Content-Type': 'application/json' };
  if (TOKEN) h['Authorization'] = `Bearer ${TOKEN}`;
  return h;
}

async function request(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: headers(),
    body: body ? JSON.stringify(body) : null,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  if (!res.ok) {
    console.error(`Error ${res.status}: ${text}`);
    process.exit(1);
  }
  return text ? JSON.parse(text) : null;
}

function formatSchedule(s: ScheduledTask['schedule']): string {
  switch (s.kind) {
    case 'at':
      return `once at ${s.at}`;
    case 'every': {
      const ms = s.everyMs ?? 0;
      if (ms >= 3_600_000) return `every ${(ms / 3_600_000).toFixed(1)}h`;
      if (ms >= 60_000) return `every ${(ms / 60_000).toFixed(0)}m`;
      return `every ${(ms / 1000).toFixed(0)}s`;
    }
    case 'cron':
      return `cron ${s.expr}`;
    default:
      return s.kind;
  }
}

async function listTasks(): Promise<void> {
  const tasks = (await request('GET', '/tasks')) as ScheduledTask[];
  if (tasks.length === 0) {
    console.log('No scheduled tasks.');
    return;
  }
  console.log(
    `${'ID'.padEnd(28)} ${'Name'.padEnd(24)} ${'Status'.padEnd(10)} ${'Schedule'.padEnd(20)} ${'Runs'.padEnd(6)} Errors`
  );
  console.log('-'.repeat(100));
  for (const t of tasks) {
    console.log(
      `${t.id.padEnd(28)} ${t.name.padEnd(24)} ${t.status.padEnd(10)} ${formatSchedule(t.schedule).padEnd(20)} ${String(t.totalRuns).padEnd(6)} ${t.consecutiveErrors}`
    );
  }
}

async function addTask(name: string, action: string, scheduleStr: string): Promise<void> {
  let schedule: unknown;

  if (scheduleStr.startsWith('every:')) {
    const ms = parseInt(scheduleStr.slice(6), 10);
    schedule = { kind: 'every', everyMs: ms * 60_000 };
  } else if (scheduleStr.startsWith('cron:')) {
    schedule = { kind: 'cron', expr: scheduleStr.slice(5) };
  } else if (scheduleStr.startsWith('at:')) {
    schedule = { kind: 'at', at: scheduleStr.slice(3) };
  } else {
    console.error('Schedule format: every:<minutes> | cron:<expression> | at:<iso-date>');
    process.exit(1);
  }

  const task = (await request('POST', '/tasks', {
    name,
    schedule,
    action: { action },
  })) as ScheduledTask;
  console.log(`Created task: ${task.id} (${task.name})`);
}

async function removeTask(taskId: string): Promise<void> {
  await request('DELETE', `/tasks/${taskId}`);
  console.log(`Removed task: ${taskId}`);
}

async function runTask(taskId: string): Promise<void> {
  console.log(`Running task ${taskId}...`);
  const record = (await request('POST', `/tasks/${taskId}/run`)) as RunRecord;
  console.log(
    `Result: ${record.status}${record.durationMs !== undefined ? ` (${record.durationMs}ms)` : ''}${record.error ? ` — ${record.error}` : ''}`
  );
}

async function enableTask(taskId: string): Promise<void> {
  await request('PATCH', `/tasks/${taskId}`, { status: 'enabled' });
  console.log(`Enabled task: ${taskId}`);
}

async function disableTask(taskId: string): Promise<void> {
  await request('PATCH', `/tasks/${taskId}`, { status: 'disabled' });
  console.log(`Disabled task: ${taskId}`);
}

async function showHistory(taskId?: string): Promise<void> {
  const qs = taskId ? `?taskId=${taskId}` : '';
  const records = (await request('GET', `/tasks/history${qs}`)) as RunRecord[];
  if (records.length === 0) {
    console.log('No run history.');
    return;
  }
  console.log(
    `${'Task'.padEnd(28)} ${'Status'.padEnd(10)} ${'Started'.padEnd(26)} ${'Duration'.padEnd(10)} Error`
  );
  console.log('-'.repeat(100));
  for (const r of records.slice(-20)) {
    console.log(
      `${r.taskId.padEnd(28)} ${r.status.padEnd(10)} ${r.startedAt.padEnd(26)} ${(r.durationMs !== undefined ? `${r.durationMs}ms` : '—').padEnd(10)} ${r.error ?? '—'}`
    );
  }
}

const USAGE = `
Usage: patze-tasks <command> [args]

Commands:
  list                          List all scheduled tasks
  add <name> <action> <schedule>  Create a task
  remove <taskId>               Remove a task
  run <taskId>                  Run a task immediately
  enable <taskId>               Enable a disabled task
  disable <taskId>              Disable a task
  history [taskId]              Show run history

Actions: health_check, reconnect_endpoints, cleanup_sessions, generate_report, custom_webhook
Schedule: every:<minutes> | cron:<expression> | at:<iso-date>

Environment:
  PATZE_API_URL         API server URL (default: http://127.0.0.1:9700)
  CONTROL_PLANE_TOKEN   Auth token

Examples:
  patze-tasks add "Health Check" health_check every:5
  patze-tasks add "Nightly Report" generate_report "cron:0 3 * * *"
  patze-tasks run task_abc123
  patze-tasks list
`.trim();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  switch (command) {
    case 'list':
      return listTasks();
    case 'add': {
      const [, name, action, schedule] = args;
      if (!name || !action || !schedule) {
        console.error('Usage: patze-tasks add <name> <action> <schedule>');
        process.exit(1);
      }
      return addTask(name, action, schedule);
    }
    case 'remove': {
      if (!args[1]) {
        console.error('Usage: patze-tasks remove <taskId>');
        process.exit(1);
      }
      return removeTask(args[1]);
    }
    case 'run': {
      if (!args[1]) {
        console.error('Usage: patze-tasks run <taskId>');
        process.exit(1);
      }
      return runTask(args[1]);
    }
    case 'enable': {
      if (!args[1]) {
        console.error('Usage: patze-tasks enable <taskId>');
        process.exit(1);
      }
      return enableTask(args[1]);
    }
    case 'disable': {
      if (!args[1]) {
        console.error('Usage: patze-tasks disable <taskId>');
        process.exit(1);
      }
      return disableTask(args[1]);
    }
    case 'history':
      return showHistory(args[1]);
    default:
      console.log(USAGE);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
