import { useMemo, useState } from 'react';
import type { FrontendUnifiedSnapshot } from '../types';
import { ACTIVE_STATES } from '../utils/lifecycle';
import { parseSessionOrigin } from '../utils/openclaw';
import { formatRelativeTime } from '../utils/time';

type SessionCategory = 'empty' | 'low_value' | 'valuable' | 'active';

interface AnalyzedSession {
  readonly sessionId: string;
  readonly agentId: string;
  readonly machineId: string;
  readonly state: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly endedAt?: string | undefined;
  readonly runCount: number;
  readonly ageMs: number;
  readonly category: SessionCategory;
  readonly origin: string;
}

interface CategorySummary {
  readonly category: SessionCategory;
  readonly label: string;
  readonly description: string;
  readonly tone: string;
  readonly count: number;
  readonly sessions: readonly AnalyzedSession[];
}

function categorizeSession(session: {
  state: string;
  runCount: number;
  ageMs: number;
}): SessionCategory {
  if (ACTIVE_STATES.has(session.state)) return 'active';
  if (session.runCount === 0) return 'empty';
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  if (session.runCount <= 1 && session.ageMs > sevenDaysMs) return 'low_value';
  return 'valuable';
}

function formatAge(ms: number): string {
  const days = Math.floor(ms / (24 * 60 * 60 * 1000));
  if (days < 1) return 'today';
  if (days === 1) return '1 day';
  if (days < 30) return `${String(days)} days`;
  const months = Math.floor(days / 30);
  return months === 1 ? '1 month' : `${String(months)} months`;
}

export interface SessionAnalysisPanelProps {
  readonly snapshot: FrontendUnifiedSnapshot | null;
  readonly onDeleteSessions?: (sessionIds: string[]) => void;
}

export function SessionAnalysisPanel(props: SessionAnalysisPanelProps): JSX.Element | null {
  const { snapshot } = props;
  const [selectedCategory, setSelectedCategory] = useState<SessionCategory | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState(false);

  const analyzed = useMemo<readonly AnalyzedSession[]>(() => {
    if (!snapshot) return [];
    const now = Date.now();
    const runsBySession = new Map<string, number>();
    for (const run of snapshot.runs) {
      runsBySession.set(run.sessionId, (runsBySession.get(run.sessionId) ?? 0) + 1);
    }

    return snapshot.sessions.map((s) => {
      const runCount = runsBySession.get(s.sessionId) ?? 0;
      const ageMs = now - new Date(s.createdAt).getTime();
      const origin = parseSessionOrigin(s.sessionId).channel;
      return {
        sessionId: s.sessionId,
        agentId: s.agentId,
        machineId: s.machineId,
        state: s.state,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        endedAt: s.endedAt,
        runCount,
        ageMs,
        category: categorizeSession({ state: s.state, runCount, ageMs }),
        origin,
      };
    });
  }, [snapshot]);

  const categories = useMemo<readonly CategorySummary[]>(() => {
    const groups: Record<SessionCategory, AnalyzedSession[]> = {
      active: [],
      valuable: [],
      low_value: [],
      empty: [],
    };
    for (const s of analyzed) {
      groups[s.category].push(s);
    }
    return [
      {
        category: 'active',
        label: 'Active',
        description: 'Currently running sessions',
        tone: 'tone-accent',
        count: groups.active.length,
        sessions: groups.active,
      },
      {
        category: 'valuable',
        label: 'Valuable',
        description: 'Multiple runs or recent activity',
        tone: 'tone-good',
        count: groups.valuable.length,
        sessions: groups.valuable,
      },
      {
        category: 'low_value',
        label: 'Low Value',
        description: 'Single run, older than 7 days',
        tone: 'tone-warn',
        count: groups.low_value.length,
        sessions: groups.low_value,
      },
      {
        category: 'empty',
        label: 'Empty',
        description: 'No runs recorded',
        tone: 'tone-bad',
        count: groups.empty.length,
        sessions: groups.empty,
      },
    ];
  }, [analyzed]);

  if (analyzed.length === 0) return null;

  const cleanableCount = categories
    .filter((c) => c.category === 'empty' || c.category === 'low_value')
    .reduce((sum, c) => sum + c.count, 0);

  const selectedCategorySessions = selectedCategory
    ? (categories.find((c) => c.category === selectedCategory)?.sessions ?? [])
    : [];

  const toggleSession = (id: string): void => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectAllInCategory = (): void => {
    setSelectedIds(new Set(selectedCategorySessions.map((s) => s.sessionId)));
  };

  const clearSelection = (): void => {
    setSelectedIds(new Set());
  };

  return (
    <div className="sa-panel">
      <div
        className="sa-header"
        onClick={() => setExpanded((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setExpanded((v) => !v);
          }
        }}
      >
        <div className="sa-header-left">
          <span className="sa-title">Session Analysis</span>
          <span className="badge tone-neutral">{analyzed.length} total</span>
          {cleanableCount > 0 ? (
            <span className="badge tone-warn">{cleanableCount} cleanable</span>
          ) : null}
        </div>
        <span className={`sa-chevron${expanded ? ' sa-chevron-open' : ''}`}>&#x25BE;</span>
      </div>

      {expanded ? (
        <div className="sa-body">
          <div className="sa-category-grid">
            {categories.map((cat) => (
              <button
                key={cat.category}
                type="button"
                className={`sa-category-card${selectedCategory === cat.category ? ' sa-category-active' : ''}`}
                onClick={() => {
                  setSelectedCategory(selectedCategory === cat.category ? null : cat.category);
                  setSelectedIds(new Set());
                }}
              >
                <div className="sa-category-count">
                  <span className={`badge ${cat.tone}`}>{cat.count}</span>
                </div>
                <div className="sa-category-label">{cat.label}</div>
                <div className="sa-category-desc">{cat.description}</div>
              </button>
            ))}
          </div>

          {selectedCategory && selectedCategorySessions.length > 0 ? (
            <div className="sa-detail">
              <div className="sa-detail-toolbar">
                <span className="sa-detail-title">
                  {categories.find((c) => c.category === selectedCategory)?.label} Sessions (
                  {selectedCategorySessions.length})
                </span>
                <div className="sa-detail-actions">
                  <button type="button" className="btn-ghost" onClick={selectAllInCategory}>
                    Select All
                  </button>
                  {selectedIds.size > 0 ? (
                    <>
                      <button type="button" className="btn-ghost" onClick={clearSelection}>
                        Clear
                      </button>
                      {props.onDeleteSessions ? (
                        <button
                          type="button"
                          className="btn-danger"
                          onClick={() => props.onDeleteSessions?.([...selectedIds])}
                        >
                          Delete {selectedIds.size} session{selectedIds.size !== 1 ? 's' : ''}
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              </div>
              <div className="sa-session-list">
                {selectedCategorySessions.map((s) => (
                  <label key={s.sessionId} className="sa-session-row">
                    <input
                      type="checkbox"
                      checked={selectedIds.has(s.sessionId)}
                      onChange={() => toggleSession(s.sessionId)}
                    />
                    <span className="sa-session-agent mono">{s.agentId}</span>
                    <span className="sa-session-id mono" title={s.sessionId}>
                      {s.sessionId.length > 20 ? `${s.sessionId.slice(0, 18)}…` : s.sessionId}
                    </span>
                    <span className="badge tone-neutral">{s.origin}</span>
                    <span className="sa-session-runs">{s.runCount} runs</span>
                    <span className="sa-session-age">{formatAge(s.ageMs)}</span>
                    <span className="sa-session-updated">{formatRelativeTime(s.updatedAt)}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
