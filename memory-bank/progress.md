# Progress

_Last updated: 2026-02-26_

## What Works

- **Telemetry Pipeline**: Event ingestion, dedup, projection, aggregation, SSE streaming
- **Multi-Machine Monitoring**: SSH tunnels, remote node attachment, unified snapshot
- **Desktop UI (10 views)**: Overview, Agents, Tunnels, Machines, Sessions, Channels, Runs, Logs, Tasks, Settings
- **Cron Task System**: Create/edit/delete scheduled tasks (at, every, cron), execution with timeout/backoff, webhook delivery, run history, snapshots/rollback
- **OpenClaw Native Sync**: Reads OpenClaw cron job files, merged view with Patze tasks
- **OpenClaw Rich Schema**: staggerMs, anchorMs, payload (systemEvent/agentTurn), wakeMode, sessionTarget, nextRunAtMs, lastError, lastDurationMs, lastDelivered, skipped status, nested state extraction
- **Channel Intelligence**: groupPolicy, allowFrom with wildcard detection, runtimeState, accountSummary (total/enabled/configured/connected), policy-aware risk scoring, context-aware recommendations
- **Multi-Target OpenClaw**: Multiple installations managed simultaneously with per-target sync, health, API
- **VPS Bridge Agent**: openclaw-bridge package with incremental CronPusher, persistent machine ID, token expiry
- **VPS One-Liner Install**: install-bridge.sh + connect-vps.sh scripts with autossh reverse tunnel
- **Bridge API Endpoints**: POST /openclaw/bridge/cron-sync (incremental data) + GET /bridge/connections (audit)
- **Smart Connection UI**: Bridge connections display, smart polling (no wasted requests), quick-start guide
- **SSE Real-time Updates**: Task events + OpenClaw sync status pushed to UI
- **Circuit Breaker**: Exponential backoff on sync failures, adaptive polling intervals
- **Health Check (Doctor)**: Per-target diagnostics with severity-colored inline display
- **Task Snapshots**: Save/restore task configurations with rollback
- **Production Hardening**: Event dedup, session eviction, HMAC auth, fetch timeouts, error boundaries, toast dedupe, body size limits, rate limits
- **CI/CD Pipeline**: repo-ci (quality-gates + monorepo-build), desktop-ci (web bundle matrix + Tauri Windows artifact), workflow-lint (actionlint)
- **Repository Governance**: Branch protection (main), CODEOWNERS, PR/issue templates, Dependabot, public visibility
- **Command Palette (⌘K)**: Global search + navigation across views, machines, sessions, runs with fuzzy matching
- **Notification Center**: Persistent notification history with bell dropdown, unread badge, type-colored icons, localStorage persistence
- **Activity Heatmap**: 7-day × 24-hour visual grid of event activity with hover tooltips and intensity coloring
- **Task Timeline**: 7-day forward-looking calendar with color-coded task events, merged patze + openclaw tasks
- **Quick Notes (Notepad)**: Auto-saving textarea with 2s debounce, localStorage persistence
- **Enhanced Overview Dashboard**: Quick links grid, section headers with accent line, success rate bar
- **StatusStrip Enhancements**: CPU/RAM mini gauges, uptime counter, separator dividers
- **Design System Polish**: Soft color variables, accent line utility, enhanced badges, global scrollbar, panel transitions
- **System Monitor v2**: Dedicated monitor view with Disk% and network throughput (`delta/dt`) across fleet and per-machine cards
- **Workspace Full-text Search**: Backend `/workspace/search` + command palette integration (debounce, cancel, compact context results)
- **Memory Browser**: Dedicated memory UI + secure memory write endpoint with allowlist and path safety
- **Office View (Hybrid 3D + Classic)**: Agent-centric OpenClaw desk visualization with new 3D scene mode (Three.js via React Three Fiber) and Classic fallback mode
- **Office 3D Robustness Pass**: Dynamic camera/scene fitting for small or large desk counts, tenacitOS-inspired lighting/status labels, and WebGL capability fallback to Classic mode
- **Route Expansion**: New routes wired (`monitor`, `memory`, `office`) in sidebar + shell
- **Critical Target Contract**: `selectedTargetId` is unified as source-of-truth across key OpenClaw views (Agents/Tasks/Channels/Models/Recipes)
- **OpenClaw Config Parser Hardening**: API parser now handles modern schema (`agents.list`, `models.providers`) and filters invalid bindings safely
- **Config Reader Tests**: Added regression tests for modern + legacy OpenClaw schema parsing in API server
- **Smart State Consistency**: Better loading/error/empty guidance in critical views, including explicit “select target” state
- **Polling/Race Guard Upgrade**: `useSmartPoll` now supports abortable requests + request IDs; Channels moved to smart polling; key hooks now guard against stale responses
- **Bridge Install Hardening**: Bridge setup now supports pre-uploaded bundle replacement, sudo password retry, and systemd masked-unit recovery for user/system install modes
- **Bridge Config Mirroring**: Bridge cron sync payload now carries `configHash`/`configRaw`; API mirrors `openclaw.json` on target when config changes
- **OpenClaw Jobs Panel Refresh**: Tasks OpenClaw panel redesigned with richer stats, filter/search chips, and clearer run history presentation
- **Bridge Runtime Health Endpoint**: `openclaw-bridge` now serves local `/health` (default `127.0.0.1:19701`) with runtime status, tick health, and poller/sync running signals
- **Bridge Runtime Metrics Endpoint**: `openclaw-bridge` now serves local Prometheus-style `/metrics` with uptime, tick success/failure counters, worker running gauges, and process memory metrics
- **Installer Integrity + Reporting**: `install-bridge.sh` now supports `--verify-bundle-sha256` and emits structured install report JSON for audit/debug
- **Bridge Reload Safety (Signal-based)**: `SIGHUP` now triggers clean bridge shutdown + supervisor restart path to avoid in-process port rebind instability
- **Bridge Telemetry Disk Spool**: Telemetry queue now persists to disk and hydrates on restart, reducing data loss during crashes/restarts
- **Bridge Spool Regression Tests**: Added `HttpSinkAdapter` tests for hydrate/persist/flush spool behavior and wired into telemetry-core test script
- **Bridge Spool Race Fix**: Resolved overlapping persist race in `HttpSinkAdapter` to guarantee latest queue snapshot durability during shutdown/flush overlap
- **Reload Stability Fix**: Switched `SIGHUP` path to graceful process restart trigger (for supervisor restart) to eliminate in-process health port rebind crashes
- **File Manager Folder Download**: Added recursive folder download to `.zip` in desktop UI using JSZip (with transfer progress), plus copy-content support for text files
- **File Manager Server-side Zip Download**: Added API endpoint to stream folder archives as `.zip` and switched desktop folder download flow to use server-side archive generation
- **Model Profiles Schema Alignment**: API model CRUD now works against modern `models.providers` config shape (including `provider/model` IDs and default model updates), reducing drift from real OpenClaw config state
- **Model Profiles Smart Context UI**: Desktop models page now shows default/fallback model context and aliases from live `config-raw`, with direct mutation flows + clearer auth-key messaging
- **Model Profiles Smart Reference Actions**: Referenced models now support focus filters + missing-profile prioritization + one-click prefilled Create Profile actions from reference-only entries
- **Bridge Data-Truth Hardening**: API now uses server-time freshness for bridge last-seen tracking, aggressively expires stale bridge entries, and validates remote attachments with `/health` probe before reporting connected status
- **Recipe→Rollback UX Unification**: Recipe wizard success step now exposes direct `Open Rollback` navigation for faster transactional recovery workflows
- **ClawPal Reliability Gate Scripts**: Root test flow now includes `@patze/api-server` tests, with dedicated `test:clawpal-gate` and `ci:verify:clawpal` commands for higher confidence pre-release checks
- **OpenClaw E2E Smoke Gate (API Sandbox)**: Added `scripts/smoke-openclaw-flow.mjs` and wired it into `test:clawpal-gate` to validate readiness + recipe validate/preview/apply + rollback in an isolated temp environment
- **OpenClaw E2E Smoke Gate (UI Browser)**: Added `scripts/smoke-ui-openclaw-flow.mjs` with Playwright Chromium headless to validate real desktop web UI path (`#/recipes` -> validate/preview/apply -> `Open Rollback`) plus rollback endpoint verification

## What's Left

- [ ] Merge UI/UX branch (cursor/ui-ux-tenacitos-d014) into main via PR
- [ ] Merge open Dependabot PRs (#2-#9) for dependency hygiene
- [ ] Production deployment (Tauri sidecar bundling + installer)
- [ ] E2E tests for multi-target + bridge flows (API smoke gate done; full browser automation coverage still pending)
- [ ] Target edit dialog (rename, change settings in-place)
- [ ] OpenClaw CLI execution delegation for remote targets
- [ ] Multi-target dashboard overview (aggregated health across targets)
- [ ] Add richer Office interactions (desk detail drawer + per-target drill-down)
- [ ] Add optional indexing strategy for very large workspace search (beyond LRU cache)
- [ ] Run and lock regression tests for bridge install modes + config sync path

## Verification

- CI (baseline at last full run): typecheck ✓, lint ✓, format ✓, test 16/16 ✓
- ci:verify: FULL GREEN (historical baseline, needs re-run for current working tree)
- Browser: UI renders, interactions work

## Evolution

1. Basic cron task scheduler
2. OpenClaw native file reader integration
3. SSE events for real-time UI
4. Circuit breaker + adaptive polling
5. Health check Doctor system
6. Multi-target management (API + backend)
7. Smart UI/UX overhaul (stats bar, target cards, add dialog, doctor inline)
8. Documentation sync: memory bank foundation, README with full API catalog
9. VPS Bridge one-liner install: autossh tunnel, incremental cron push, persistent machine ID
10. Smart connection improvements: bridge UI, smart polling, quick-start guide
11. CI/CD + governance: repo-ci, desktop-ci, workflow-lint, branch protection, CODEOWNERS, Dependabot
12. OpenClaw rich schema: stagger, payload, wakeMode, sessionTarget, runtime state, nested state extraction
13. Channel intelligence: groupPolicy, allowFrom, runtimeState, accountSummary, risk scoring
14. tenacitOS UI/UX integration: command palette, notifications, heatmap, timeline, notepad, design system polish
15. Target contract + smart polling hardening: shared `selectedTargetId`, abortable polling, stale response guards
16. Bridge install + sync hardening: SFTP bundle flow, sudo retry, config mirror (`configHash`/`configRaw`)
17. Tasks OpenClaw jobs UX refresh: stats/search/filter + improved run-history readability
18. Bridge runtime observability + installer integrity: local `/health` + `/metrics`, SHA-256 bundle verification, structured install report JSON
