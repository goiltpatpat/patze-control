import { useState } from 'react';
import { useTargetScopedQuery } from '../features/openclaw/data/useTargetScopedQuery';
import { OpenClawPageState } from '../features/openclaw/ui/OpenClawPageState';
import { TargetLockBadge } from '../features/openclaw/ui/TargetLockBadge';
import { navigate } from '../shell/routes';
import type { RecipeDefinition } from '@patze/telemetry-core';
import { CookWizard } from './recipes/CookWizard';

export interface RecipesViewProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly connected: boolean;
  readonly targetId: string | null;
}

export function RecipesView(props: RecipesViewProps): JSX.Element {
  const { baseUrl, token, connected } = props;
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRecipe, setSelectedRecipe] = useState<RecipeDefinition | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const recipesQuery = useTargetScopedQuery<readonly RecipeDefinition[]>({
    connected,
    selectedTargetId: props.targetId,
    queryFn: async ({ signal }) => {
      const res = await fetch(`${baseUrl}/recipes`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (!res.ok) {
        throw new Error(`Failed to load recipes (HTTP ${res.status})`);
      }
      const data = (await res.json()) as { recipes?: RecipeDefinition[] };
      return data.recipes ?? [];
    },
    isEmpty: (recipes) => recipes.length === 0,
  });
  const recipes = recipesQuery.data ?? [];

  const allTags = Array.from(new Set(recipes.flatMap((r) => r.tags)));

  const filtered = recipes.filter((r) => {
    if (tagFilter && !r.tags.includes(tagFilter)) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return (
        r.name.toLowerCase().includes(q) ||
        r.description.toLowerCase().includes(q) ||
        r.tags.some((t) => t.includes(q))
      );
    }
    return true;
  });

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Recipes</h2>
        <TargetLockBadge targetId={props.targetId} />
      </div>

      {recipesQuery.state === 'notReady' ? (
        <OpenClawPageState kind="notReady" featureName="recipes" />
      ) : recipesQuery.state === 'noTarget' ? (
        <OpenClawPageState kind="noTarget" featureName="recipes" />
      ) : recipesQuery.state === 'loading' ? (
        <OpenClawPageState kind="loading" featureName="recipes" />
      ) : recipesQuery.state === 'error' ? (
        <OpenClawPageState
          kind="error"
          featureName="recipes"
          errorMessage={recipesQuery.errorMessage}
        />
      ) : recipesQuery.state === 'empty' ? (
        <OpenClawPageState kind="empty" featureName="recipes" />
      ) : (
        <>
          <div className="recipes-toolbar">
            <input
              type="text"
              className="dialog-form-input"
              placeholder="Search recipes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ maxWidth: 260 }}
            />
            <div className="recipes-tags">
              <button
                type="button"
                className={`recipe-tag-btn${tagFilter === null ? ' active' : ''}`}
                onClick={() => setTagFilter(null)}
              >
                All
              </button>
              {allTags.map((tag) => (
                <button
                  key={tag}
                  type="button"
                  className={`recipe-tag-btn${tagFilter === tag ? ' active' : ''}`}
                  onClick={() => setTagFilter(tagFilter === tag ? null : tag)}
                >
                  {tag}
                </button>
              ))}
            </div>
          </div>

          {filtered.length === 0 ? (
            <div className="empty-state">No recipes match your search.</div>
          ) : (
            <div className="machine-grid">
              {filtered.map((recipe) => (
                <div
                  key={recipe.id}
                  className="machine-card machine-card-clickable"
                  role="button"
                  tabIndex={0}
                  onClick={() => {
                    if (!props.targetId) return;
                    setSelectedRecipe(recipe);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      if (!props.targetId) return;
                      setSelectedRecipe(recipe);
                    }
                  }}
                >
                  <div className="machine-card-header">
                    <div className="machine-card-title">
                      <span className="machine-card-name">{recipe.name}</span>
                    </div>
                    <span className={`badge recipe-difficulty-${recipe.difficulty}`}>
                      {recipe.difficulty}
                    </span>
                  </div>
                  <p className="recipe-description">{recipe.description}</p>
                  <div className="recipe-tags-row">
                    {recipe.tags.map((tag) => (
                      <span key={tag} className="recipe-tag">
                        {tag}
                      </span>
                    ))}
                  </div>
                  <div className="machine-card-meta">
                    <div className="machine-card-meta-item">
                      <span className="machine-card-meta-label">Steps</span>
                      <span className="machine-card-meta-value">{recipe.steps.length}</span>
                    </div>
                    <div className="machine-card-meta-item">
                      <span className="machine-card-meta-label">Params</span>
                      <span className="machine-card-meta-value">{recipe.params.length}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {selectedRecipe ? (
        <CookWizard
          recipe={selectedRecipe}
          baseUrl={baseUrl}
          token={token}
          targetId={props.targetId}
          onOpenRollback={() => navigate('tasks')}
          onClose={() => setSelectedRecipe(null)}
        />
      ) : null}
    </section>
  );
}
