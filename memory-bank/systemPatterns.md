# System Patterns

_Last updated: 2026-02-22_

## Architecture

```text
Desktop (Tauri 2)
  React 18 + Vite 6 frontend
  10 views, 15+ components
  Tauri sidecar -> API server
        |
        | HTTP + SSE (/events, /tasks/events)
        v
API Server (Fastify 5)
  Telemetry Pipeline: Ingestor -> EventStore -> Projector -> Aggregator
  CronService + TaskStore: Task executor (webhook, health_check, openclaw)
  OpenClawSyncManager: Target 1 (Local), Target 2 (VPS-A), ... Target N
  SSH Tunnel Orchestrator: RemoteNodeAttachment x N
  Channel Intelligence: policy + account + risk
        |
        | File I/O (local) / SSH (remote)
        v
OpenClaw installations
  ~/.openclaw/cron/jobs.json
  ~/.openclaw/cron/runs/*.jsonl
  ~/.openclaw/openclaw.json
```

## Telemetry Pipeline

1. **Ingestion**: `POST /ingest` or `/ingest/batch` -> validated by `DefaultTelemetryIngestor` (dedup by eventId)
2. **Storage**: `InMemoryEventStore` with append-only log + eventId index
3. **Projection**: `TelemetryProjector` produces read models (machines, sessions, runs, agents, logs)
4. **Aggregation**: `TelemetryAggregator` merges multiple `TelemetryNode` snapshots (local + remote)
5. **Streaming**: SSE `/events` pushes incremental updates to desktop

## Multi-Target OpenClaw Sync

- `OpenClawTargetStore` persists targets to `openclaw-targets.json` (atomic write via tmp+rename)
- `OpenClawSyncManager` holds `Map<targetId, SyncInstance>` of running `OpenClawCronSync` instances
- Start/stop/restart per target, aggregate status across all targets
- Auto-creates default "Local" target on first boot if store is empty

## OpenClaw Rich Schema Parsing

- `OpenClawCronReader.readJobs()` normalizes raw JSON into typed `OpenClawCronJob` with defensive parsing
- Supports both direct fields and nested `state` object (fallback chain: `job.field` then `job.state.field`)
- Handles dual timestamp formats: ISO string and epoch ms via `toIsoDate()` helper
- Schedule enrichment: `staggerMs` (cron jitter), `anchorMs` (interval anchor point)
- Payload model: `systemEvent` or `agentTurn` with optional model/thinking/timeout
- `OpenClawCronSync.toScheduledTask()` maps enriched fields into Patze task model (lastError, nextRunAtMs, anchorMs)

## Channel Intelligence

- `readOpenClawChannels()` parses `openclaw.json` channel configs with multi-level fallback
- Policy parsing: `parseDmPolicy()` reads `config.dmPolicy` then `config.dm.policy` (5 values: pairing, allowlist, open, disabled, unknown)
- `parseGroupPolicy()`, `parseAllowFrom()` with account-level merge (Set union across channel + accounts)
- `parseRuntimeState()`: checks `connected`, `status`, `running` fields for 3-state result
- Account aggregation: iterates `accounts` config object, counts enabled/configured/connected/runtimeKnown
- Priority scoring in UI: `open + wildcard = high risk`, `disabled = medium`, `unknown runtime = medium`

## Circuit Breaker + Adaptive Polling

- `OpenClawCronSync` uses `setTimeout` (not `setInterval`) for dynamic scheduling
- On failure: exponential backoff `2^(failures-1) x basePollInterval`, capped at 1 hour
- On success: reset to base interval
- Status changes emitted only when serialized status differs (`emitStatusIfChanged`)

## SSE Event Architecture

- Two SSE endpoints: `/events` (telemetry) and `/tasks/events` (cron + openclaw sync)
- Named events: `telemetry`, `task`, `openclaw-sync`
- `writeSseNamedEventChunk(name, data)` for typed SSE
- Listeners stored in `Set<Function>` with try/catch isolation per listener
- Per-target status changes broadcast to all connected SSE clients

## SSH Tunnel Pattern

- `RemoteNodeAttachmentOrchestrator` manages SSH connections to remote API servers
- Each attachment creates an `SSHTunnelRuntime` with local port forwarding
- Tunneled SSE streams mirror remote events into local `TelemetryNode`
- All nodes merge via `TelemetryAggregator` -> unified snapshot

## Atomic File Persistence

- Write to `.tmp` file then `fs.renameSync()` for crash-safe updates
- Used by: `TaskStore`, `OpenClawTargetStore`, `TaskSnapshotStore`
- All stores use synchronous fs for simplicity (local files only for now)

## Health Check Doctor

- `buildOpenClawHealth(path, syncStatus)` -> structured `HealthCheckItem[]`
- Checks: home dir, cron dir, jobs.json, runs folder, sync status
- Per-target health via `/openclaw/targets/:targetId/health`

## Frontend Patterns

- **Request deduplication**: `AbortController` per fetch type, versioned requests
- **Stale closure prevention**: `useRef` for SSE handlers
- **Smart polling**: adaptive intervals based on activity/errors
- **Hash routing**: `#/overview`, `#/tasks`, etc. -- keyboard 1-9 shortcuts
- **Progressive disclosure**: Stats bar -> table/cards -> expandable rows -> detail panel
- **Error boundaries**: React ErrorBoundary wraps all views

## CI/CD Architecture

- **repo-ci** (ci.yml): quality-gates (typecheck -> lint -> format -> test) + monorepo-build (pnpm build)
- **desktop-ci** (desktop-ci.yml): web-bundle (Ubuntu + Windows matrix) -> tauri-build (Windows, depends on web-bundle)
- **workflow-lint** (workflow-lint.yml): reviewdog/action-actionlint
- Sidecar build: scripts/build-sidecar.sh with platform-aware .exe extension
- Monorepo build order: telemetry-core -> control-client -> recursive typecheck
