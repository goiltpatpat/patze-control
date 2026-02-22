import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  IconActivity,
  IconBrain,
  IconBuilding,
  IconBot,
  IconClock,
  IconConsole,
  IconDollar,
  IconFile,
  IconFolder,
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
  readonly baseUrl: string;
  readonly token: string;
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

interface WorkspaceSearchResult {
  readonly path: string;
  readonly name: string;
  readonly lineNumber: number;
  readonly line: string;
  readonly contextBefore: string;
  readonly contextAfter: string;
}

interface UseFileSearchResult {
  readonly results: readonly WorkspaceSearchResult[];
  readonly loading: boolean;
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
    route: 'monitor',
    label: 'Monitor',
    icon: IconActivity,
    iconBg: 'var(--accent-soft)',
    shortcut: '',
    keywords: ['monitor', 'system', 'cpu', 'memory', 'network', 'disk'],
  },
  {
    route: 'workspace',
    label: 'Workspace',
    icon: IconFolder,
    iconBg: 'var(--muted-soft)',
    shortcut: '',
    keywords: ['workspace', 'files', 'editor'],
  },
  {
    route: 'memory',
    label: 'Memory',
    icon: IconBrain,
    iconBg: 'var(--blue-soft)',
    shortcut: '',
    keywords: ['memory', 'soul', 'context', 'tasks'],
  },
  {
    route: 'terminal',
    label: 'Terminal',
    icon: IconConsole,
    iconBg: 'var(--muted-soft)',
    shortcut: '',
    keywords: ['terminal', 'shell', 'command'],
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
    route: 'costs',
    label: 'Costs',
    icon: IconDollar,
    iconBg: 'var(--green-soft)',
    shortcut: '',
    keywords: ['costs', 'billing', 'tokens'],
  },
  {
    route: 'office',
    label: 'Office',
    icon: IconBuilding,
    iconBg: 'var(--amber-soft)',
    shortcut: '',
    keywords: ['office', 'desks', 'isometric', 'targets'],
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

function buildAuthHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function useFileSearch(
  open: boolean,
  query: string,
  baseUrl: string,
  token: string
): UseFileSearchResult {
  const [results, setResults] = useState<readonly WorkspaceSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!open) {
      setResults([]);
      setLoading(false);
      abortRef.current?.abort();
      abortRef.current = null;
      return;
    }
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      setResults([]);
      setLoading(false);
      abortRef.current?.abort();
      abortRef.current = null;
      return;
    }

    setLoading(true);
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      abortRef.current?.abort();
      abortRef.current = controller;
      void fetch(`${baseUrl}/workspace/search?q=${encodeURIComponent(trimmed)}&maxResults=20`, {
        headers: buildAuthHeaders(token),
        signal: controller.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            return { results: [] as WorkspaceSearchResult[] };
          }
          return (await res.json()) as { results: WorkspaceSearchResult[] };
        })
        .then((data) => {
          setResults(Array.isArray(data.results) ? data.results : []);
          setLoading(false);
        })
        .catch(() => {
          if (controller.signal.aborted) {
            return;
          }
          setResults([]);
          setLoading(false);
        });
    }, 500);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [open, query, baseUrl, token]);

  return { results, loading };
}

const RECENT_SEARCHES_KEY = 'patze_recent_searches';
const MAX_RECENT = 5;

function loadRecentSearches(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    return [];
  }
}

function saveRecentSearch(query: string): void {
  const trimmed = query.trim();
  if (trimmed.length < 2) return;
  try {
    const existing = loadRecentSearches().filter((s) => s !== trimmed);
    const next = [trimmed, ...existing].slice(0, MAX_RECENT);
    localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next));
  } catch {
    /* storage full */
  }
}

export function CommandPalette(props: CommandPaletteProps): JSX.Element | null {
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const fileSearch = useFileSearch(props.open, query, props.baseUrl, props.token);
  const [recentSearches, setRecentSearches] = useState<string[]>([]);

  useEffect(() => {
    if (props.open) {
      setQuery('');
      setActiveIndex(0);
      setRecentSearches(loadRecentSearches());
      requestAnimationFrame(() => {
        inputRef.current?.focus();
      });
    }
  }, [props.open]);

  const items = useMemo<readonly PaletteItem[]>(() => {
    const result: PaletteItem[] = [];
    const q = query.trim();

    // Show recent searches when query is empty
    if (q.length === 0 && recentSearches.length > 0) {
      for (const recent of recentSearches) {
        result.push({
          id: `recent:${recent}`,
          group: 'Recent',
          label: recent,
          icon: IconSearch,
          iconBg: 'var(--muted-soft)',
          action: () => {
            setQuery(recent);
          },
        });
      }
    }

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
          if (q.length >= 2) saveRecentSearch(q);
          navigate(nav.route);
          props.onClose();
        },
      });
    }

    if (q.length >= 2 && props.snapshot) {
      const snap = props.snapshot;

      // Search agents (derived from sessions/runs)
      const agentIds = new Set<string>();
      for (const session of snap.sessions) {
        if (session.agentId) agentIds.add(session.agentId);
      }
      for (const run of snap.runs) {
        if (run.agentId) agentIds.add(run.agentId);
      }
      for (const agentId of agentIds) {
        if (fuzzyMatch(q, agentId)) {
          result.push({
            id: `agent:${agentId}`,
            group: 'Agents',
            label: agentId.slice(0, 20),
            meta: `Agent · ${agentId.slice(0, 8)}`,
            icon: IconBot,
            iconBg: 'var(--blue-soft)',
            action: () => {
              saveRecentSearch(q);
              navigate('agents');
              props.onClose();
            },
          });
        }
      }

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
              saveRecentSearch(q);
              navigate('machines', { machineId: machine.machineId });
              props.onClose();
            },
          });
        }
      }

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
              saveRecentSearch(q);
              navigate('sessions', { sessionId: session.sessionId });
              props.onClose();
            },
          });
        }
      }

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
              saveRecentSearch(q);
              navigate('runs');
              props.onClose();
            },
          });
        }
      }
    }

    if (q.length >= 3) {
      for (const hit of fileSearch.results) {
        result.push({
          id: `file:${hit.path}:${hit.lineNumber.toString()}`,
          group: 'Files',
          label: hit.name,
          meta: `L${hit.lineNumber.toString()} · ${hit.line.trim()}`,
          icon: IconFile,
          iconBg: 'var(--muted-soft)',
          action: () => {
            saveRecentSearch(q);
            navigate('workspace', {
              openFile: hit.path,
              line: hit.lineNumber.toString(),
            });
            props.onClose();
          },
        });
      }
    }

    return result;
  }, [query, props.snapshot, props.onClose, fileSearch.results, recentSearches]);

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
            placeholder="Search views, machines, sessions, files..."
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
          {fileSearch.loading ? (
            <span className="command-palette-footer-loading">Searching files…</span>
          ) : null}
          {items.length > 0 ? (
            <span className="command-palette-footer-count">
              {items.length} result{items.length !== 1 ? 's' : ''}
            </span>
          ) : null}
          <span className="command-palette-footer-spacer" />
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
