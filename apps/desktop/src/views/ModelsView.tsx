import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { IconEdit, IconPlus, IconTrash } from '../components/Icons';
import { useTargetScopedQuery } from '../features/openclaw/data/useTargetScopedQuery';
import { OpenClawPageState } from '../features/openclaw/ui/OpenClawPageState';
import { TargetLockBadge } from '../features/openclaw/ui/TargetLockBadge';
import type { OpenClawModelProfile } from '@patze/telemetry-core';
import { emitConfigChanged, onConfigChanged } from '../utils/openclaw-events';
import { CreateModelDialog } from './models/CreateModelDialog';
import { EditModelDialog } from './models/EditModelDialog';

export interface ModelsViewProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly connected: boolean;
  readonly targetId: string | null;
}

interface ModelsViewData {
  readonly models: readonly OpenClawModelProfile[];
  readonly defaultPrimary: string | null;
  readonly fallbacks: readonly string[];
  readonly aliases: Readonly<Record<string, string>>;
  readonly referencedModelIds: readonly string[];
}

type ReferenceFilter = 'all' | 'missing' | 'primary' | 'fallback';

function parseReferenceModelId(id: string): { provider: string; model: string } | null {
  const [providerRaw, modelRaw] = id.split('/');
  const provider = providerRaw?.trim() ?? '';
  const model = modelRaw?.trim() ?? '';
  if (!provider || !model) return null;
  return { provider, model };
}

function parseModelContext(
  rawConfig: string | null
): Pick<ModelsViewData, 'defaultPrimary' | 'fallbacks' | 'aliases' | 'referencedModelIds'> {
  if (!rawConfig) {
    return { defaultPrimary: null, fallbacks: [], aliases: {}, referencedModelIds: [] };
  }
  try {
    const parsed = JSON.parse(rawConfig) as unknown;
    if (!parsed || typeof parsed !== 'object') {
      return { defaultPrimary: null, fallbacks: [], aliases: {}, referencedModelIds: [] };
    }
    const asRecord = parsed as Record<string, unknown>;
    const agents = asRecord.agents;
    if (!agents || typeof agents !== 'object') {
      return { defaultPrimary: null, fallbacks: [], aliases: {}, referencedModelIds: [] };
    }
    const defaults = (agents as Record<string, unknown>).defaults;
    if (!defaults || typeof defaults !== 'object') {
      return { defaultPrimary: null, fallbacks: [], aliases: {}, referencedModelIds: [] };
    }
    const model = (defaults as Record<string, unknown>).model;
    const defaultPrimary =
      model &&
      typeof model === 'object' &&
      typeof (model as Record<string, unknown>).primary === 'string'
        ? ((model as Record<string, unknown>).primary as string)
        : null;
    const fallbackRaw =
      model && typeof model === 'object' ? (model as Record<string, unknown>).fallbacks : undefined;
    const fallbackSingleRaw =
      model && typeof model === 'object' ? (model as Record<string, unknown>).fallback : undefined;
    const fallbackFromArray = Array.isArray(fallbackRaw)
      ? fallbackRaw.filter(
          (item): item is string => typeof item === 'string' && item.trim().length > 0
        )
      : [];
    const fallbackSingle =
      typeof fallbackSingleRaw === 'string' && fallbackSingleRaw.trim().length > 0
        ? [fallbackSingleRaw]
        : [];
    const fallbacks = [...new Set([...fallbackFromArray, ...fallbackSingle])];

    const modelMapRaw = (defaults as Record<string, unknown>).models;
    const aliases: Record<string, string> = {};
    const referencedFromDefaultsModels: string[] = [];
    if (modelMapRaw && typeof modelMapRaw === 'object') {
      for (const [modelId, value] of Object.entries(modelMapRaw as Record<string, unknown>)) {
        if (modelId.trim().length > 0) {
          referencedFromDefaultsModels.push(modelId);
        }
        if (!value || typeof value !== 'object') continue;
        const alias = (value as Record<string, unknown>).alias;
        if (typeof alias === 'string' && alias.trim().length > 0) {
          aliases[modelId] = alias.trim();
        }
      }
    }
    const referencedModelIds = [
      ...new Set([
        ...(defaultPrimary ? [defaultPrimary] : []),
        ...fallbacks,
        ...referencedFromDefaultsModels,
      ]),
    ];
    return { defaultPrimary, fallbacks, aliases, referencedModelIds };
  } catch {
    return { defaultPrimary: null, fallbacks: [], aliases: {}, referencedModelIds: [] };
  }
}

export function ModelsView(props: ModelsViewProps): JSX.Element {
  const { baseUrl, token, connected, targetId } = props;
  const [showCreate, setShowCreate] = useState(false);
  const [createPrefill, setCreatePrefill] = useState<{
    provider: string;
    model: string;
    name?: string | undefined;
  } | null>(null);
  const [editModel, setEditModel] = useState<OpenClawModelProfile | null>(null);
  const [pendingMutation, setPendingMutation] = useState(false);
  const [mutationError, setMutationError] = useState<string | null>(null);
  const [referenceFilter, setReferenceFilter] = useState<ReferenceFilter>('all');
  const [showAllMissing, setShowAllMissing] = useState(false);
  const [confirmState, setConfirmState] = useState<{
    title: string;
    message: string;
    onConfirm: () => void;
  } | null>(null);
  const modelsQuery = useTargetScopedQuery<ModelsViewData>({
    connected,
    selectedTargetId: targetId,
    queryFn: async ({ targetId: scopedTargetId, signal }) => {
      const headers = token ? { Authorization: `Bearer ${token}` } : {};
      const [modelsRes, rawConfigRes] = await Promise.all([
        fetch(`${baseUrl}/openclaw/targets/${encodeURIComponent(scopedTargetId)}/models`, {
          headers,
          signal,
        }),
        fetch(`${baseUrl}/openclaw/targets/${encodeURIComponent(scopedTargetId)}/config-raw`, {
          headers,
          signal,
        }),
      ]);
      if (!modelsRes.ok) {
        throw new Error(`Failed to load models (HTTP ${modelsRes.status})`);
      }
      const modelsData = (await modelsRes.json()) as { models?: OpenClawModelProfile[] };
      const rawData = rawConfigRes.ok
        ? ((await rawConfigRes.json()) as { raw?: string | null })
        : { raw: null };
      const parsedContext = parseModelContext(rawData.raw ?? null);
      return {
        models: modelsData.models ?? [],
        defaultPrimary: parsedContext.defaultPrimary,
        fallbacks: parsedContext.fallbacks,
        aliases: parsedContext.aliases,
        referencedModelIds: parsedContext.referencedModelIds,
      };
    },
    isEmpty: (data) => data.models.length === 0,
  });
  const models = modelsQuery.data?.models ?? [];
  const defaultPrimary = modelsQuery.data?.defaultPrimary ?? null;
  const fallbackModels = modelsQuery.data?.fallbacks ?? [];
  const modelAliases = modelsQuery.data?.aliases ?? {};
  const referencedModelIds = modelsQuery.data?.referencedModelIds ?? [];
  const profiledIds = new Set(models.map((model) => model.id));
  const referenceRows = useMemo(
    () =>
      referencedModelIds.map((id) => ({
        id,
        profiled: profiledIds.has(id),
        alias: modelAliases[id],
        isPrimary: defaultPrimary === id,
        isFallback: fallbackModels.includes(id),
      })),
    [defaultPrimary, fallbackModels, modelAliases, profiledIds, referencedModelIds]
  );
  const profiledReferenceCount = referenceRows.filter((item) => item.profiled).length;
  const missingReferenceRows = referenceRows.filter((item) => !item.profiled);
  const profiledReferenceRows = referenceRows.filter((item) => item.profiled);
  const filteredReferenceRows = referenceRows.filter((item) => {
    switch (referenceFilter) {
      case 'all':
        return true;
      case 'missing':
        return !item.profiled;
      case 'primary':
        return item.isPrimary;
      case 'fallback':
        return item.isFallback;
      default: {
        const exhaustive: never = referenceFilter;
        return exhaustive;
      }
    }
  });
  const visibleMissingRows = showAllMissing
    ? missingReferenceRows
    : missingReferenceRows.slice(0, 5);
  const refreshModelsRef = useRef(modelsQuery.refresh);
  refreshModelsRef.current = modelsQuery.refresh;

  useEffect(() => {
    return onConfigChanged(() => void refreshModelsRef.current());
  }, []);

  useEffect(() => {
    setReferenceFilter('all');
    setShowAllMissing(false);
    setCreatePrefill(null);
  }, [targetId]);

  const performMutation = useCallback(
    async (requestFactory: () => Promise<Response>): Promise<boolean> => {
      if (!targetId) return false;
      if (pendingMutation) {
        setMutationError('Please wait for the current update to finish.');
        return false;
      }
      setPendingMutation(true);
      setMutationError(null);
      try {
        const response = await requestFactory();
        if (!response.ok) {
          const payload = (await response.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? `Request failed (HTTP ${response.status})`);
        }
        await modelsQuery.refresh();
        emitConfigChanged();
        return true;
      } catch (error) {
        setMutationError(
          error instanceof Error ? error.message : 'Failed to update model configuration.'
        );
        return false;
      } finally {
        setPendingMutation(false);
      }
    },
    [modelsQuery, pendingMutation, targetId]
  );

  const handleCreate = useCallback(
    (data: {
      id: string;
      name: string;
      provider: string;
      model: string;
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
    }) => {
      void performMutation(() =>
        fetch(`${baseUrl}/openclaw/targets/${encodeURIComponent(targetId ?? '')}/models`, {
          method: 'POST',
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(data),
        })
      ).then((ok) => {
        if (ok) setShowCreate(false);
      });
    },
    [baseUrl, performMutation, targetId, token]
  );

  const handleDelete = useCallback(
    (modelId: string) => {
      void performMutation(() =>
        fetch(
          `${baseUrl}/openclaw/targets/${encodeURIComponent(targetId ?? '')}/models/${encodeURIComponent(modelId)}`,
          {
            method: 'DELETE',
            headers: token ? { Authorization: `Bearer ${token}` } : {},
          }
        )
      );
    },
    [baseUrl, performMutation, targetId, token]
  );

  const handleSetDefault = useCallback(
    (modelId: string) => {
      void performMutation(() =>
        fetch(`${baseUrl}/openclaw/targets/${encodeURIComponent(targetId ?? '')}/models/default`, {
          method: 'POST',
          headers: {
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ primary: modelId }),
        })
      );
    },
    [baseUrl, performMutation, targetId, token]
  );

  const handleToggle = useCallback(
    (modelId: string, currentEnabled: boolean) => {
      void performMutation(() =>
        fetch(
          `${baseUrl}/openclaw/targets/${encodeURIComponent(targetId ?? '')}/models/${encodeURIComponent(modelId)}`,
          {
            method: 'PATCH',
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ enabled: !currentEnabled }),
          }
        )
      );
    },
    [baseUrl, performMutation, targetId, token]
  );

  const handleEditSubmit = useCallback(
    (data: {
      name: string;
      provider: string;
      model: string;
      apiKey: string;
      baseUrl: string;
      enabled: boolean;
    }) => {
      if (!editModel) return;
      void performMutation(() =>
        fetch(
          `${baseUrl}/openclaw/targets/${encodeURIComponent(targetId ?? '')}/models/${encodeURIComponent(editModel.id)}`,
          {
            method: 'PATCH',
            headers: {
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(data),
          }
        )
      ).then((ok) => {
        if (ok) setEditModel(null);
      });
    },
    [baseUrl, editModel, performMutation, targetId, token]
  );

  const handleEditDelete = useCallback(() => {
    if (!editModel) return;
    handleDelete(editModel.id);
    setEditModel(null);
  }, [editModel, handleDelete]);

  const canMutate =
    (modelsQuery.state === 'ready' || modelsQuery.state === 'empty') && Boolean(targetId);

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Model Profiles</h2>
        <TargetLockBadge targetId={targetId} />
        {pendingMutation ? <span className="badge tone-warn">queue pending</span> : null}
        {modelsQuery.state === 'ready' || modelsQuery.state === 'empty' ? (
          <button
            type="button"
            className="btn-ghost"
            onClick={() => {
              void modelsQuery.refresh();
            }}
            disabled={pendingMutation}
          >
            Refresh
          </button>
        ) : null}
        {canMutate ? (
          <button
            type="button"
            className="dialog-btn-primary ml-auto"
            onClick={() => {
              setCreatePrefill(null);
              setShowCreate(true);
            }}
          >
            <IconPlus width={14} height={14} /> Add Model
          </button>
        ) : null}
      </div>
      {modelsQuery.state === 'ready' || modelsQuery.state === 'empty' ? (
        <div className="model-context-strip">
          <span className="model-context-pill">
            default: <strong>{defaultPrimary ?? 'not set'}</strong>
          </span>
          <span className="model-context-pill">
            fallback: <strong>{fallbackModels.length}</strong>
          </span>
          <span className="model-context-pill">
            referenced: <strong>{referencedModelIds.length}</strong>
          </span>
        </div>
      ) : null}
      {modelsQuery.state === 'ready' || modelsQuery.state === 'empty' ? (
        <section className="model-reference-panel">
          <div className="model-reference-head">
            <h3>Referenced Models</h3>
            <span>
              {profiledReferenceCount}/{referenceRows.length} profiled
            </span>
          </div>
          <div className="model-reference-filters">
            <button
              type="button"
              className={`model-reference-filter-btn${referenceFilter === 'all' ? ' is-active' : ''}`}
              onClick={() => setReferenceFilter('all')}
            >
              All
            </button>
            <button
              type="button"
              className={`model-reference-filter-btn${referenceFilter === 'missing' ? ' is-active' : ''}`}
              onClick={() => setReferenceFilter('missing')}
            >
              Needs Profiling ({missingReferenceRows.length})
            </button>
            <button
              type="button"
              className={`model-reference-filter-btn${referenceFilter === 'primary' ? ' is-active' : ''}`}
              onClick={() => setReferenceFilter('primary')}
            >
              Primary
            </button>
            <button
              type="button"
              className={`model-reference-filter-btn${referenceFilter === 'fallback' ? ' is-active' : ''}`}
              onClick={() => setReferenceFilter('fallback')}
            >
              Fallback
            </button>
          </div>
          {referenceRows.length === 0 ? (
            <div className="model-reference-empty">
              No default/fallback model references detected.
            </div>
          ) : (
            <>
              {referenceFilter === 'all' ? (
                <>
                  <div className="model-reference-subhead">
                    <h4>Needs Profiling</h4>
                    <span>{missingReferenceRows.length}</span>
                  </div>
                  {visibleMissingRows.length > 0 ? (
                    <div className="model-reference-list">
                      {visibleMissingRows.map((row) => {
                        const parsed = parseReferenceModelId(row.id);
                        return (
                          <div
                            key={row.id}
                            className="model-reference-item model-reference-item-attention"
                          >
                            <span className="mono">{row.id}</span>
                            {row.alias ? (
                              <span className="badge tone-neutral">alias: {row.alias}</span>
                            ) : null}
                            {row.isPrimary ? (
                              <span className="badge tone-good">primary</span>
                            ) : null}
                            {row.isFallback ? (
                              <span className="badge tone-warn">fallback</span>
                            ) : null}
                            <span className="badge tone-muted">reference-only</span>
                            {parsed ? (
                              <button
                                type="button"
                                className="card-action-btn model-inline-action"
                                onClick={() => {
                                  setCreatePrefill({
                                    provider: parsed.provider,
                                    model: parsed.model,
                                    ...(row.alias ? { name: row.alias } : {}),
                                  });
                                  setShowCreate(true);
                                }}
                              >
                                Create Profile
                              </button>
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="model-reference-empty">
                      All referenced models already profiled.
                    </div>
                  )}
                  {!showAllMissing && missingReferenceRows.length > visibleMissingRows.length ? (
                    <button
                      type="button"
                      className="btn-ghost model-reference-showmore"
                      onClick={() => setShowAllMissing(true)}
                    >
                      Show {missingReferenceRows.length - visibleMissingRows.length} more
                    </button>
                  ) : null}
                  {showAllMissing && missingReferenceRows.length > 5 ? (
                    <button
                      type="button"
                      className="btn-ghost model-reference-showmore"
                      onClick={() => setShowAllMissing(false)}
                    >
                      Collapse list
                    </button>
                  ) : null}

                  <div className="model-reference-subhead">
                    <h4>Already Profiled</h4>
                    <span>{profiledReferenceRows.length}</span>
                  </div>
                  <div className="model-reference-list">
                    {profiledReferenceRows.map((row) => (
                      <div key={row.id} className="model-reference-item">
                        <span className="mono">{row.id}</span>
                        {row.alias ? (
                          <span className="badge tone-neutral">alias: {row.alias}</span>
                        ) : null}
                        {row.isPrimary ? <span className="badge tone-good">primary</span> : null}
                        {row.isFallback ? <span className="badge tone-warn">fallback</span> : null}
                        <span className="badge tone-good">profiled</span>
                        {!row.isPrimary ? (
                          <button
                            type="button"
                            className="card-action-btn model-inline-action"
                            onClick={() => handleSetDefault(row.id)}
                          >
                            Set Default
                          </button>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <div className="model-reference-list">
                  {filteredReferenceRows.map((row) => {
                    const parsed = parseReferenceModelId(row.id);
                    return (
                      <div
                        key={row.id}
                        className={`model-reference-item${row.profiled ? '' : ' model-reference-item-attention'}`}
                      >
                        <span className="mono">{row.id}</span>
                        {row.alias ? (
                          <span className="badge tone-neutral">alias: {row.alias}</span>
                        ) : null}
                        {row.isPrimary ? <span className="badge tone-good">primary</span> : null}
                        {row.isFallback ? <span className="badge tone-warn">fallback</span> : null}
                        <span className={`badge ${row.profiled ? 'tone-good' : 'tone-muted'}`}>
                          {row.profiled ? 'profiled' : 'reference-only'}
                        </span>
                        {!row.profiled && parsed ? (
                          <button
                            type="button"
                            className="card-action-btn model-inline-action"
                            onClick={() => {
                              setCreatePrefill({
                                provider: parsed.provider,
                                model: parsed.model,
                                ...(row.alias ? { name: row.alias } : {}),
                              });
                              setShowCreate(true);
                            }}
                          >
                            Create Profile
                          </button>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </section>
      ) : null}
      {mutationError ? (
        <div className="error-banner-smart" role="alert">
          <span className="error-banner-smart-icon">!</span>
          <span className="error-banner-smart-msg">{mutationError}</span>
        </div>
      ) : null}

      {modelsQuery.state === 'notReady' ||
      modelsQuery.state === 'noTarget' ||
      modelsQuery.state === 'loading' ? (
        <OpenClawPageState kind={modelsQuery.state} featureName="model profiles" />
      ) : modelsQuery.state === 'error' ? (
        <OpenClawPageState
          kind="error"
          featureName="model profiles"
          errorMessage={modelsQuery.errorMessage}
        />
      ) : modelsQuery.state === 'empty' ? (
        <OpenClawPageState kind="empty" featureName="model profiles" />
      ) : (
        <div className="machine-grid">
          {models.map((model) => (
            <div key={model.id} className="machine-card">
              <div className="machine-card-header">
                <div className="machine-card-title">
                  <span className={`model-provider-dot model-provider-${model.provider}`} />
                  <span className="machine-card-name">{model.name || model.id}</span>
                  {defaultPrimary === model.id ? (
                    <span className="badge tone-good">default</span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className={`badge-toggle ${model.enabled ? 'badge-toggle-on' : 'badge-toggle-off'}`}
                  onClick={() => handleToggle(model.id, model.enabled)}
                  title={model.enabled ? 'Click to disable' : 'Click to enable'}
                >
                  {model.enabled ? 'enabled' : 'disabled'}
                </button>
              </div>
              <div className="machine-card-meta">
                <div className="machine-card-meta-item">
                  <span className="machine-card-meta-label">Provider</span>
                  <span className="machine-card-meta-value">{model.provider}</span>
                </div>
                <div className="machine-card-meta-item">
                  <span className="machine-card-meta-label">Model</span>
                  <span className="machine-card-meta-value">{model.model}</span>
                </div>
                <div className="machine-card-meta-item">
                  <span className="machine-card-meta-label">API Key</span>
                  <span className="machine-card-meta-value">
                    {model.apiKey ? 'configured in provider' : 'managed via auth profile'}
                  </span>
                </div>
                {model.baseUrl ? (
                  <div className="machine-card-meta-item">
                    <span className="machine-card-meta-label">Base URL</span>
                    <span className="machine-card-meta-value model-base-url">{model.baseUrl}</span>
                  </div>
                ) : null}
                {modelAliases[model.id] ? (
                  <div className="machine-card-meta-item">
                    <span className="machine-card-meta-label">Alias</span>
                    <span className="machine-card-meta-value">{modelAliases[model.id]}</span>
                  </div>
                ) : null}
              </div>
              <div className="model-card-actions">
                <button
                  type="button"
                  className="card-action-btn"
                  onClick={() => setEditModel(model)}
                  title="Edit model"
                >
                  <IconEdit width={13} height={13} /> Edit
                </button>
                <button
                  type="button"
                  className="card-action-btn"
                  onClick={() => handleSetDefault(model.id)}
                  title="Set as default model"
                >
                  Set Default
                </button>
                <button
                  type="button"
                  className="card-action-btn card-action-danger"
                  onClick={() =>
                    setConfirmState({
                      title: 'Delete Model',
                      message: `Remove model "${model.name || model.id}" from OpenClaw config?`,
                      onConfirm: () => {
                        setConfirmState(null);
                        handleDelete(model.id);
                      },
                    })
                  }
                  title="Remove model"
                >
                  <IconTrash width={13} height={13} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showCreate ? (
        <CreateModelDialog
          onSubmit={handleCreate}
          initialProvider={createPrefill?.provider}
          initialModel={createPrefill?.model}
          initialName={createPrefill?.name}
          onClose={() => {
            setShowCreate(false);
            setCreatePrefill(null);
          }}
        />
      ) : null}

      {editModel ? (
        <EditModelDialog
          model={editModel}
          onSubmit={handleEditSubmit}
          onDelete={handleEditDelete}
          onClose={() => setEditModel(null)}
        />
      ) : null}

      {confirmState ? (
        <ConfirmDialog
          title={confirmState.title}
          message={confirmState.message}
          variant="danger"
          confirmLabel="Delete"
          onConfirm={confirmState.onConfirm}
          onCancel={() => setConfirmState(null)}
        />
      ) : null}
    </section>
  );
}
