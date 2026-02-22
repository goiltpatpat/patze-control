import { hasActiveFilter, navigate, type AppRoute, type RouteFilter } from '../shell/routes';

export interface FilterBarProps {
  readonly route: AppRoute;
  readonly filter: RouteFilter;
}

interface BreadcrumbSegment {
  label: string;
  route: AppRoute;
  filter?: RouteFilter;
}

function buildSegments(route: AppRoute, filter: RouteFilter): BreadcrumbSegment[] {
  const segments: BreadcrumbSegment[] = [];

  if (filter.machineId) {
    segments.push({ label: 'Machines', route: 'machines' });
    segments.push({
      label: filter.machineId,
      route: 'machines',
      filter: { machineId: filter.machineId },
    });
  }

  if (filter.agentId) {
    segments.push({ label: 'Agents', route: 'agents' });
    segments.push({ label: filter.agentId, route: 'agents', filter: { agentId: filter.agentId } });
  }

  if (filter.sessionId) {
    segments.push({ label: 'Sessions', route: 'sessions' });
    segments.push({
      label: filter.sessionId,
      route: 'sessions',
      filter: { sessionId: filter.sessionId },
    });
  }

  if (filter.taskView === 'openclaw') {
    segments.push({ label: 'Tasks', route: 'tasks' });
    segments.push({ label: 'OpenClaw', route: 'tasks', filter: { taskView: 'openclaw' } });
  }

  const routeLabels: Record<string, string> = {
    sessions: 'Sessions',
    runs: 'Runs',
    logs: 'Logs',
    machines: 'Machines',
    agents: 'Agents',
  };
  const currentLabel = routeLabels[route];
  const lastSeg = segments.length > 0 ? segments[segments.length - 1] : undefined;
  if (currentLabel && (!lastSeg || lastSeg.route !== route)) {
    segments.push({ label: currentLabel, route, filter });
  }

  return segments;
}

function truncateId(id: string): string {
  if (id.length <= 14) return id;
  return `${id.slice(0, 12)}…`;
}

export function FilterBar(props: FilterBarProps): JSX.Element | null {
  if (!hasActiveFilter(props.filter)) return null;

  const segments = buildSegments(props.route, props.filter);

  return (
    <div className="filter-bar" role="navigation" aria-label="Breadcrumb">
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        return (
          <span key={`${seg.route}-${seg.label}-${i}`} className="breadcrumb-segment">
            {i > 0 ? (
              <span className="breadcrumb-sep" aria-hidden="true">
                &rsaquo;
              </span>
            ) : null}
            {isLast ? (
              <span className="breadcrumb-current">{truncateId(seg.label)}</span>
            ) : (
              <button
                className="breadcrumb-link"
                onClick={() => {
                  navigate(seg.route, seg.filter);
                }}
              >
                {truncateId(seg.label)}
              </button>
            )}
          </span>
        );
      })}
      <button
        className="filter-bar-clear"
        onClick={() => {
          navigate(props.route);
        }}
        aria-label="Clear filter"
      >
        &times;
      </button>
    </div>
  );
}
