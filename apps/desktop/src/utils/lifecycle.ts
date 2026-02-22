export const ACTIVE_STATES: ReadonlySet<string> = new Set([
  'created',
  'queued',
  'running',
  'waiting_tool',
  'streaming',
]);

export const TERMINAL_OK: ReadonlySet<string> = new Set(['completed']);

export const TERMINAL_BAD: ReadonlySet<string> = new Set(['failed', 'cancelled']);
