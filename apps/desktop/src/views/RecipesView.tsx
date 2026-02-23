import { useState, useEffect, useCallback } from 'react';
import { IconBook } from '../components/Icons';
import type { RecipeDefinition } from '@patze/telemetry-core';
import { CookWizard } from './recipes/CookWizard';

export interface RecipesViewProps {
  readonly baseUrl: string;
  readonly token: string;
  readonly connected: boolean;
  readonly targetId: string | null;
}

const DIFFICULTY_COLORS: Record<string, string> = {
  beginner: '#44bb77',
  intermediate: '#dd9944',
  advanced: '#dd4455',
};

export function RecipesView(props: RecipesViewProps): JSX.Element {
  const { baseUrl, token, connected } = props;
  const [recipes, setRecipes] = useState<readonly RecipeDefinition[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedRecipe, setSelectedRecipe] = useState<RecipeDefinition | null>(null);
  const [tagFilter, setTagFilter] = useState<string | null>(null);

  useEffect(() => {
    if (!connected) return;
    let active = true;
    void (async () => {
      try {
        const res = await fetch(`${baseUrl}/recipes`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (res.ok && active) {
          const data = (await res.json()) as { recipes: RecipeDefinition[] };
          setRecipes(data.recipes);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => { active = false; };
  }, [baseUrl, token, connected]);

  const allTags = Array.from(new Set(recipes.flatMap((r) => r.tags)));

  const filtered = recipes.filter((r) => {
    if (tagFilter && !r.tags.includes(tagFilter)) return false;
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      return r.name.toLowerCase().includes(q) || r.description.toLowerCase().includes(q) || r.tags.some((t) => t.includes(q));
    }
    return true;
  });

  const handleCook = useCallback(
    async (recipeId: string, params: Record<string, unknown>) => {
      if (!props.targetId) return;
      try {
        const resolveRes = await fetch(`${baseUrl}/recipes/${encodeURIComponent(recipeId)}/resolve`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ params }),
        });
        if (!resolveRes.ok) return;
        const { commands } = (await resolveRes.json()) as {
          commands: { command: string; args: string[]; description: string }[];
        };
        await fetch(`${baseUrl}/openclaw/queue`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ targetId: props.targetId, commands }),
        });
      } catch {
        /* ignore */
      }
      setSelectedRecipe(null);
    },
    [baseUrl, token, props.targetId]
  );

  return (
    <section className="view-panel">
      <div className="view-header">
        <h2 className="view-title">Recipes</h2>
      </div>

      {!connected ? (
        <div className="empty-state">
          <div className="empty-state-icon"><IconBook width={28} height={28} /></div>
          <p>Connect to load recipes.</p>
        </div>
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
                  onClick={() => setSelectedRecipe(recipe)}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedRecipe(recipe); } }}
                >
                  <div className="machine-card-header">
                    <div className="machine-card-title">
                      <span className="machine-card-name">{recipe.name}</span>
                    </div>
                    <span
                      className="badge"
                      style={{ background: DIFFICULTY_COLORS[recipe.difficulty] ?? '#888', color: '#fff' }}
                    >
                      {recipe.difficulty}
                    </span>
                  </div>
                  <p className="recipe-description">{recipe.description}</p>
                  <div className="recipe-tags-row">
                    {recipe.tags.map((tag) => (
                      <span key={tag} className="recipe-tag">{tag}</span>
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
          onCook={(params) => void handleCook(selectedRecipe.id, params)}
          onClose={() => setSelectedRecipe(null)}
        />
      ) : null}
    </section>
  );
}
