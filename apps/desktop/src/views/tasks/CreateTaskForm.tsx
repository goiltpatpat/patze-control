import { useState } from 'react';
import type { OpenClawCronJob } from './types';
import { actionLabel } from './utils';

interface CreateTaskFormProps {
  readonly onCreate: (input: Record<string, unknown>) => void;
  readonly openclawJobs: readonly OpenClawCronJob[];
}

export function CreateTaskForm(props: CreateTaskFormProps): JSX.Element {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [action, setAction] = useState('health_check');
  const [scheduleKind, setScheduleKind] = useState('every');
  const [everyMinutes, setEveryMinutes] = useState('5');
  const [cronExpr, setCronExpr] = useState('0 * * * *');
  const [cronTz, setCronTz] = useState('');
  const [atDate, setAtDate] = useState('');
  const [webhookUrl, setWebhookUrl] = useState('');
  const [webhookMethod, setWebhookMethod] = useState('POST');
  const [openclawJobId, setOpenclawJobId] = useState('');

  const canSubmit = name.trim().length > 0 && action !== '';

  const handleSubmit = (): void => {
    let schedule: Record<string, unknown>;
    switch (scheduleKind) {
      case 'cron':
        schedule = { kind: 'cron', expr: cronExpr, ...(cronTz ? { tz: cronTz } : {}) };
        break;
      case 'at':
        schedule = { kind: 'at', at: atDate || new Date(Date.now() + 60_000).toISOString() };
        break;
      default:
        schedule = { kind: 'every', everyMs: Math.max(1, parseFloat(everyMinutes) || 5) * 60_000 };
    }

    const actionConfig: Record<string, unknown> = { action };
    if (action === 'custom_webhook') {
      actionConfig.params = { url: webhookUrl, method: webhookMethod };
    }
    if (action === 'openclaw_cron_run') {
      actionConfig.params = { jobId: openclawJobId };
    }

    props.onCreate({
      name: name.trim() || `${actionLabel(action)} task`,
      ...(description.trim() ? { description: description.trim() } : {}),
      schedule,
      action: actionConfig,
    });
  };

  return (
    <div className="panel" style={{ padding: 20 }}>
      <div className="dialog-form-grid" style={{ marginTop: 0 }}>
        <div className="dialog-form-row cols-2">
          <div className="dialog-field">
            <label className="dialog-field-label">Name</label>
            <input
              value={name}
              onChange={(e) => {
                setName(e.target.value);
              }}
              placeholder="e.g. Hourly health check"
            />
          </div>
          <div className="dialog-field">
            <label className="dialog-field-label">Description</label>
            <input
              value={description}
              onChange={(e) => {
                setDescription(e.target.value);
              }}
              placeholder="Optional"
            />
          </div>
        </div>

        <div className="dialog-form-row cols-2">
          <div className="dialog-field">
            <label className="dialog-field-label">Action</label>
            <select
              value={action}
              onChange={(e) => {
                setAction(e.target.value);
              }}
            >
              <option value="health_check">Health Check</option>
              <option value="reconnect_endpoints">Reconnect Endpoints</option>
              <option value="cleanup_sessions">Cleanup Sessions</option>
              <option value="generate_report">Generate Report</option>
              <option value="custom_webhook">Custom Webhook</option>
              <option value="openclaw_cron_run">OpenClaw Cron Run</option>
            </select>
          </div>
          <div className="dialog-field">
            <label className="dialog-field-label">Schedule</label>
            <select
              value={scheduleKind}
              onChange={(e) => {
                setScheduleKind(e.target.value);
              }}
            >
              <option value="every">Interval</option>
              <option value="cron">Cron Expression</option>
              <option value="at">One-time</option>
            </select>
          </div>
        </div>

        {scheduleKind === 'every' ? (
          <div className="dialog-form-row">
            <div className="dialog-field">
              <label className="dialog-field-label">Every (minutes)</label>
              <input
                type="number"
                min="1"
                value={everyMinutes}
                onChange={(e) => {
                  setEveryMinutes(e.target.value);
                }}
              />
            </div>
          </div>
        ) : scheduleKind === 'cron' ? (
          <div className="dialog-form-row cols-2">
            <div className="dialog-field">
              <label className="dialog-field-label">Cron Expression</label>
              <input
                value={cronExpr}
                onChange={(e) => {
                  setCronExpr(e.target.value);
                }}
                placeholder="0 * * * *"
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-field-label">Timezone (optional)</label>
              <input
                value={cronTz}
                onChange={(e) => {
                  setCronTz(e.target.value);
                }}
                placeholder="e.g. Asia/Bangkok"
              />
            </div>
          </div>
        ) : (
          <div className="dialog-form-row">
            <div className="dialog-field">
              <label className="dialog-field-label">Run at (ISO 8601)</label>
              <input
                value={atDate}
                onChange={(e) => {
                  setAtDate(e.target.value);
                }}
                placeholder="2026-03-01T09:00:00Z"
              />
            </div>
          </div>
        )}

        {action === 'custom_webhook' ? (
          <div className="dialog-form-row cols-2">
            <div className="dialog-field">
              <label className="dialog-field-label">Webhook URL</label>
              <input
                value={webhookUrl}
                onChange={(e) => {
                  setWebhookUrl(e.target.value);
                }}
                placeholder="https://example.com/hook"
              />
            </div>
            <div className="dialog-field">
              <label className="dialog-field-label">HTTP Method</label>
              <select
                value={webhookMethod}
                onChange={(e) => {
                  setWebhookMethod(e.target.value);
                }}
              >
                <option value="POST">POST</option>
                <option value="GET">GET</option>
                <option value="PUT">PUT</option>
              </select>
            </div>
          </div>
        ) : null}

        {action === 'openclaw_cron_run' ? (
          <div className="dialog-form-row">
            <div className="dialog-field">
              <label className="dialog-field-label">OpenClaw Job ID</label>
              {props.openclawJobs.length > 0 ? (
                <select
                  value={openclawJobId}
                  onChange={(e) => {
                    setOpenclawJobId(e.target.value);
                  }}
                >
                  <option value="">Select a job...</option>
                  {props.openclawJobs.map((j) => (
                    <option key={j.jobId} value={j.jobId}>
                      {j.name ?? j.jobId}
                    </option>
                  ))}
                </select>
              ) : (
                <input
                  value={openclawJobId}
                  onChange={(e) => {
                    setOpenclawJobId(e.target.value);
                  }}
                  placeholder="job_id from OpenClaw"
                />
              )}
            </div>
          </div>
        ) : null}
      </div>

      <div className="actions" style={{ marginTop: 16 }}>
        <button className="btn-primary" disabled={!canSubmit} onClick={handleSubmit}>
          Create Task
        </button>
      </div>
    </div>
  );
}
