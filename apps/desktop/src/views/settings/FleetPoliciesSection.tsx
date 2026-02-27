import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '../../components/ConfirmDialog';

type AllowedAuthMode = 'none' | 'token' | 'any';

interface FleetPolicyProfile {
  readonly id: string;
  readonly name: string;
  readonly minBridgeVersion?: string;
  readonly maxSyncLagMs: number;
  readonly allowedAuthMode: AllowedAuthMode;
  readonly maxConsecutiveFailures: number;
}

interface FleetTargetPolicyRow {
  readonly targetId: string;
  readonly targetLabel: string;
  readonly targetType: 'local' | 'remote';
  readonly reported?: {
    readonly machineId?: string;
  };
  readonly drifts?: ReadonlyArray<{
    readonly category?: string;
    readonly severity?: string;
    readonly expected?: string;
    readonly actual?: string;
    readonly detectedAt?: string;
  }>;
  readonly violations?: ReadonlyArray<{
    readonly id?: string;
    readonly code?: string;
    readonly severity?: string;
    readonly message?: string;
  }>;
  readonly policyProfileId: string;
  readonly policyProfileName: string;
  readonly healthScore: number;
  readonly riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

interface PolicyPreviewResult {
  readonly targetId: string;
  readonly policyId: string;
  readonly policyName: string;
  readonly riskLevel: 'low' | 'medium' | 'high' | 'critical';
  readonly healthScore: number;
  readonly drifts: readonly unknown[];
  readonly violations: readonly unknown[];
  readonly summary: string;
}

interface PolicyDraft {
  name: string;
  minBridgeVersion: string;
  maxSyncLagMs: string;
  allowedAuthMode: AllowedAuthMode;
  maxConsecutiveFailures: string;
}

const DEFAULT_DRAFT: PolicyDraft = {
  name: '',
  minBridgeVersion: '',
  maxSyncLagMs: '120000',
  allowedAuthMode: 'any',
  maxConsecutiveFailures: '3',
};

const PRESETS: ReadonlyArray<{
  id: 'balanced' | 'strict' | 'relaxed';
  label: string;
  draft: PolicyDraft;
}> = [
  {
    id: 'balanced',
    label: 'Balanced',
    draft: {
      name: 'Balanced Policy',
      minBridgeVersion: '',
      maxSyncLagMs: '120000',
      allowedAuthMode: 'any',
      maxConsecutiveFailures: '3',
    },
  },
  {
    id: 'strict',
    label: 'Strict',
    draft: {
      name: 'Strict Policy',
      minBridgeVersion: '',
      maxSyncLagMs: '60000',
      allowedAuthMode: 'token',
      maxConsecutiveFailures: '1',
    },
  },
  {
    id: 'relaxed',
    label: 'Relaxed',
    draft: {
      name: 'Relaxed Policy',
      minBridgeVersion: '',
      maxSyncLagMs: '300000',
      allowedAuthMode: 'any',
      maxConsecutiveFailures: '6',
    },
  },
];

const BLAST_RADIUS_CRITICAL_LIMIT = 3;

function buildHeaders(token: string, json?: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token.length > 0) headers.Authorization = `Bearer ${token}`;
  if (json) headers['Content-Type'] = 'application/json';
  return headers;
}

function parseDraft(draft: PolicyDraft):
  | {
      ok: true;
      payload: {
        name: string;
        minBridgeVersion: string;
        maxSyncLagMs: number;
        allowedAuthMode: AllowedAuthMode;
        maxConsecutiveFailures: number;
      };
    }
  | { ok: false; message: string } {
  const name = draft.name.trim();
  if (name.length === 0) return { ok: false, message: 'Policy name is required.' };

  const maxSyncLagMs = Number(draft.maxSyncLagMs);
  if (!Number.isFinite(maxSyncLagMs) || maxSyncLagMs <= 0) {
    return { ok: false, message: 'maxSyncLagMs must be a positive number.' };
  }

  const maxConsecutiveFailures = Number(draft.maxConsecutiveFailures);
  if (!Number.isFinite(maxConsecutiveFailures) || maxConsecutiveFailures < 0) {
    return { ok: false, message: 'maxConsecutiveFailures must be >= 0.' };
  }

  return {
    ok: true,
    payload: {
      name,
      minBridgeVersion: draft.minBridgeVersion.trim(),
      maxSyncLagMs: Math.floor(maxSyncLagMs),
      allowedAuthMode: draft.allowedAuthMode,
      maxConsecutiveFailures: Math.floor(maxConsecutiveFailures),
    },
  };
}

function toDraft(policy: FleetPolicyProfile): PolicyDraft {
  return {
    name: policy.name,
    minBridgeVersion: policy.minBridgeVersion ?? '',
    maxSyncLagMs: String(policy.maxSyncLagMs),
    allowedAuthMode: policy.allowedAuthMode,
    maxConsecutiveFailures: String(policy.maxConsecutiveFailures),
  };
}

export function FleetPoliciesSection(props: {
  readonly baseUrl: string;
  readonly token: string;
  readonly connected: boolean;
}): JSX.Element {
  const [busy, setBusy] = useState(false);
  const [policies, setPolicies] = useState<readonly FleetPolicyProfile[]>([]);
  const [targets, setTargets] = useState<readonly FleetTargetPolicyRow[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [applyPolicyIdByTarget, setApplyPolicyIdByTarget] = useState<Record<string, string>>({});
  const [applyStatusByTarget, setApplyStatusByTarget] = useState<Record<string, string>>({});
  const [previewByTarget, setPreviewByTarget] = useState<
    Record<string, PolicyPreviewResult | undefined>
  >({});
  const [selectedByTarget, setSelectedByTarget] = useState<Record<string, boolean>>({});
  const [editingPolicyId, setEditingPolicyId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<PolicyDraft>(DEFAULT_DRAFT);
  const [newDraft, setNewDraft] = useState<PolicyDraft>(DEFAULT_DRAFT);
  const [reconcileAfterApply, setReconcileAfterApply] = useState(true);
  const [searchText, setSearchText] = useState('');
  const [riskFilter, setRiskFilter] = useState<
    'all' | 'medium_plus' | 'high_or_critical' | 'critical'
  >('all');
  const [reportedFilter, setReportedFilter] = useState<'all' | 'reported' | 'unreported'>('all');
  const [showChangedOnly, setShowChangedOnly] = useState(false);
  const [showBlastConfirm, setShowBlastConfirm] = useState(false);
  const [pendingApprovalToken, setPendingApprovalToken] = useState<string | null>(null);
  const [pendingApprovalCriticalCount, setPendingApprovalCriticalCount] = useState(0);
  const [expandedTargetId, setExpandedTargetId] = useState<string | null>(null);

  const fetchAll = useCallback(async (): Promise<void> => {
    if (!props.connected) {
      setPolicies([]);
      setTargets([]);
      setApplyPolicyIdByTarget({});
      return;
    }

    setBusy(true);
    try {
      const [policiesRes, targetsRes] = await Promise.all([
        fetch(`${props.baseUrl}/fleet/policies`, {
          headers: buildHeaders(props.token),
          signal: AbortSignal.timeout(8_000),
        }),
        fetch(`${props.baseUrl}/fleet/targets`, {
          headers: buildHeaders(props.token),
          signal: AbortSignal.timeout(8_000),
        }),
      ]);

      if (!policiesRes.ok || !targetsRes.ok) {
        setMessage('Fleet policy API unavailable or disabled.');
        return;
      }

      const policyData = (await policiesRes.json()) as { policies?: FleetPolicyProfile[] };
      const targetData = (await targetsRes.json()) as { targets?: FleetTargetPolicyRow[] };
      const nextPolicies = policyData.policies ?? [];
      const nextTargets = targetData.targets ?? [];
      setPolicies(nextPolicies);
      setTargets(nextTargets);
      setApplyPolicyIdByTarget((prev) => {
        const next: Record<string, string> = {};
        for (const target of nextTargets) {
          next[target.targetId] = prev[target.targetId] ?? target.policyProfileId;
        }
        return next;
      });
      setMessage(null);
    } catch {
      setMessage('Cannot load Fleet Policies. Check API connectivity.');
    } finally {
      setBusy(false);
    }
  }, [props.baseUrl, props.connected, props.token]);

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    setSelectedByTarget((prev) => {
      const next: Record<string, boolean> = {};
      for (const target of targets) {
        if (prev[target.targetId]) next[target.targetId] = true;
      }
      return next;
    });
  }, [targets]);

  const sortedPolicies = useMemo(
    () => [...policies].sort((left, right) => left.name.localeCompare(right.name)),
    [policies]
  );

  const isPolicyChanged = useCallback(
    (target: FleetTargetPolicyRow): boolean =>
      (applyPolicyIdByTarget[target.targetId] ?? target.policyProfileId) !== target.policyProfileId,
    [applyPolicyIdByTarget]
  );

  const visibleTargets = useMemo(() => {
    const normalizedSearch = searchText.trim().toLowerCase();
    return targets.filter((target) => {
      if (normalizedSearch.length > 0) {
        const haystack =
          `${target.targetLabel} ${target.targetId} ${target.targetType}`.toLowerCase();
        if (!haystack.includes(normalizedSearch)) return false;
      }

      if (riskFilter === 'critical' && target.riskLevel !== 'critical') return false;
      if (
        riskFilter === 'high_or_critical' &&
        target.riskLevel !== 'high' &&
        target.riskLevel !== 'critical'
      ) {
        return false;
      }
      if (
        riskFilter === 'medium_plus' &&
        target.riskLevel !== 'medium' &&
        target.riskLevel !== 'high' &&
        target.riskLevel !== 'critical'
      ) {
        return false;
      }

      const isReported = Boolean(target.reported?.machineId);
      if (reportedFilter === 'reported' && !isReported) return false;
      if (reportedFilter === 'unreported' && isReported) return false;

      if (showChangedOnly && !isPolicyChanged(target)) return false;
      return true;
    });
  }, [targets, searchText, riskFilter, reportedFilter, showChangedOnly, isPolicyChanged]);

  const selectedTargetIds = useMemo(
    () =>
      visibleTargets
        .filter((target) => selectedByTarget[target.targetId])
        .map((target) => target.targetId),
    [selectedByTarget, visibleTargets]
  );
  const visibleReportedCount = useMemo(
    () => visibleTargets.filter((target) => Boolean(target.reported?.machineId)).length,
    [visibleTargets]
  );
  const visibleCriticalCount = useMemo(
    () => visibleTargets.filter((target) => target.riskLevel === 'critical').length,
    [visibleTargets]
  );
  const visibleUnreportedTargets = useMemo(
    () => visibleTargets.filter((target) => !target.reported?.machineId),
    [visibleTargets]
  );

  const allVisibleSelected =
    visibleTargets.length > 0 && selectedTargetIds.length === visibleTargets.length;
  const selectedTargets = useMemo(
    () => targets.filter((target) => selectedTargetIds.includes(target.targetId)),
    [selectedTargetIds, targets]
  );
  const selectedChangedTargets = useMemo(
    () => selectedTargets.filter((target) => isPolicyChanged(target)),
    [isPolicyChanged, selectedTargets]
  );
  const selectedWithoutPreviewCount = useMemo(
    () =>
      selectedChangedTargets.filter((target) => {
        const selectedPolicyId = applyPolicyIdByTarget[target.targetId] ?? target.policyProfileId;
        const preview = previewByTarget[target.targetId];
        return !preview || preview.policyId !== selectedPolicyId;
      }).length,
    [applyPolicyIdByTarget, previewByTarget, selectedChangedTargets]
  );
  const selectedCriticalCount = useMemo(
    () => selectedChangedTargets.filter((target) => target.riskLevel === 'critical').length,
    [selectedChangedTargets]
  );

  const selectVisibleUnreported = useCallback((): void => {
    setSelectedByTarget((prev) => {
      const next = { ...prev };
      for (const target of visibleUnreportedTargets) {
        next[target.targetId] = true;
      }
      return next;
    });
  }, [visibleUnreportedTargets]);

  const copyVisibleUnreportedIds = useCallback(async (): Promise<void> => {
    if (visibleUnreportedTargets.length === 0) return;
    const payload = visibleUnreportedTargets.map((target) => target.targetId).join('\n');
    try {
      await navigator.clipboard.writeText(payload);
      setMessage('Copied visible unreported target IDs.');
    } catch {
      setMessage('Cannot copy target IDs in current runtime.');
    }
  }, [visibleUnreportedTargets]);

  const startEdit = useCallback((policy: FleetPolicyProfile): void => {
    setEditingPolicyId(policy.id);
    setEditDraft(toDraft(policy));
  }, []);

  const saveEdit = useCallback(async (): Promise<void> => {
    if (!editingPolicyId) return;

    const parsed = parseDraft(editDraft);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(
        `${props.baseUrl}/fleet/policies/${encodeURIComponent(editingPolicyId)}`,
        {
          method: 'PATCH',
          headers: buildHeaders(props.token, true),
          body: JSON.stringify(parsed.payload),
          signal: AbortSignal.timeout(8_000),
        }
      );
      if (!res.ok) {
        setMessage(`Failed to update policy (HTTP ${String(res.status)}).`);
        return;
      }
      setEditingPolicyId(null);
      setMessage('Policy updated.');
      await fetchAll();
    } catch {
      setMessage('Failed to update policy — network error.');
    } finally {
      setBusy(false);
    }
  }, [editDraft, editingPolicyId, fetchAll, props.baseUrl, props.token]);

  const createPolicy = useCallback(async (): Promise<void> => {
    const parsed = parseDraft(newDraft);
    if (!parsed.ok) {
      setMessage(parsed.message);
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(`${props.baseUrl}/fleet/policies`, {
        method: 'POST',
        headers: buildHeaders(props.token, true),
        body: JSON.stringify(parsed.payload),
        signal: AbortSignal.timeout(8_000),
      });
      if (!res.ok) {
        setMessage(`Failed to create policy (HTTP ${String(res.status)}).`);
        return;
      }
      setNewDraft(DEFAULT_DRAFT);
      setMessage('Policy created.');
      await fetchAll();
    } catch {
      setMessage('Failed to create policy — network error.');
    } finally {
      setBusy(false);
    }
  }, [fetchAll, newDraft, props.baseUrl, props.token]);

  const applyPolicy = useCallback(
    async (targetId: string): Promise<void> => {
      const policyId = applyPolicyIdByTarget[targetId];
      if (!policyId) {
        setMessage('Select a policy before applying.');
        return;
      }

      setBusy(true);
      setApplyStatusByTarget((prev) => ({ ...prev, [targetId]: 'Applying policy...' }));
      try {
        const applyRes = await fetch(
          `${props.baseUrl}/fleet/targets/${encodeURIComponent(targetId)}/apply-policy`,
          {
            method: 'POST',
            headers: buildHeaders(props.token, true),
            body: JSON.stringify({ policyId }),
            signal: AbortSignal.timeout(8_000),
          }
        );
        if (!applyRes.ok) {
          setApplyStatusByTarget((prev) => ({
            ...prev,
            [targetId]: `Apply failed (HTTP ${String(applyRes.status)}).`,
          }));
          return;
        }

        if (reconcileAfterApply) {
          setApplyStatusByTarget((prev) => ({
            ...prev,
            [targetId]: 'Policy applied. Reconciling...',
          }));
          const reconcileRes = await fetch(
            `${props.baseUrl}/fleet/targets/${encodeURIComponent(targetId)}/reconcile`,
            {
              method: 'POST',
              headers: buildHeaders(props.token),
              signal: AbortSignal.timeout(8_000),
            }
          );
          if (!reconcileRes.ok) {
            setApplyStatusByTarget((prev) => ({
              ...prev,
              [targetId]: `Policy applied, reconcile failed (HTTP ${String(reconcileRes.status)}).`,
            }));
            await fetchAll();
            return;
          }
          setApplyStatusByTarget((prev) => ({
            ...prev,
            [targetId]: 'Policy applied + reconcile completed.',
          }));
        } else {
          setApplyStatusByTarget((prev) => ({ ...prev, [targetId]: 'Policy applied.' }));
        }

        setMessage('Policy apply completed.');
        await fetchAll();
      } catch {
        setApplyStatusByTarget((prev) => ({
          ...prev,
          [targetId]: 'Apply failed — network error.',
        }));
      } finally {
        setBusy(false);
      }
    },
    [applyPolicyIdByTarget, fetchAll, props.baseUrl, props.token, reconcileAfterApply]
  );

  const previewPolicy = useCallback(
    async (targetId: string): Promise<void> => {
      const policyId = applyPolicyIdByTarget[targetId];
      if (!policyId) return;

      setApplyStatusByTarget((prev) => ({ ...prev, [targetId]: 'Previewing impact...' }));
      try {
        const res = await fetch(
          `${props.baseUrl}/fleet/targets/${encodeURIComponent(targetId)}/policy-preview`,
          {
            method: 'POST',
            headers: buildHeaders(props.token, true),
            body: JSON.stringify({ policyId }),
            signal: AbortSignal.timeout(8_000),
          }
        );
        if (!res.ok) {
          setApplyStatusByTarget((prev) => ({
            ...prev,
            [targetId]: `Preview failed (HTTP ${String(res.status)}).`,
          }));
          return;
        }
        const data = (await res.json()) as PolicyPreviewResult;
        setPreviewByTarget((prev) => ({ ...prev, [targetId]: data }));
        setApplyStatusByTarget((prev) => ({ ...prev, [targetId]: data.summary }));
      } catch {
        setApplyStatusByTarget((prev) => ({
          ...prev,
          [targetId]: 'Preview failed — network error.',
        }));
      }
    },
    [applyPolicyIdByTarget, props.baseUrl, props.token]
  );

  const toggleSelectTarget = useCallback((targetId: string, checked: boolean) => {
    setSelectedByTarget((prev) => ({
      ...prev,
      [targetId]: checked,
    }));
  }, []);

  const toggleSelectAllVisible = useCallback(
    (checked: boolean) => {
      setSelectedByTarget((prev) => {
        const next = { ...prev };
        for (const target of visibleTargets) {
          next[target.targetId] = checked;
        }
        return next;
      });
    },
    [visibleTargets]
  );

  const clearSelection = useCallback(() => {
    setSelectedByTarget({});
  }, []);

  const batchPreview = useCallback(async (): Promise<void> => {
    if (selectedTargetIds.length === 0) {
      setMessage('Select at least one target for batch preview.');
      return;
    }
    for (const targetId of selectedTargetIds) {
      await previewPolicy(targetId);
    }
    setMessage(`Previewed ${String(selectedTargetIds.length)} target(s).`);
  }, [previewPolicy, selectedTargetIds]);

  const executeBatchApply = useCallback(
    async (approvalToken?: string): Promise<void> => {
      if (selectedTargetIds.length === 0) {
        setMessage('Select at least one target for batch apply.');
        return;
      }
      setBusy(true);
      try {
        const items = selectedTargetIds
          .map((targetId) => ({
            targetId,
            policyId: applyPolicyIdByTarget[targetId],
          }))
          .filter(
            (item): item is { targetId: string; policyId: string } =>
              typeof item.policyId === 'string' && item.policyId.length > 0
          );
        if (items.length === 0) {
          setMessage('Select a policy for selected targets before batch apply.');
          return;
        }
        const res = await fetch(`${props.baseUrl}/fleet/policies/batch-apply`, {
          method: 'POST',
          headers: buildHeaders(props.token, true),
          body: JSON.stringify({
            items,
            reconcileAfterApply,
            ...(approvalToken ? { approvalToken } : {}),
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (res.status === 409) {
          const data = (await res.json()) as {
            error?: string;
            approval?: { token?: string; criticalTargetIds?: string[] };
          };
          if (data.error === 'approval_required' && data.approval?.token) {
            setPendingApprovalToken(data.approval.token);
            setPendingApprovalCriticalCount(data.approval.criticalTargetIds?.length ?? 0);
            setShowBlastConfirm(true);
            return;
          }
        }
        if (!res.ok) {
          setMessage(`Batch apply failed (HTTP ${String(res.status)}).`);
          return;
        }
        const data = (await res.json()) as {
          summary?: {
            applied?: number;
            skipped?: number;
            reconcileFailed?: number;
          };
          results?: Array<{ targetId?: string; status?: string; message?: string }>;
        };
        for (const result of data.results ?? []) {
          if (!result.targetId) continue;
          const status =
            result.status === 'applied'
              ? 'Policy applied.'
              : result.status === 'reconcile_failed'
                ? `Policy applied, reconcile failed${result.message ? `: ${result.message}` : '.'}`
                : 'Skipped (no policy change).';
          setApplyStatusByTarget((prev) => ({ ...prev, [result.targetId!]: status }));
        }
        const applied = data.summary?.applied ?? 0;
        const skipped = data.summary?.skipped ?? 0;
        const reconcileFailed = data.summary?.reconcileFailed ?? 0;
        setMessage(
          `Batch apply completed: applied ${String(applied)}, skipped ${String(skipped)}, reconcile failed ${String(
            reconcileFailed
          )}.`
        );
        setPendingApprovalToken(null);
        setPendingApprovalCriticalCount(0);
        await fetchAll();
      } catch {
        setMessage('Batch apply failed — network error.');
      } finally {
        setBusy(false);
      }
    },
    [
      applyPolicyIdByTarget,
      fetchAll,
      props.baseUrl,
      props.token,
      reconcileAfterApply,
      selectedTargetIds,
    ]
  );

  const requestBatchApply = useCallback((): void => {
    if (selectedTargetIds.length === 0) {
      setMessage('Select at least one target for batch apply.');
      return;
    }
    if (selectedChangedTargets.length === 0) {
      setMessage('All selected targets already use the selected policy.');
      return;
    }
    if (selectedWithoutPreviewCount > 0) {
      setMessage(
        `Batch apply blocked: ${String(selectedWithoutPreviewCount)} target(s) need Preview with the current selected policy first.`
      );
      return;
    }
    void executeBatchApply();
  }, [
    executeBatchApply,
    selectedChangedTargets.length,
    selectedTargetIds.length,
    selectedWithoutPreviewCount,
  ]);

  return (
    <div className="settings-section fleet-policies-section">
      <h3 className="settings-section-title fleet-policies-title-row">
        <span>Fleet Policies</span>
        <button
          className="btn-ghost fleet-policy-btn"
          disabled={busy}
          onClick={() => void fetchAll()}
        >
          Refresh
        </button>
      </h3>

      {!props.connected ? (
        <p className="doctor-hint">Connect to manage Fleet Policies.</p>
      ) : (
        <div className="fleet-policies-wrap">
          {message ? <p className="fleet-policies-msg">{message}</p> : null}

          <div className="fleet-policy-top-grid">
            <div className="fleet-policy-create">
              <h4 className="section-subtitle">Create Policy</h4>
              <div className="fleet-policy-presets">
                {PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    className="btn-ghost fleet-policy-btn"
                    disabled={busy}
                    onClick={() => setNewDraft(preset.draft)}
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
              <div className="fleet-policy-form-grid">
                <input
                  className="fleet-policy-input"
                  placeholder="Name"
                  value={newDraft.name}
                  onChange={(event) =>
                    setNewDraft((prev) => ({ ...prev, name: event.target.value }))
                  }
                />
                <input
                  className="fleet-policy-input"
                  placeholder="Min Bridge Version (optional)"
                  value={newDraft.minBridgeVersion}
                  onChange={(event) =>
                    setNewDraft((prev) => ({ ...prev, minBridgeVersion: event.target.value }))
                  }
                />
                <input
                  className="fleet-policy-input"
                  type="number"
                  min={1}
                  step={1000}
                  placeholder="Max Sync Lag (ms)"
                  value={newDraft.maxSyncLagMs}
                  onChange={(event) =>
                    setNewDraft((prev) => ({ ...prev, maxSyncLagMs: event.target.value }))
                  }
                />
                <select
                  className="fleet-policy-select"
                  value={newDraft.allowedAuthMode}
                  onChange={(event) =>
                    setNewDraft((prev) => ({
                      ...prev,
                      allowedAuthMode: event.target.value as AllowedAuthMode,
                    }))
                  }
                >
                  <option value="any">Auth: any</option>
                  <option value="token">Auth: token</option>
                  <option value="none">Auth: none</option>
                </select>
                <input
                  className="fleet-policy-input"
                  type="number"
                  min={0}
                  step={1}
                  placeholder="Max Consecutive Failures"
                  value={newDraft.maxConsecutiveFailures}
                  onChange={(event) =>
                    setNewDraft((prev) => ({
                      ...prev,
                      maxConsecutiveFailures: event.target.value,
                    }))
                  }
                />
                <button
                  className="btn-primary fleet-policy-btn"
                  disabled={busy}
                  onClick={() => void createPolicy()}
                >
                  Create Policy
                </button>
              </div>
            </div>

            <div className="fleet-policy-list">
              <h4 className="section-subtitle">Policies</h4>
              <div className="table-scroll">
                <table className="data-table compact">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Min Bridge</th>
                      <th>Max Lag (ms)</th>
                      <th>Auth</th>
                      <th>Max Failures</th>
                      <th>Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortedPolicies.length === 0 ? (
                      <tr>
                        <td colSpan={6} className="fleet-policy-empty-cell">
                          No policies found.
                        </td>
                      </tr>
                    ) : (
                      sortedPolicies.map((policy) => {
                        const isEditing = editingPolicyId === policy.id;
                        return (
                          <tr key={policy.id}>
                            <td>
                              {isEditing ? (
                                <input
                                  className="fleet-policy-input"
                                  value={editDraft.name}
                                  onChange={(event) =>
                                    setEditDraft((prev) => ({ ...prev, name: event.target.value }))
                                  }
                                />
                              ) : (
                                policy.name
                              )}
                            </td>
                            <td className="mono">
                              {isEditing ? (
                                <input
                                  className="fleet-policy-input"
                                  value={editDraft.minBridgeVersion}
                                  onChange={(event) =>
                                    setEditDraft((prev) => ({
                                      ...prev,
                                      minBridgeVersion: event.target.value,
                                    }))
                                  }
                                  placeholder="optional"
                                />
                              ) : (
                                (policy.minBridgeVersion ?? '-')
                              )}
                            </td>
                            <td className="mono">
                              {isEditing ? (
                                <input
                                  className="fleet-policy-input"
                                  type="number"
                                  min={1}
                                  step={1000}
                                  value={editDraft.maxSyncLagMs}
                                  onChange={(event) =>
                                    setEditDraft((prev) => ({
                                      ...prev,
                                      maxSyncLagMs: event.target.value,
                                    }))
                                  }
                                />
                              ) : (
                                String(policy.maxSyncLagMs)
                              )}
                            </td>
                            <td>
                              {isEditing ? (
                                <select
                                  className="fleet-policy-select"
                                  value={editDraft.allowedAuthMode}
                                  onChange={(event) =>
                                    setEditDraft((prev) => ({
                                      ...prev,
                                      allowedAuthMode: event.target.value as AllowedAuthMode,
                                    }))
                                  }
                                >
                                  <option value="any">any</option>
                                  <option value="token">token</option>
                                  <option value="none">none</option>
                                </select>
                              ) : (
                                policy.allowedAuthMode
                              )}
                            </td>
                            <td className="mono">
                              {isEditing ? (
                                <input
                                  className="fleet-policy-input"
                                  type="number"
                                  min={0}
                                  step={1}
                                  value={editDraft.maxConsecutiveFailures}
                                  onChange={(event) =>
                                    setEditDraft((prev) => ({
                                      ...prev,
                                      maxConsecutiveFailures: event.target.value,
                                    }))
                                  }
                                />
                              ) : (
                                String(policy.maxConsecutiveFailures)
                              )}
                            </td>
                            <td>
                              <div className="fleet-policy-actions">
                                {isEditing ? (
                                  <>
                                    <button
                                      className="btn-primary fleet-policy-btn"
                                      disabled={busy}
                                      onClick={() => void saveEdit()}
                                    >
                                      Save
                                    </button>
                                    <button
                                      className="btn-ghost fleet-policy-btn"
                                      onClick={() => setEditingPolicyId(null)}
                                    >
                                      Cancel
                                    </button>
                                  </>
                                ) : (
                                  <button
                                    className="btn-secondary fleet-policy-btn"
                                    onClick={() => startEdit(policy)}
                                  >
                                    Edit
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          </div>

          <div className="fleet-policy-targets">
            <div className="fleet-policy-targets-header">
              <h4 className="section-subtitle">Apply Policy to Targets</h4>
              <div className="fleet-policy-targets-controls">
                <label className="fleet-policy-checkbox">
                  <input
                    type="checkbox"
                    checked={showChangedOnly}
                    onChange={(event) => setShowChangedOnly(event.target.checked)}
                  />
                  Changed only
                </label>
                <label className="fleet-policy-checkbox">
                  <input
                    type="checkbox"
                    checked={reconcileAfterApply}
                    onChange={(event) => setReconcileAfterApply(event.target.checked)}
                  />
                  Reconcile after apply
                </label>
              </div>
            </div>
            <div className="fleet-summary-bar">
              <span className="fleet-summary-chip">{`visible ${String(visibleTargets.length)}`}</span>
              <span className="fleet-summary-chip">{`reported ${String(visibleReportedCount)}`}</span>
              <span className="fleet-summary-chip">{`unreported ${String(visibleUnreportedTargets.length)}`}</span>
              <span className="fleet-summary-chip">{`critical ${String(visibleCriticalCount)}`}</span>
            </div>
            <div className="fleet-policy-toolbar">
              <input
                className="fleet-policy-input fleet-policy-search"
                placeholder="Search target..."
                value={searchText}
                onChange={(event) => setSearchText(event.target.value)}
              />
              <select
                className="fleet-policy-select fleet-policy-risk-filter"
                value={riskFilter}
                onChange={(event) =>
                  setRiskFilter(
                    event.target.value as 'all' | 'medium_plus' | 'high_or_critical' | 'critical'
                  )
                }
              >
                <option value="all">Risk: all</option>
                <option value="medium_plus">Risk: medium+</option>
                <option value="high_or_critical">Risk: high/critical</option>
                <option value="critical">Risk: critical</option>
              </select>
              <select
                className="fleet-policy-select fleet-policy-risk-filter"
                value={reportedFilter}
                onChange={(event) =>
                  setReportedFilter(event.target.value as 'all' | 'reported' | 'unreported')
                }
              >
                <option value="all">Identity: all</option>
                <option value="reported">Identity: reported only</option>
                <option value="unreported">Identity: unreported only</option>
              </select>
              <div className="fleet-policy-batch-actions">
                <span className="fleet-policy-batch-count">
                  {`${String(selectedTargetIds.length)} selected`}
                </span>
                <button
                  className="btn-ghost fleet-policy-btn"
                  disabled={busy || visibleUnreportedTargets.length === 0}
                  onClick={selectVisibleUnreported}
                >
                  Select unreported
                </button>
                <button
                  className="btn-ghost fleet-policy-btn"
                  disabled={busy || visibleUnreportedTargets.length === 0}
                  onClick={() => void copyVisibleUnreportedIds()}
                >
                  Copy unreported IDs
                </button>
                <button
                  className="btn-ghost fleet-policy-btn"
                  disabled={busy}
                  onClick={clearSelection}
                >
                  Clear
                </button>
                <button
                  className="btn-secondary fleet-policy-btn"
                  disabled={busy || selectedTargetIds.length === 0}
                  onClick={() => void batchPreview()}
                >
                  Batch Preview
                </button>
                <button
                  className="btn-primary fleet-policy-btn"
                  disabled={busy || selectedTargetIds.length === 0}
                  onClick={requestBatchApply}
                >
                  Batch Apply
                </button>
              </div>
            </div>
            <div className="fleet-policy-guard-hint">
              {selectedWithoutPreviewCount > 0
                ? `${String(selectedWithoutPreviewCount)} selected target(s) need Preview before batch apply.`
                : selectedCriticalCount > BLAST_RADIUS_CRITICAL_LIMIT
                  ? `Potential high blast radius: ${String(selectedCriticalCount)} critical target(s) selected.`
                  : 'Guard active: preview required for changed targets before batch apply.'}
            </div>
            <div className="table-scroll">
              <table className="data-table compact">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        checked={allVisibleSelected}
                        onChange={(event) => toggleSelectAllVisible(event.target.checked)}
                      />
                    </th>
                    <th>Target</th>
                    <th>Type</th>
                    <th>Current Policy</th>
                    <th>Health</th>
                    <th>Risk</th>
                    <th>Apply</th>
                    <th>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleTargets.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="fleet-policy-empty-cell">
                        No targets match current filters.
                      </td>
                    </tr>
                  ) : (
                    visibleTargets.map((target) => {
                      const selectedPolicyId =
                        applyPolicyIdByTarget[target.targetId] ?? target.policyProfileId;
                      const policyChanged = selectedPolicyId !== target.policyProfileId;
                      const preview = previewByTarget[target.targetId];
                      const drifts = target.drifts ?? [];
                      const violations = target.violations ?? [];
                      return (
                        <Fragment key={target.targetId}>
                          <tr>
                            <td>
                              <input
                                type="checkbox"
                                checked={selectedByTarget[target.targetId] === true}
                                onChange={(event) =>
                                  toggleSelectTarget(target.targetId, event.target.checked)
                                }
                              />
                            </td>
                            <td>
                              {target.targetLabel}
                              <div style={{ marginTop: 4 }}>
                                <span
                                  className={`badge tone-${target.reported?.machineId ? 'ok' : 'warn'}`}
                                  title={
                                    target.reported?.machineId
                                      ? 'Reported machine identity from bridge telemetry'
                                      : 'No reported machine identity yet'
                                  }
                                >
                                  {target.reported?.machineId ? 'reported' : 'unreported'}
                                </span>
                              </div>
                              <div className="mono" style={{ fontSize: '0.72rem', opacity: 0.7 }}>
                                {target.targetId}
                              </div>
                              {target.reported?.machineId ? (
                                <div
                                  className="mono"
                                  style={{ fontSize: '0.68rem', opacity: 0.62 }}
                                >
                                  machine: {target.reported.machineId}
                                </div>
                              ) : null}
                            </td>
                            <td className="mono">{target.targetType}</td>
                            <td>{target.policyProfileName}</td>
                            <td className="mono">{String(target.healthScore)}</td>
                            <td>
                              <span
                                className={`badge tone-${
                                  target.riskLevel === 'low'
                                    ? 'ok'
                                    : target.riskLevel === 'medium'
                                      ? 'warn'
                                      : 'error'
                                }`}
                              >
                                {target.riskLevel}
                              </span>
                            </td>
                            <td>
                              <div className="fleet-policy-apply-controls">
                                <select
                                  className="fleet-policy-select"
                                  value={selectedPolicyId}
                                  onChange={(event) => {
                                    const nextPolicyId = event.target.value;
                                    setApplyPolicyIdByTarget((prev) => ({
                                      ...prev,
                                      [target.targetId]: nextPolicyId,
                                    }));
                                    setPreviewByTarget((prev) => ({
                                      ...prev,
                                      [target.targetId]: undefined,
                                    }));
                                    setApplyStatusByTarget((prev) => ({
                                      ...prev,
                                      [target.targetId]:
                                        nextPolicyId === target.policyProfileId
                                          ? '-'
                                          : 'Pending preview',
                                    }));
                                  }}
                                >
                                  {sortedPolicies.map((policy) => (
                                    <option key={policy.id} value={policy.id}>
                                      {policy.name}
                                    </option>
                                  ))}
                                </select>
                                <button
                                  className="btn-ghost fleet-policy-btn"
                                  disabled={busy}
                                  onClick={() => void previewPolicy(target.targetId)}
                                >
                                  Preview
                                </button>
                                <button
                                  className="btn-primary fleet-policy-btn"
                                  disabled={busy || !policyChanged}
                                  onClick={() => void applyPolicy(target.targetId)}
                                >
                                  Apply
                                </button>
                              </div>
                            </td>
                            <td className="fleet-policy-status-cell">
                              <div>
                                {applyStatusByTarget[target.targetId] ??
                                  (policyChanged ? 'Pending apply' : '-')}
                              </div>
                              {preview ? (
                                <div className="fleet-policy-preview-meta">
                                  {`risk ${preview.riskLevel}, score ${String(preview.healthScore)}, drifts ${String(preview.drifts.length)}, violations ${String(preview.violations.length)}`}
                                </div>
                              ) : null}
                              <button
                                className="btn-ghost fleet-policy-btn"
                                onClick={() =>
                                  setExpandedTargetId((prev) =>
                                    prev === target.targetId ? null : target.targetId
                                  )
                                }
                              >
                                {expandedTargetId === target.targetId ? 'Hide details' : 'Details'}
                              </button>
                            </td>
                          </tr>
                          {expandedTargetId === target.targetId ? (
                            <tr>
                              <td colSpan={8}>
                                <div className="fleet-row-details">
                                  <div className="fleet-row-details-column">
                                    <div className="fleet-row-details-title">
                                      {`Drifts (${String(drifts.length)})`}
                                    </div>
                                    {drifts.length === 0 ? (
                                      <div className="fleet-row-details-item">
                                        No drift records.
                                      </div>
                                    ) : (
                                      drifts.slice(0, 4).map((drift, index) => (
                                        <div
                                          key={`${target.targetId}:drift:${String(index)}`}
                                          className="fleet-row-details-item"
                                        >
                                          {`${drift.severity ?? 'unknown'} · ${drift.category ?? 'unknown'} · expected ${drift.expected ?? '-'} / actual ${drift.actual ?? '-'}`}
                                        </div>
                                      ))
                                    )}
                                  </div>
                                  <div className="fleet-row-details-column">
                                    <div className="fleet-row-details-title">
                                      {`Violations (${String(violations.length)})`}
                                    </div>
                                    {violations.length === 0 ? (
                                      <div className="fleet-row-details-item">
                                        No active violations.
                                      </div>
                                    ) : (
                                      violations.slice(0, 4).map((violation, index) => (
                                        <div
                                          key={
                                            violation.id ??
                                            `${target.targetId}:violation:${String(index)}`
                                          }
                                          className="fleet-row-details-item"
                                        >
                                          {`${violation.severity ?? 'unknown'} · ${violation.code ?? 'unknown'} · ${violation.message ?? '-'}`}
                                        </div>
                                      ))
                                    )}
                                  </div>
                                </div>
                              </td>
                            </tr>
                          ) : null}
                        </Fragment>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {showBlastConfirm ? (
        <ConfirmDialog
          title="High Blast Radius"
          message={`You selected ${String(pendingApprovalCriticalCount)} critical target(s). Continue batch apply with approval?`}
          variant="warn"
          confirmLabel="Apply Anyway"
          onCancel={() => {
            setShowBlastConfirm(false);
            setPendingApprovalToken(null);
          }}
          onConfirm={() => {
            setShowBlastConfirm(false);
            void executeBatchApply(pendingApprovalToken ?? undefined);
          }}
        />
      ) : null}
    </div>
  );
}
