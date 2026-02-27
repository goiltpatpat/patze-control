import { useCallback, useEffect, useMemo, useState } from 'react';

type FleetAlertSeverity = 'warning' | 'high' | 'critical';

interface FleetAlertDestination {
  readonly id: string;
  readonly name: string;
  readonly kind: 'webhook';
  readonly url: string;
  readonly minimumSeverity: FleetAlertSeverity;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface FleetAlertRouteRule {
  readonly id: string;
  readonly name: string;
  readonly minimumSeverity: FleetAlertSeverity;
  readonly targetScope: 'all' | 'target_ids';
  readonly targetIds: readonly string[];
  readonly destinationIds: readonly string[];
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface FleetAlertDraft {
  name: string;
  url: string;
  minimumSeverity: FleetAlertSeverity;
}

interface FleetRouteRuleDraft {
  name: string;
  minimumSeverity: FleetAlertSeverity;
  targetScope: 'all' | 'target_ids';
  targetIdsText: string;
  destinationIds: string[];
}

const DEFAULT_DRAFT: FleetAlertDraft = {
  name: '',
  url: '',
  minimumSeverity: 'high',
};

const DEFAULT_RULE_DRAFT: FleetRouteRuleDraft = {
  name: '',
  minimumSeverity: 'high',
  targetScope: 'all',
  targetIdsText: '',
  destinationIds: [],
};

function buildHeaders(token: string, json?: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token.length > 0) headers.Authorization = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

export function FleetAlertsSection(props: {
  readonly baseUrl: string;
  readonly token: string;
  readonly connected: boolean;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [draft, setDraft] = useState<FleetAlertDraft>(DEFAULT_DRAFT);
  const [destinations, setDestinations] = useState<readonly FleetAlertDestination[]>([]);
  const [rules, setRules] = useState<readonly FleetAlertRouteRule[]>([]);
  const [ruleDraft, setRuleDraft] = useState<FleetRouteRuleDraft>(DEFAULT_RULE_DRAFT);
  const [cooldownMs, setCooldownMs] = useState(0);

  const fetchAll = useCallback(async (): Promise<void> => {
    if (!props.connected) {
      setDestinations([]);
      setRules([]);
      return;
    }
    setBusy(true);
    try {
      const [destinationsRes, rulesRes] = await Promise.all([
        fetch(`${props.baseUrl}/fleet/alerts/destinations`, {
          headers: buildHeaders(props.token),
          signal: AbortSignal.timeout(8_000),
        }),
        fetch(`${props.baseUrl}/fleet/alerts/rules`, {
          headers: buildHeaders(props.token),
          signal: AbortSignal.timeout(8_000),
        }),
      ]);
      if (!destinationsRes.ok || !rulesRes.ok) {
        setMessage('Fleet alert API unavailable or disabled.');
        return;
      }
      const data = (await destinationsRes.json()) as {
        destinations?: FleetAlertDestination[];
        cooldownMs?: number;
      };
      const ruleData = (await rulesRes.json()) as { rules?: FleetAlertRouteRule[] };
      setDestinations(data.destinations ?? []);
      setRules(ruleData.rules ?? []);
      setCooldownMs(typeof data.cooldownMs === 'number' ? data.cooldownMs : 0);
      setMessage(null);
    } catch {
      setMessage('Cannot load Fleet alert destinations.');
    } finally {
      setBusy(false);
    }
  }, [props.baseUrl, props.connected, props.token]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  const sortedDestinations = useMemo(
    () => [...destinations].sort((a, b) => a.name.localeCompare(b.name)),
    [destinations]
  );
  const sortedRules = useMemo(
    () => [...rules].sort((a, b) => a.name.localeCompare(b.name)),
    [rules]
  );
  const destinationNameById = useMemo(() => {
    const map: Record<string, string> = {};
    for (const destination of destinations) {
      map[destination.id] = destination.name;
    }
    return map;
  }, [destinations]);

  const createDestination = useCallback(async (): Promise<void> => {
    const name = draft.name.trim();
    const url = draft.url.trim();
    if (!name) {
      setMessage('Destination name is required.');
      return;
    }
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      setMessage('Webhook URL must start with http:// or https://');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${props.baseUrl}/fleet/alerts/destinations`, {
        method: 'POST',
        headers: buildHeaders(props.token, true),
        body: JSON.stringify({
          name,
          url,
          minimumSeverity: draft.minimumSeverity,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        setMessage(`Failed to create destination (HTTP ${String(res.status)}).`);
        return;
      }
      setDraft(DEFAULT_DRAFT);
      setMessage('Alert destination created.');
      await fetchAll();
    } catch {
      setMessage('Failed to create destination — network error.');
    } finally {
      setBusy(false);
    }
  }, [draft, fetchAll, props.baseUrl, props.token]);

  const patchDestination = useCallback(
    async (
      destinationId: string,
      patch: Partial<{ enabled: boolean; minimumSeverity: FleetAlertSeverity }>
    ): Promise<void> => {
      setBusy(true);
      try {
        const res = await fetch(
          `${props.baseUrl}/fleet/alerts/destinations/${encodeURIComponent(destinationId)}`,
          {
            method: 'PATCH',
            headers: buildHeaders(props.token, true),
            body: JSON.stringify(patch),
            signal: AbortSignal.timeout(8_000),
          }
        );
        if (!res.ok) {
          setMessage(`Failed to update destination (HTTP ${String(res.status)}).`);
          return;
        }
        setMessage('Destination updated.');
        await fetchAll();
      } catch {
        setMessage('Failed to update destination — network error.');
      } finally {
        setBusy(false);
      }
    },
    [fetchAll, props.baseUrl, props.token]
  );

  const sendTest = useCallback(
    async (destinationId: string): Promise<void> => {
      setBusy(true);
      try {
        const res = await fetch(`${props.baseUrl}/fleet/alerts/test`, {
          method: 'POST',
          headers: buildHeaders(props.token, true),
          body: JSON.stringify({ destinationId }),
          signal: AbortSignal.timeout(8_000),
        });
        if (!res.ok) {
          setMessage(`Test alert failed (HTTP ${String(res.status)}).`);
          return;
        }
        setMessage('Test alert sent.');
      } catch {
        setMessage('Test alert failed — network error.');
      } finally {
        setBusy(false);
      }
    },
    [props.baseUrl, props.token]
  );

  const createRule = useCallback(async (): Promise<void> => {
    if (sortedDestinations.length === 0) {
      setMessage('Create at least one destination before creating routing rules.');
      return;
    }
    const name = ruleDraft.name.trim();
    if (!name) {
      setMessage('Rule name is required.');
      return;
    }
    if (ruleDraft.destinationIds.length === 0) {
      setMessage('Select at least one destination for the rule.');
      return;
    }
    const targetIds =
      ruleDraft.targetScope === 'target_ids'
        ? ruleDraft.targetIdsText
            .split(',')
            .map((item) => item.trim())
            .filter((item) => item.length > 0)
        : [];
    if (ruleDraft.targetScope === 'target_ids' && targetIds.length === 0) {
      setMessage('Provide target IDs for target-scoped rule.');
      return;
    }
    setBusy(true);
    try {
      const res = await fetch(`${props.baseUrl}/fleet/alerts/rules`, {
        method: 'POST',
        headers: buildHeaders(props.token, true),
        body: JSON.stringify({
          name,
          minimumSeverity: ruleDraft.minimumSeverity,
          targetScope: ruleDraft.targetScope,
          targetIds,
          destinationIds: ruleDraft.destinationIds,
        }),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        setMessage(`Failed to create rule (HTTP ${String(res.status)}).`);
        return;
      }
      setRuleDraft(DEFAULT_RULE_DRAFT);
      setMessage('Routing rule created.');
      await fetchAll();
    } catch {
      setMessage('Failed to create rule — network error.');
    } finally {
      setBusy(false);
    }
  }, [fetchAll, props.baseUrl, props.token, ruleDraft, sortedDestinations.length]);

  const patchRule = useCallback(
    async (ruleId: string, patch: Partial<{ enabled: boolean }>): Promise<void> => {
      setBusy(true);
      try {
        const res = await fetch(
          `${props.baseUrl}/fleet/alerts/rules/${encodeURIComponent(ruleId)}`,
          {
            method: 'PATCH',
            headers: buildHeaders(props.token, true),
            body: JSON.stringify(patch),
            signal: AbortSignal.timeout(8_000),
          }
        );
        if (!res.ok) {
          setMessage(`Failed to update rule (HTTP ${String(res.status)}).`);
          return;
        }
        setMessage('Rule updated.');
        await fetchAll();
      } catch {
        setMessage('Failed to update rule — network error.');
      } finally {
        setBusy(false);
      }
    },
    [fetchAll, props.baseUrl, props.token]
  );

  return (
    <div className="settings-section fleet-alerts-section">
      <h3 className="settings-section-title fleet-policies-title-row">
        <span>Fleet Alerts</span>
        <button
          className="btn-ghost fleet-policy-btn"
          disabled={busy}
          onClick={() => void fetchAll()}
        >
          Refresh
        </button>
      </h3>
      {!props.connected ? (
        <p className="doctor-hint">Connect to manage Fleet alerts.</p>
      ) : (
        <div className="fleet-alerts-wrap">
          {message ? <p className="fleet-policies-msg">{message}</p> : null}
          <p className="fleet-alerts-hint">
            {`Webhook alert cooldown: ${String(Math.floor(cooldownMs / 1000))}s (per destination + event signature).`}
          </p>
          <div className="fleet-alerts-create-row">
            <input
              className="fleet-policy-input"
              placeholder="Destination Name"
              value={draft.name}
              onChange={(event) => setDraft((prev) => ({ ...prev, name: event.target.value }))}
            />
            <input
              className="fleet-policy-input"
              placeholder="Webhook URL"
              value={draft.url}
              onChange={(event) => setDraft((prev) => ({ ...prev, url: event.target.value }))}
            />
            <select
              className="fleet-policy-select"
              value={draft.minimumSeverity}
              onChange={(event) =>
                setDraft((prev) => ({
                  ...prev,
                  minimumSeverity: event.target.value as FleetAlertSeverity,
                }))
              }
            >
              <option value="warning">Min severity: warning</option>
              <option value="high">Min severity: high</option>
              <option value="critical">Min severity: critical</option>
            </select>
            <button
              className="btn-primary fleet-policy-btn"
              disabled={busy}
              onClick={() => void createDestination()}
            >
              Add
            </button>
          </div>
          <div className="table-scroll">
            <table className="data-table compact">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Kind</th>
                  <th>Min Severity</th>
                  <th>Status</th>
                  <th>URL</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {sortedDestinations.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="fleet-policy-empty-cell">
                      No alert destinations configured.
                    </td>
                  </tr>
                ) : (
                  sortedDestinations.map((destination) => (
                    <tr key={destination.id}>
                      <td>{destination.name}</td>
                      <td className="mono">{destination.kind}</td>
                      <td>
                        <select
                          className="fleet-policy-select"
                          value={destination.minimumSeverity}
                          onChange={(event) =>
                            void patchDestination(destination.id, {
                              minimumSeverity: event.target.value as FleetAlertSeverity,
                            })
                          }
                        >
                          <option value="warning">warning</option>
                          <option value="high">high</option>
                          <option value="critical">critical</option>
                        </select>
                      </td>
                      <td>
                        <span className={`badge ${destination.enabled ? 'tone-ok' : 'tone-muted'}`}>
                          {destination.enabled ? 'enabled' : 'disabled'}
                        </span>
                      </td>
                      <td className="mono fleet-alerts-url-cell">{destination.url}</td>
                      <td>
                        <div className="fleet-policy-actions">
                          <button
                            className="btn-secondary fleet-policy-btn"
                            disabled={busy}
                            onClick={() =>
                              void patchDestination(destination.id, {
                                enabled: !destination.enabled,
                              })
                            }
                          >
                            {destination.enabled ? 'Disable' : 'Enable'}
                          </button>
                          <button
                            className="btn-ghost fleet-policy-btn"
                            disabled={busy || !destination.enabled}
                            onClick={() => void sendTest(destination.id)}
                          >
                            Test
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          <div className="fleet-alert-rules-panel">
            <h4 className="section-subtitle">Routing Rules</h4>
            <div className="fleet-alert-rules-form">
              <input
                className="fleet-policy-input"
                placeholder="Rule Name"
                value={ruleDraft.name}
                onChange={(event) =>
                  setRuleDraft((prev) => ({ ...prev, name: event.target.value }))
                }
              />
              <select
                className="fleet-policy-select"
                value={ruleDraft.minimumSeverity}
                onChange={(event) =>
                  setRuleDraft((prev) => ({
                    ...prev,
                    minimumSeverity: event.target.value as FleetAlertSeverity,
                  }))
                }
              >
                <option value="warning">Min severity: warning</option>
                <option value="high">Min severity: high</option>
                <option value="critical">Min severity: critical</option>
              </select>
              <select
                className="fleet-policy-select"
                value={ruleDraft.targetScope}
                onChange={(event) =>
                  setRuleDraft((prev) => ({
                    ...prev,
                    targetScope: event.target.value as 'all' | 'target_ids',
                  }))
                }
              >
                <option value="all">Scope: all targets</option>
                <option value="target_ids">Scope: specific target IDs</option>
              </select>
              {ruleDraft.targetScope === 'target_ids' ? (
                <input
                  className="fleet-policy-input"
                  placeholder="target-a,target-b,target-c"
                  value={ruleDraft.targetIdsText}
                  onChange={(event) =>
                    setRuleDraft((prev) => ({ ...prev, targetIdsText: event.target.value }))
                  }
                />
              ) : null}
              <div className="fleet-alert-rule-destinations">
                {sortedDestinations.length === 0 ? (
                  <p className="fleet-alerts-hint">
                    Add destination first, then configure routing rules.
                  </p>
                ) : (
                  sortedDestinations.map((destination) => {
                    const selected = ruleDraft.destinationIds.includes(destination.id);
                    return (
                      <label key={destination.id} className="fleet-policy-checkbox">
                        <input
                          type="checkbox"
                          checked={selected}
                          onChange={(event) =>
                            setRuleDraft((prev) => ({
                              ...prev,
                              destinationIds: event.target.checked
                                ? [...prev.destinationIds, destination.id]
                                : prev.destinationIds.filter((item) => item !== destination.id),
                            }))
                          }
                        />
                        {destination.name}
                      </label>
                    );
                  })
                )}
              </div>
              <button
                className="btn-primary fleet-policy-btn"
                disabled={busy || sortedDestinations.length === 0}
                onClick={() => void createRule()}
              >
                Add Rule
              </button>
            </div>
            <div className="table-scroll">
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Scope</th>
                    <th>Min Severity</th>
                    <th>Destinations</th>
                    <th>Status</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRules.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="fleet-policy-empty-cell">
                        No routing rules. Default routing sends to all eligible destinations.
                      </td>
                    </tr>
                  ) : (
                    sortedRules.map((rule) => (
                      <tr key={rule.id}>
                        <td>{rule.name}</td>
                        <td className="mono">
                          {rule.targetScope === 'all'
                            ? 'all'
                            : `${String(rule.targetIds.length)} target(s)`}
                        </td>
                        <td>{rule.minimumSeverity}</td>
                        <td className="mono">
                          {rule.destinationIds
                            .map(
                              (destinationId) => destinationNameById[destinationId] ?? destinationId
                            )
                            .join(', ')}
                        </td>
                        <td>
                          <span className={`badge ${rule.enabled ? 'tone-ok' : 'tone-muted'}`}>
                            {rule.enabled ? 'enabled' : 'disabled'}
                          </span>
                        </td>
                        <td>
                          <button
                            className="btn-secondary fleet-policy-btn"
                            disabled={busy}
                            onClick={() => void patchRule(rule.id, { enabled: !rule.enabled })}
                          >
                            {rule.enabled ? 'Disable' : 'Enable'}
                          </button>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
