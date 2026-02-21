import { IconActivity, IconBot, IconGrid, IconLayers, IconServer, IconSettings, IconTerminal, IconTunnel } from '../components/Icons';
import type { AppRoute } from './routes';

export interface SidebarNavProps {
  readonly route: AppRoute;
  readonly onNavigate: (route: AppRoute) => void;
}

const NAV_ITEMS: ReadonlyArray<{
  route: AppRoute;
  label: string;
  icon: (props: { className?: string }) => JSX.Element;
  section?: string;
  shortcut: string;
}> = [
  { route: 'overview', label: 'Overview', icon: IconGrid, shortcut: '1' },
  { route: 'agents', label: 'Agents', icon: IconBot, shortcut: '2' },
  { route: 'tunnels', label: 'Connections', icon: IconTunnel, shortcut: '3' },
  { route: 'machines', label: 'Machines', icon: IconServer, section: 'Resources', shortcut: '4' },
  { route: 'sessions', label: 'Sessions', icon: IconLayers, shortcut: '5' },
  { route: 'runs', label: 'Runs', icon: IconActivity, shortcut: '6' },
  { route: 'logs', label: 'Logs', icon: IconTerminal, shortcut: '7' },
  { route: 'settings', label: 'Settings', icon: IconSettings, section: 'System', shortcut: '8' },
];

export function SidebarNav(props: SidebarNavProps): JSX.Element {
  return (
    <aside className="sidebar-nav">
      <nav role="navigation" aria-label="Main navigation">
        {NAV_ITEMS.map((item) => {
          const IconComponent = item.icon;
          const isActive = props.route === item.route;
          return (
            <div key={item.route}>
              {item.section ? (
                <div className="sidebar-section-label">{item.section}</div>
              ) : null}
              <button
                className={`nav-item${isActive ? ' active' : ''}`}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => {
                  props.onNavigate(item.route);
                }}
                title={`${item.label} (${item.shortcut})`}
              >
                <IconComponent className="nav-item-icon" aria-hidden="true" />
                {item.label}
                <span className="nav-shortcut-hint" aria-hidden="true">{item.shortcut}</span>
              </button>
            </div>
          );
        })}
      </nav>
    </aside>
  );
}
