export type AppRoute =
  | 'overview'
  | 'agents'
  | 'tunnels'
  | 'machines'
  | 'sessions'
  | 'runs'
  | 'logs'
  | 'tasks'
  | 'channels'
  | 'settings';

const VALID_ROUTES: readonly AppRoute[] = [
  'overview',
  'agents',
  'tunnels',
  'machines',
  'sessions',
  'runs',
  'logs',
  'tasks',
  'channels',
  'settings',
];

function isAppRoute(value: string): value is AppRoute {
  return (VALID_ROUTES as readonly string[]).includes(value);
}

export interface RouteFilter {
  readonly machineId?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly taskView?: 'openclaw';
}

export interface RouteState {
  readonly route: AppRoute;
  readonly filter: RouteFilter;
}

const EMPTY_FILTER: RouteFilter = Object.freeze({});

export function parseRouteState(hash: string): RouteState {
  const raw = hash.startsWith('#/') ? hash.slice(2) : hash.startsWith('#') ? hash.slice(1) : hash;
  const qIndex = raw.indexOf('?');
  const routePart = qIndex >= 0 ? raw.slice(0, qIndex) : raw;
  const route: AppRoute = isAppRoute(routePart) ? routePart : 'overview';

  if (qIndex < 0) {
    return { route, filter: EMPTY_FILTER };
  }

  const params = new URLSearchParams(raw.slice(qIndex + 1));
  const machineId = params.get('machineId') ?? undefined;
  const sessionId = params.get('sessionId') ?? undefined;
  const agentId = params.get('agentId') ?? undefined;
  const taskView = params.get('taskView') === 'openclaw' ? 'openclaw' : undefined;

  if (!machineId && !sessionId && !agentId && !taskView) {
    return { route, filter: EMPTY_FILTER };
  }

  const filter: RouteFilter = {
    ...(machineId ? { machineId } : undefined),
    ...(sessionId ? { sessionId } : undefined),
    ...(agentId ? { agentId } : undefined),
    ...(taskView ? { taskView } : undefined),
  };
  return { route, filter: Object.freeze(filter) };
}

export function navigate(route: AppRoute, filter?: RouteFilter): void {
  let hash = `#/${route}`;
  if (filter) {
    const params = new URLSearchParams();
    if (filter.machineId) params.set('machineId', filter.machineId);
    if (filter.sessionId) params.set('sessionId', filter.sessionId);
    if (filter.agentId) params.set('agentId', filter.agentId);
    if (filter.taskView) params.set('taskView', filter.taskView);
    const qs = params.toString();
    if (qs) hash += `?${qs}`;
  }
  window.location.hash = hash;
}

export function hasActiveFilter(filter: RouteFilter): boolean {
  return Boolean(filter.machineId ?? filter.sessionId ?? filter.agentId ?? filter.taskView);
}
