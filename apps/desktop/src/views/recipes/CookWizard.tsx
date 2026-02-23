import { useState, useCallback } from 'react';
import type { RecipeDefinition } from '@patze/telemetry-core';
import { ParamForm } from './ParamForm';

export interface CookWizardProps {
  readonly recipe: RecipeDefinition;
  readonly onCook: (params: Record<string, unknown>) => void;
  readonly onClose: () => void;
}

type WizardStep = 'params' | 'review' | 'done';

export function CookWizard(props: CookWizardProps): JSX.Element {
  const { recipe } = props;
  const [step, setStep] = useState<WizardStep>('params');
  const [params, setParams] = useState<Record<string, unknown>>({});

  const resolvedSteps = recipe.steps.map((s) => {
    const resolvedArgs: Record<string, string> = {};
    for (const [key, template] of Object.entries(s.args)) {
      let resolved = template;
      for (const [paramId, paramValue] of Object.entries(params)) {
        resolved = resolved.replace(`{{${paramId}}}`, String(paramValue));
      }
      resolvedArgs[key] = resolved;
    }
    return { ...s, args: resolvedArgs };
  });

  const handleNext = useCallback(() => {
    if (step === 'params') {
      for (const param of recipe.params) {
        if (param.required && !params[param.id]) return;
      }
      setStep('review');
    } else if (step === 'review') {
      props.onCook(params);
      setStep('done');
    }
  }, [step, params, recipe.params, props.onCook]);

  return (
    <div className="office-interaction-overlay" onClick={props.onClose}>
      <div
        className="office-interaction-modal"
        style={{ maxWidth: 580, width: '92vw' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="office-interaction-modal-header">
          <h3>{recipe.name}</h3>
          <button
            type="button"
            className="office-agent-panel-close"
            aria-label="Close"
            onClick={props.onClose}
          >
            &times;
          </button>
        </div>

        <div className="wizard-steps-indicator">
          <span className={`wizard-step-dot${step === 'params' ? ' active' : ''}`}>1. Params</span>
          <span className={`wizard-step-dot${step === 'review' ? ' active' : ''}`}>2. Review</span>
          <span className={`wizard-step-dot${step === 'done' ? ' active' : ''}`}>3. Done</span>
        </div>

        {step === 'params' ? (
          <ParamForm params={recipe.params} values={params} onChange={setParams} />
        ) : step === 'review' ? (
          <div className="wizard-review">
            <p style={{ color: 'var(--text-muted)', marginBottom: 12 }}>
              The following commands will be queued:
            </p>
            <ul className="pending-changes-list">
              {resolvedSteps.map((s, i) => (
                <li key={i} className="pending-changes-item">
                  <strong>{s.label}</strong>
                  <code>
                    {s.action} {Object.values(s.args).join(' ')}
                  </code>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="wizard-done">
            <p style={{ textAlign: 'center', fontSize: '1.1rem', color: 'var(--color-ok)' }}>
              Commands queued successfully!
            </p>
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem' }}>
              Use the Pending Changes Bar to preview and apply.
            </p>
          </div>
        )}

        <div className="dialog-form-actions" style={{ marginTop: 16 }}>
          {step === 'params' ? (
            <>
              <button type="button" className="dialog-btn-secondary" onClick={props.onClose}>
                Cancel
              </button>
              <button type="button" className="dialog-btn-primary" onClick={handleNext}>
                Next
              </button>
            </>
          ) : step === 'review' ? (
            <>
              <button
                type="button"
                className="dialog-btn-secondary"
                onClick={() => setStep('params')}
              >
                Back
              </button>
              <button type="button" className="dialog-btn-primary" onClick={handleNext}>
                Queue All
              </button>
            </>
          ) : (
            <button type="button" className="dialog-btn-primary" onClick={props.onClose}>
              Close
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
