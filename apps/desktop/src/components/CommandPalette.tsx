import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconActivity,
  IconBot,
  IconClock,
  IconGrid,
  IconLayers,
  IconMessage,
  IconSearch,
  IconServer,
  IconSettings,
  IconTerminal,
  IconTunnel,
} from './Icons';
import type { AppRoute } from '../shell/routes';
import { navigate } from '../shell/routes';
import type { FrontendUnifiedSnapshot } from '../types';

export interface CommandPaletteProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly snapshot: FrontendUnifiedSnapshot | null;
}

interface PaletteItem {
  readonly id: string;
  readonly group: string;
  readonly label: string;
  readonly meta?: string;
  readonly icon: (props: { className?: string }) => JSX.Element;
  readonly iconBg: string;
  readonly shortcut?: string;
  readonly action: () => void;
}

const NAV_ITEMS: ReadonlyArray<{
  route: AppRoute;
  label: string;
  icon: (props: { className?: string }) => JSX.Element;
  iconBg: string;
  shortcut: string;
  keywords: string[];
}> = [
  {
    route: 'overview',
    label: 'Overview',
    icon: IconGrid,
    iconBg: 'var(--accent-soft)',
    shortcut: '1',
    keywords: ['home', 'dashboard', 'overview'],
  },
  {
    route: 'agents',
    label: 'Agents',
    icon: IconBot,
    iconBg: 'var(--blue-soft)',
    shortcut: '2',
    keywords: ['agents', 'bot', 'ai'],
  },
  {
    route: 'tunnels',
    label: 'Connections',
    icon: IconTunnel,
    iconBg: 'var(--green-soft)',
    shortcut: '3',
    keywords: ['tunnels', 'connections', 'bridge', 'vps', 'ssh'],
  },
  {
    route: 'machines',
    label: 'Machines',
    icon: IconServer,
    iconBg: 'var(--accent-soft)',
    shortcut: '4',
    keywords: ['machines', 'servers', 'nodes', 'fleet'],
  },
  {
    route: 'sessions',
    label: 'Sessions',
    icon: IconLayers,
    iconBg: 'var(--blue-soft)',
    shortcut: '5',
    keywords: ['sessions', 'conversations'],
  },
  {
    route: 'channels',
    label: 'Channels',
    icon: IconMessage,
    iconBg: 'var(--amber-soft)',
    shortcut: '6',
    keywords: ['channels', 'messaging', 'providers'],
  },
  {
    route: 'runs',
    label: 'Runs',
    icon: IconActivity,
    iconBg: 'var(--green-soft)',
    shortcut: '7',
    keywords: ['runs', 'executions', 'active'],
  },
  {
    route: 'logs',
    label: 'Logs',
    icon: IconTerminal,
    iconBg: 'var(--muted-soft)',
    shortcut: '8',
    keywords: ['logs', 'debug', 'console'],
  },
  {
    route: 'tasks',
    label: 'Tasks',
    icon: IconClock,
    iconBg: 'var(--amber-soft)',
    shortcut: '9',
    keywords: ['tasks', 'cron', 'scheduler', 'openclaw'],
  },
  {
    route: 'settings',
    label: 'Settings',
    icon: IconSettings,
    iconBg: 'var(--muted-soft)',
    shortcut: '0',
    keywords: ['settings', 'config', 'auth', 'preferences'],
  },
];

function fuzzyMatch(query: string, text: string): boolean {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (t.includes(q)) return true;

  let qi = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) qi++;
  }
  return qi === q.length;
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Reset state when opening
  useEffect(() => {
    if (props.open) {
      setQuery('');
      setActiveIndex(0);
      // Focus input after render
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [props.open]);

  // Build items
  const items = useMemo<readonly PaletteItem[]>(() => {
    const result: PaletteItem[] = [];
    const q = query.trim();

    // Navigation items
    const navMatches =
      q.length === 0
        ? NAV_ITEMS
        : NAV_ITEMS.filter(
            (item) => fuzzyMatch(q, item.label) || item.keywords.some((kw) => fuzzyMatch(q, kw))
          );

    for (const nav of navMatches) {
      result.push({
        id: `nav:${nav.route}`,
        group: 'Navigate',
        label: nav.label,
        icon: nav.icon,
        iconBg: nav.iconBg,
        shortcut: nav.shortcut,
        action: () => {
          navigate(nav.route);
          props.onClose();
        },
      });
    }

    // Search snapshot data when query is non-empty
    if (q.length >= 2 && props.snapshot) {
      const snap = props.snapshot;

      // Search machines
      for (const machine of snap.machines) {
        const searchText = `${machine.machineId} ${machine.name ?? ''}`;
        if (fuzzyMatch(q, searchText)) {
          result.push({
            id: `machine:${machine.machineId}`,
            group: 'Machines',
            label: machine.name ?? machine.machineId.slice(0, 12),
            meta: `${machine.status} · ${machine.machineId.slice(0, 8)}`,
            icon: IconServer,
            iconBg: 'var(--accent-soft)',
            action: () => {
              navigate('machines', { machineId: machine.machineId });
              props.onClose();
            },
          });
        }
      }

      // Search sessions
      for (const session of snap.sessions.slice(0, 50)) {
        const searchText = `${session.sessionId} ${session.machineId}`;
        if (fuzzyMatch(q, searchText)) {
          result.push({
            id: `session:${session.sessionId}`,
            group: 'Sessions',
            label: session.sessionId.slice(0, 16),
            meta: `${session.state} · machine ${session.machineId.slice(0, 8)}`,
            icon: IconLayers,
            iconBg: 'var(--blue-soft)',
            action: () => {
              navigate('sessions', { sessionId: session.sessionId });
              props.onClose();
            },
          });
        }
      }

      // Search runs
      for (const run of snap.runs.slice(0, 50)) {
        const searchText = `${run.runId} ${run.machineId}`;
        if (fuzzyMatch(q, searchText)) {
          result.push({
            id: `run:${run.runId}`,
            group: 'Runs',
            label: run.runId.slice(0, 16),
            meta: `${run.state} · machine ${run.machineId.slice(0, 8)}`,
            icon: IconActivity,
            iconBg: 'var(--green-soft)',
            action: () => {
              navigate('runs');
              props.onClose();
            },
          });
        }
      }
    }

    return result;
  }, [query, props.snapshot, props.onClose]);

  // Clamp active index
  useEffect(() => {
    if (activeIndex >= items.length) {
      setActiveIndex(Math.max(0, items.length - 1));
    }
  }, [items.length, activeIndex]);

  // Scroll active item into view
  useEffect(() => {
    if (!listRef.current) return;
    const activeEl = listRef.current.querySelector('.command-palette-item.active');
    if (activeEl) {
      activeEl.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setActiveIndex((prev) => (prev + 1) % Math.max(1, items.length));
          break;
        case 'ArrowUp':
          e.preventDefault();
          setActiveIndex((prev) => (prev - 1 + items.length) % Math.max(1, items.length));
          break;
        case 'Enter':
          e.preventDefault();
          if (items.length > 0 && activeIndex < items.length) {
            const item = items[activeIndex];
            item?.action();
          }
          break;
        case 'Escape':
          e.preventDefault();
          props.onClose();
          break;
      }
    },
    [items, activeIndex, props.onClose]
  );

  if (!props.open) return null;

  // Group items
  const groups: Array<{ label: string; items: readonly PaletteItem[] }> = [];
  let currentGroup = '';
  for (const item of items) {
    if (item.group !== currentGroup) {
      currentGroup = item.group;
      groups.push({ label: item.group, items: [] });
    }
    (groups[groups.length - 1]!.items as PaletteItem[]).push(item);
  }

  let flatIndex = 0;

  return (
    <div className="command-palette-backdrop" onClick={props.onClose}>
      <div
        className="command-palette"
        onClick={(e) => {
          e.stopPropagation();
        }}
        onKeyDown={handleKeyDown}
      >
        <div className="command-palette-input-wrap">
          <IconSearch width={18} height={18} />
          <input
            ref={inputRef}
            className="command-palette-input"
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setActiveIndex(0);
            }}
            placeholder="Search views, machines, sessions..."
            autoComplete="off"
            spellCheck={false}
          />
          <span className="command-palette-hint">ESC</span>
        </div>

        <div className="command-palette-results" ref={listRef}>
          {items.length === 0 ? (
            <div className="command-palette-empty">
              {query.length > 0 ? `No results for "${query}"` : 'Start typing to search…'}
            </div>
          ) : (
            groups.map((group) => (
              <div key={group.label}>
                <div className="command-palette-group-label">{group.label}</div>
                {group.items.map((item) => {
                  const idx = flatIndex++;
                  const IconComponent = item.icon;
                  return (
                    <div
                      key={item.id}
                      className={`command-palette-item${idx === activeIndex ? ' active' : ''}`}
                      onClick={() => {
                        item.action();
                      }}
                      onMouseEnter={() => {
                        setActiveIndex(idx);
                      }}
                    >
                      <div
                        className="command-palette-item-icon"
                        style={{ background: item.iconBg }}
                      >
                        <IconComponent />
                      </div>
                      <div className="command-palette-item-body">
                        <div className="command-palette-item-label">{item.label}</div>
                        {item.meta ? (
                          <div className="command-palette-item-meta">{item.meta}</div>
                        ) : null}
                      </div>
                      {item.shortcut ? (
                        <span className="command-palette-item-shortcut">{item.shortcut}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ))
          )}
        </div>

        <div className="command-palette-footer">
          <span>
            <kbd>↑↓</kbd> navigate
          </span>
          <span>
            <kbd>↵</kbd> select
          </span>
          <span>
            <kbd>esc</kbd> close
          </span>
        </div>
      </div>
    </div>
  );
}
