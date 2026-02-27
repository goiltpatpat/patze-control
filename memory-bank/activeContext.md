# Active Context

_Last updated: 2026-02-26_

## Current Focus

Stabilize real OpenClaw-on-VPS operations and keep UI behavior deterministic in Tauri desktop: bridge setup reliability (sudo/systemd edge cases), target-aware data views, and less noisy telemetry presentation.

## Verified Recent Changes (Current Cycle)

### Critical Flow Hardening

- `selectedTargetId` is now the shared source of truth across `AppShell` -> `MainView` -> OpenClaw views.
- Tasks/Channels removed local fallback target state to avoid cross-view mismatch.
- Agents/Models/Recipes/Channels gained clearer loading, error, and "select target first" empty states.

### Polling and Race Protection

- `useSmartPoll` now passes `{ signal, requestId }` to fetchers.
- Hooks that fetch OpenClaw targets, managed bridges, bridge connections, and endpoint attachments now ignore stale responses.
- Polling behavior adjusted for desktop context (no hidden-tab deadlock in Tauri-sensitive flows).

### Bridge + Config Sync Hardening

- Bridge setup manager now handles `sudo` privilege modes explicitly, including `needs_sudo_password`.
- Added retry path for sudo password submission (`/bridge/managed/:id/sudo-password`).
- Added safe bundle replacement flow before restart (upload then move into target path).
- Bridge cron sync now carries `configHash`/`configRaw`; API writes `openclaw.json` mirror when config changes.
- Install script improved for service mask edge cases and user/system install paths.
- Bridge runtime now exposes local `/health` endpoint (default `127.0.0.1:19701`) with runtime/tick/poller status for external liveness checks.
- Bridge runtime now exposes local Prometheus `/metrics` endpoint for uptime/tick/process observability.
- Bridge now handles `SIGHUP` as graceful runtime restart trigger (clean shutdown + exit for supervisor restart) to avoid in-process port-rebind races.
- Bridge telemetry sender now persists queue to local disk spool file and hydrates on restart for crash/shutdown resilience.
- Added targeted telemetry-core tests for spool hydrate/persist/flush behavior to reduce regression risk.
- Fixed spool persistence race during flush/close so latest queue snapshot is not lost when persist calls overlap.
- Smoke checks validated: health/metrics availability, HUP exit code 0 for restart path, and seeded spool hydrate visibility via `/health`.
- Installer now supports `--verify-bundle-sha256` and writes structured install report JSON (`/var/log/patze-bridge-install.json` or user-mode local path).
- File Manager now supports folder export as client-side `.zip` (recursive SFTP list + per-file download + JSZip packaging) alongside single-file download and copy-content actions.
- File Manager folder export was upgraded to server-side zip streaming endpoint (`/files/:connId/download-folder`) to reduce browser memory usage and improve large-folder reliability.

### Telemetry Accuracy

- Bridge resource mapper switched to CPU delta measurement (`measureCpuPct()`).
- `memoryTotalBytes` now flows from heartbeat payload through shared types/reducer to desktop monitor view.
- Bridge connection freshness now uses API server receive time (not client-sent timestamps) to avoid clock-skew false positives.
- Bridge stale cleanup TTL reduced from day-level to minute-level to reduce ghost-online machines in UI.
- Remote attachment status now probes tunneled `/health` before returning `connected` to the desktop.

### Model Profiles Correctness + UX

- `Model Profiles` backend CRUD now edits `openclaw.json` in schema-aware mode for `models.providers.<provider>.models[]` instead of legacy-only `models.<id>`.
- Added safe support for model IDs containing provider prefix (e.g. `moonshot/kimi-k2.5`) across update/delete/default routes.
- Added direct default-model endpoint (`POST /openclaw/targets/:targetId/models/default`) to update `agents.defaults.model.primary` without command-queue ambiguity.
- `ModelsView` now loads model context from `config-raw` and surfaces default/fallback counts plus alias badges for better parity with real OpenClaw state.
- Model mutations in desktop now execute immediately via API (with in-view error reporting + refresh) rather than queuing opaque config commands.
- `Referenced Models` panel now has smart UX grouping (`Needs Profiling` vs `Already Profiled`), quick filters, and inline `Create Profile` prefill actions to reduce cognitive load and close missing-profile gaps faster.

### Recipe Lifecycle UX + Quality Gate

- `CookWizard` result step now includes direct `Open Rollback` action to jump into rollback workflow after recipe apply.
- Monorepo test gate now includes API server tests by default, with dedicated `test:clawpal-gate` and `ci:verify:clawpal` scripts.
- Added deterministic smoke flow script (`scripts/smoke-openclaw-flow.mjs`) that boots API in temp sandbox and verifies readiness -> recipe validate/preview/apply -> rollback.
- CI quality workflow now runs `ci:verify:clawpal`, so smoke flow is part of enforced repository checks.
- Added browser-level smoke flow (`scripts/smoke-ui-openclaw-flow.mjs`) with Playwright headless Chromium to verify real UI flow: open recipes page -> run validate/preview/apply -> navigate to rollback path.
- ClawPal gate now validates both API smoke and UI smoke before typecheck.

## Active Risks and Gaps

- Bridge UX can still appear "stuck" when remote service is masked/misconfigured despite tunnel success.
- Office 3D movement realism (human-like walking, anti-clipping, smoothness) still needs tuning.
- Tasks panel layout/readability requires additional polish for production quality.
- Fleet CPU spikes may still appear due to short sampling windows and bursty host scheduling.

## Near-Term Next Steps

1. Add targeted tests for bridge install modes and cron config sync edge cases.
2. Add desktop/Tauri browser automation on top of API smoke gate for full UI parity checks.

## Historical Milestones (Compressed)

- tenacitOS-inspired UI expansion shipped (command palette, notifications, timeline, heatmap, design-system polish).
- Office view expanded from CSS-only isometric to hybrid `3D` + `Classic` with runtime fallback.
- Multi-target OpenClaw + parser hardening completed for modern and legacy schema compatibility.
