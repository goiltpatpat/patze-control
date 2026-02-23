import type { RecipeParam } from '@patze/telemetry-core';

export interface ParamFormProps {
  readonly params: readonly RecipeParam[];
  readonly values: Record<string, unknown>;
  readonly onChange: (values: Record<string, unknown>) => void;
}

export function ParamForm(props: ParamFormProps): JSX.Element {
  const { params, values, onChange } = props;

  const updateValue = (id: string, value: unknown): void => {
    onChange({ ...values, [id]: value });
  };

  return (
    <div className="dialog-form-grid">
      {params.map((param) => {
        const val = values[param.id] ?? param.defaultValue ?? '';

        switch (param.type) {
          case 'boolean':
            return (
              <label key={param.id} className="dialog-form-label dialog-form-toggle">
                <input
                  type="checkbox"
                  checked={Boolean(val)}
                  onChange={(e) => updateValue(param.id, e.target.checked)}
                />
                {param.label}
                {param.required ? ' *' : ''}
              </label>
            );

          case 'select':
            return (
              <label key={param.id} className="dialog-form-label">
                {param.label}
                {param.required ? ' *' : ''}
                {param.description ? (
                  <span className="dialog-form-hint">{param.description}</span>
                ) : null}
                <select
                  className="dialog-form-select"
                  value={String(val)}
                  onChange={(e) => updateValue(param.id, e.target.value)}
                >
                  <option value="">-- Select --</option>
                  {(param.options ?? []).map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            );

          case 'number':
            return (
              <label key={param.id} className="dialog-form-label">
                {param.label}
                {param.required ? ' *' : ''}
                {param.description ? (
                  <span className="dialog-form-hint">{param.description}</span>
                ) : null}
                <input
                  type="number"
                  className="dialog-form-input"
                  value={String(val)}
                  onChange={(e) => updateValue(param.id, Number(e.target.value))}
                />
              </label>
            );

          default:
            return (
              <label key={param.id} className="dialog-form-label">
                {param.label}
                {param.required ? ' *' : ''}
                {param.description ? (
                  <span className="dialog-form-hint">{param.description}</span>
                ) : null}
                <input
                  type="text"
                  className="dialog-form-input"
                  value={String(val)}
                  onChange={(e) => updateValue(param.id, e.target.value)}
                  placeholder={param.description ?? ''}
                />
              </label>
            );
        }
      })}
    </div>
  );
}
