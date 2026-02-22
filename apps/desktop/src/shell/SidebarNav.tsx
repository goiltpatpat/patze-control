import {
  IconActivity,
  IconBrain,
  IconBuilding,
  IconBot,
  IconClock,
  IconConsole,
  IconDollar,
  IconFolder,
  IconGrid,
  IconLayers,
  IconMessage,
  IconServer,
  IconSettings,
  IconTerminal,
  IconTunnel,
} from '../components/Icons';
import type { AppRoute } from './routes';

export interface SidebarNavProps {
  readonly route: AppRoute;
  readonly onNavigate: (route: AppRoute) => void;
  readonly alertBadges?: Readonly<Partial<Record<AppRoute, number>>>;
}

interface NavEntry {
  readonly type: 'item';
  readonly route: AppRoute;
  readonly label: string;
  readonly icon: (props: { className?: string }) => JSX.Element;
  readonly shortcut?: string;
}

interface NavSectionLabel {
  readonly type: 'section';
  readonly key: string;
  readonly label: string;
}

type NavElement = NavEntry | NavSectionLabel;

const NAV_TOP: readonly NavElement[] = [
  { type: 'section', key: 'sec-core', label: 'Core' },
  { type: 'item', route: 'overview', label: 'Overview', icon: IconGrid, shortcut: '1' },
  { type: 'item', route: 'agents', label: 'Agents', icon: IconBot, shortcut: '2' },
  { type: 'item', route: 'tunnels', label: 'Connections', icon: IconTunnel, shortcut: '3' },
  { type: 'section', key: 'sec-data', label: 'Data' },
  { type: 'item', route: 'machines', label: 'Machines', icon: IconServer, shortcut: '4' },
  { type: 'item', route: 'sessions', label: 'Sessions', icon: IconLayers, shortcut: '5' },
  { type: 'item', route: 'channels', label: 'Channels', icon: IconMessage, shortcut: '6' },
  { type: 'item', route: 'runs', label: 'Runs', icon: IconActivity, shortcut: '7' },
  { type: 'item', route: 'logs', label: 'Logs', icon: IconTerminal, shortcut: '8' },
  { type: 'section', key: 'sec-tools', label: 'Tools' },
  { type: 'item', route: 'monitor', label: 'Monitor', icon: IconActivity },
  { type: 'item', route: 'workspace', label: 'Workspace', icon: IconFolder },
  { type: 'item', route: 'memory', label: 'Memory', icon: IconBrain },
  { type: 'item', route: 'terminal', label: 'Terminal', icon: IconConsole },
  { type: 'item', route: 'tasks', label: 'Tasks', icon: IconClock, shortcut: '9' },
  { type: 'item', route: 'costs', label: 'Costs', icon: IconDollar },
  { type: 'item', route: 'office', label: 'Office', icon: IconBuilding },
];

const NAV_BOTTOM: readonly NavEntry[] = [
  { type: 'item', route: 'settings', label: 'Settings', icon: IconSettings, shortcut: '0' },
];

function NavButton(props: {
  item: NavEntry;
  isActive: boolean;
  onClick: () => void;
  badge?: number | undefined;
}): JSX.Element {
  const { item, isActive, onClick, badge } = props;
  const IconComponent = item.icon;
  return (
    <button
      className={`nav-item${isActive ? ' active' : ''}`}
      aria-current={isActive ? 'page' : undefined}
      onClick={onClick}
      title={item.shortcut ? `${item.label} (${item.shortcut})` : item.label}
    >
      <IconComponent className="nav-item-icon" aria-hidden="true" />
      {item.label}
      {badge != null && badge > 0 ? (
        <span className="nav-alert-badge" aria-label={`${String(badge)} alerts`}>
          {badge > 99 ? '99+' : String(badge)}
        </span>
      ) : null}
      <span
        className={`nav-shortcut-hint${item.shortcut ? '' : ' nav-shortcut-empty'}`}
        aria-hidden="true"
      >
        {item.shortcut ?? ''}
      </span>
    </button>
  );
}

export function SidebarNav(props: SidebarNavProps): JSX.Element {
  const badges = props.alertBadges ?? {};
  return (
    <aside className="sidebar-nav">
      <nav role="navigation" aria-label="Main navigation" className="sidebar-nav-top">
        {NAV_TOP.map((el) => {
          if (el.type === 'section') {
            return (
              <div key={el.key} className="sidebar-section-label">
                {el.label}
              </div>
            );
          }
          return (
            <NavButton
              key={el.route}
              item={el}
              isActive={props.route === el.route}
              onClick={() => props.onNavigate(el.route)}
              badge={badges[el.route]}
            />
          );
        })}
      </nav>
      <div className="sidebar-nav-bottom">
        {NAV_BOTTOM.map((item) => (
          <NavButton
            key={item.route}
            item={item}
            isActive={props.route === item.route}
            onClick={() => props.onNavigate(item.route)}
            badge={badges[item.route]}
          />
        ))}
      </div>
    </aside>
  );
}
