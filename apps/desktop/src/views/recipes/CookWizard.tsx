import { useCallback, useState } from 'react';
import type { RecipeDefinition } from '@patze/telemetry-core';
import { ParamForm } from './ParamForm';
import { DiffViewer } from '../../components/DiffViewer';

export interface CookWizardProps {
  readonly recipe: RecipeDefinition;
  readonly baseUrl: string;
  readonly token: string;
  readonly targetId: string | null;
  readonly onOpenRollback: () => void;
  readonly onClose: () => void;
}

type WizardStep = 'params' | 'validate' | 'preview' | 'result';

interface RecipeValidationResponse {
  readonly ok: boolean;
  readonly errors?: readonly string[];
  readonly requiresConfirm?: boolean;
  readonly riskLevel?: 'low' | 'medium' | 'high';
}

interface RecipePreviewResponse {
  readonly ok: boolean;
  readonly errors?: readonly string[];
  readonly diff?: {
    readonly before: string;
    readonly after: string;
    readonly commandCount: number;
    readonly simulated: boolean;
    readonly simulationError?: string;
  };
  readonly commands?: ReadonlyArray<{ description: string; cli: string }>;
}

interface RecipeApplyResponse {
  readonly ok: boolean;
  readonly snapshotId?: string;
  readonly operationId?: string;
  readonly error?: string;
}

function buildHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (token.length > 0) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

export function CookWizard(props: CookWizardProps): JSX.Element {
  const { recipe } = props;
  const [step, setStep] = useState<WizardStep>('params');
  const [params, setParams] = useState<Record<string, unknown>>({});
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<readonly string[]>([]);
  const [validation, setValidation] = useState<RecipeValidationResponse | null>(null);
  const [preview, setPreview] = useState<RecipePreviewResponse | null>(null);
  const [applyResult, setApplyResult] = useState<RecipeApplyResponse | null>(null);

  const handleValidate = useCallback(async () => {
    if (!props.targetId) {
      setErrors(['Select target before running a recipe.']);
      return;
    }
    setBusy(true);
    setErrors([]);
    setValidation(null);
    setPreview(null);
    try {
      const res = await fetch(
        `${props.baseUrl}/recipes/${encodeURIComponent(recipe.id)}/validate`,
        {
          method: 'POST',
          headers: buildHeaders(props.token),
          body: JSON.stringify({ targetId: props.targetId, params }),
          signal: AbortSignal.timeout(10_000),
        }
      );
      const data = (await res.json()) as RecipeValidationResponse;
      if (!res.ok || !data.ok) {
        setErrors(data.errors ?? [`Validate failed (HTTP ${String(res.status)}).`]);
        return;
      }
      setValidation(data);
      setStep('validate');
    } catch {
      setErrors(['Validate failed — network error.']);
    } finally {
      setBusy(false);
    }
  }, [props.baseUrl, props.targetId, props.token, params, recipe.id]);

  const handlePreview = useCallback(async () => {
    if (!props.targetId) {
      setErrors(['Select target before previewing recipe changes.']);
      return;
    }
    setBusy(true);
    setErrors([]);
    setPreview(null);
    try {
      const res = await fetch(`${props.baseUrl}/recipes/${encodeURIComponent(recipe.id)}/preview`, {
        method: 'POST',
        headers: buildHeaders(props.token),
        body: JSON.stringify({ targetId: props.targetId, params }),
        signal: AbortSignal.timeout(12_000),
      });
      const data = (await res.json()) as RecipePreviewResponse;
      if (!res.ok || !data.ok) {
        setErrors(data.errors ?? [`Preview failed (HTTP ${String(res.status)}).`]);
        return;
      }
      setPreview(data);
      setStep('preview');
    } catch {
      setErrors(['Preview failed — network error.']);
    } finally {
      setBusy(false);
    }
  }, [params, props.baseUrl, props.targetId, props.token, recipe.id]);

  const handleApply = useCallback(async () => {
    if (!props.targetId) {
      setErrors(['Select target before applying recipe changes.']);
      return;
    }
    setBusy(true);
    setErrors([]);
    setApplyResult(null);
    try {
      const res = await fetch(`${props.baseUrl}/recipes/${encodeURIComponent(recipe.id)}/apply`, {
        method: 'POST',
        headers: buildHeaders(props.token),
        body: JSON.stringify({ targetId: props.targetId, params }),
        signal: AbortSignal.timeout(20_000),
      });
      const data = (await res.json()) as RecipeApplyResponse;
      if (!res.ok || !data.ok) {
        setErrors([data.error ?? `Apply failed (HTTP ${String(res.status)}).`]);
        return;
      }
      setApplyResult(data);
      setStep('result');
    } catch {
      setErrors(['Apply failed — network error.']);
    } finally {
      setBusy(false);
    }
  }, [params, props.baseUrl, props.targetId, props.token, recipe.id]);

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
          <span className={`wizard-step-dot${step === 'validate' ? ' active' : ''}`}>
            2. Validate
          </span>
          <span className={`wizard-step-dot${step === 'preview' ? ' active' : ''}`}>
            3. Preview
          </span>
          <span className={`wizard-step-dot${step === 'result' ? ' active' : ''}`}>4. Result</span>
        </div>

        {errors.length > 0 ? (
          <div className="doctor-issues" style={{ marginBottom: 8 }}>
            {errors.map((message) => (
              <div key={message} className="doctor-issue doctor-issue-error">
                <span className="doctor-issue-badge">ERROR</span>
                <span className="doctor-issue-msg">{message}</span>
              </div>
            ))}
          </div>
        ) : null}

        {step === 'params' ? (
          <ParamForm params={recipe.params} values={params} onChange={setParams} />
        ) : step === 'validate' ? (
          <div className="wizard-review">
            <p style={{ color: 'var(--text-muted)', marginBottom: 10 }}>Recipe input validated.</p>
            <div className="doctor-playbook-list">
              <div className="doctor-playbook-item">
                <span className="mono">Risk</span>
                <span className="doctor-hint">{validation?.riskLevel ?? 'medium'}</span>
              </div>
              <div className="doctor-playbook-item">
                <span className="mono">Requires confirm</span>
                <span className="doctor-hint">{validation?.requiresConfirm ? 'yes' : 'no'}</span>
              </div>
            </div>
          </div>
        ) : step === 'preview' ? (
          <div className="wizard-review">
            <p style={{ color: 'var(--text-muted)', marginBottom: 10 }}>
              Preview generated. Review the expected config diff before apply.
            </p>
            {preview?.commands?.length ? (
              <ul className="pending-changes-list">
                {preview.commands.map((command) => (
                  <li key={command.cli} className="pending-changes-item">
                    <strong>{command.description}</strong>
                    <code>{command.cli}</code>
                  </li>
                ))}
              </ul>
            ) : null}
            {preview?.diff ? (
              <div style={{ marginTop: 10 }}>
                <DiffViewer
                  title={`Recipe preview (${String(preview.diff.commandCount)} command(s))`}
                  before={preview.diff.before}
                  after={preview.diff.after}
                />
                {preview.diff.simulationError ? (
                  <p className="doctor-hint" style={{ marginTop: 8, marginBottom: 0 }}>
                    {`Simulation warning: ${preview.diff.simulationError}`}
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : (
          <div className="wizard-done">
            <p style={{ textAlign: 'center', fontSize: '1.05rem', color: 'var(--color-ok)' }}>
              Recipe applied successfully
            </p>
            <p style={{ textAlign: 'center', color: 'var(--text-muted)', fontSize: '0.82rem' }}>
              {`snapshot: ${applyResult?.snapshotId ?? '-'} · operation: ${applyResult?.operationId ?? '-'}`}
            </p>
          </div>
        )}

        <div className="dialog-form-actions" style={{ marginTop: 16 }}>
          {step === 'params' ? (
            <>
              <button type="button" className="dialog-btn-secondary" onClick={props.onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="dialog-btn-primary"
                disabled={busy || !props.targetId}
                onClick={() => {
                  void handleValidate();
                }}
              >
                {busy ? 'Validating…' : 'Validate'}
              </button>
            </>
          ) : step === 'validate' ? (
            <>
              <button
                type="button"
                className="dialog-btn-secondary"
                disabled={busy}
                onClick={() => {
                  setStep('params');
                }}
              >
                Back
              </button>
              <button
                type="button"
                className="dialog-btn-primary"
                disabled={busy}
                onClick={() => {
                  void handlePreview();
                }}
              >
                {busy ? 'Previewing…' : 'Preview'}
              </button>
            </>
          ) : step === 'preview' ? (
            <>
              <button
                type="button"
                className="dialog-btn-secondary"
                disabled={busy}
                onClick={() => {
                  setStep('validate');
                }}
              >
                Back
              </button>
              <button
                type="button"
                className="dialog-btn-primary"
                disabled={busy}
                onClick={() => {
                  void handleApply();
                }}
              >
                {busy ? 'Applying…' : 'Apply'}
              </button>
            </>
          ) : (
            <>
              <button type="button" className="dialog-btn-secondary" onClick={props.onOpenRollback}>
                Open Rollback
              </button>
              <button type="button" className="dialog-btn-primary" onClick={props.onClose}>
                Close
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
