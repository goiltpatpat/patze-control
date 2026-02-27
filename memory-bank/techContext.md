# Tech Context

_Last updated: 2026-02-26_

## Stack

- **Monorepo**: pnpm 9.15.4 workspaces
- **Language**: TypeScript 5.7+ (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `strict`)
- **Desktop**: Tauri 2 (Rust backend) + React 18 + Vite 6
- **API Server**: Fastify 5, `tsx` for dev (esbuild-based), `bun build --compile` for sidecar
- **Core Library**: `@patze/telemetry-core` — shared domain kernel between API + desktop types
- **Testing**: Node.js built-in `node:test`, run via `npx tsx --test`
- **Styling**: Custom CSS variables (dark command-center theme), no Tailwind
- **Linting**: ESLint 9 + Prettier 3
- **CI/CD**: GitHub Actions (repo-ci, desktop-ci, workflow-lint), Dependabot
- **Runtime**: Node.js 22+, Bun (sidecar build)

## Key Dependencies

- `fastify` ^5.x — HTTP server with SSE streaming
- `@tauri-apps/api` ^2.x — desktop integration (sidecar, invoke)
- `ssh2` — SSH tunnel for remote node attachment
- `esbuild` — bridge bundle artifact (`dist/bridge-bundle.mjs`) for remote SFTP-based deploy flow
- `concurrently` — parallel dev servers
- `tsx` — TypeScript execution for dev + tests
- `playwright` — headless browser automation for UI smoke flow

## Development

```bash
pnpm dev                 # Start API + Desktop dev servers (concurrently)
pnpm build:api-server    # Build telemetry-core + api-server (tsc)
pnpm --filter @patze/openclaw-bridge run build:bundle  # Build deployable bridge bundle
npx tsx --test <file>    # Run individual test files
pnpm ci:verify           # Typecheck + lint + format + test (CI equivalent)
pnpm test:smoke:openclaw-flow # Spin isolated API and verify readiness->recipe->rollback flow
pnpm test:smoke:ui-openclaw-flow # Spin API+desktop and verify browser recipe flow + rollback path
pnpm test:clawpal-gate   # telemetry-core + api-server tests + typecheck
pnpm ci:verify:clawpal   # lint + format + clawpal-gate
```

- API: http://localhost:9700
- Desktop UI: http://localhost:1420
- Auth: configurable via `TELEMETRY_AUTH_MODE` (defaults to `none` in dev)

## File Structure

```
packages/telemetry-core/src/
  ├── cron/
  │   ├── types.ts                   # Core cron types (ScheduledTask, TaskSchedule, etc.)
  │   ├── store.ts                   # TaskStore — JSON file persistence (atomic write)
  │   ├── service.ts                 # CronService — scheduler + executor loop
  │   ├── schedule.ts                # computeNextRunMs, formatScheduleDescription
  │   ├── lock.ts                    # AsyncLock — async mutex
  │   ├── openclaw-reader.ts         # Read OpenClaw native files (jobs.json, runs/*.jsonl)
  │   ├── openclaw-reader.test.ts    # Tests for reader (array/object/state formats)
  │   ├── openclaw-sync.ts           # Single-target sync with adaptive backoff
  │   ├── openclaw-sync.test.ts      # Tests for sync mapping
  │   ├── openclaw-target.ts         # Multi-target store + sync manager
  │   ├── snapshot.ts                # TaskSnapshotStore — save/restore task configs
  │   ├── snapshot-rollback.test.ts  # Tests for snapshot rollback
  │   └── index.ts                   # Barrel exports
  ├── event-bus.ts             # InMemoryEventBus
  ├── event-store.ts           # InMemoryEventStore
  ├── ingestor.ts              # DefaultTelemetryIngestor (validation + dedup)
  ├── projections.ts           # TelemetryProjector (event → read model)
  ├── telemetry-aggregator.ts  # Multi-node aggregator
  ├── telemetry-node.ts        # Single telemetry node
  ├── transports.ts            # SSE, HTTP, SSH adapters
  ├── frontend-reducer.ts      # Incremental frontend state reducer
  ├── frontend-adapter.ts      # toFrontendUnifiedSnapshot
  └── index.ts                 # Main barrel

apps/api-server/src/
  ├── index.ts                                # All routes, SSE, OpenClaw integration, lifecycle
  ├── task-executor.ts                        # Task action executor (webhook, health_check, openclaw_cron_run)
  ├── cli-tasks.ts                            # CLI for task management
  ├── bridge-setup-manager.ts                 # VPS bridge setup state machine
  ├── openclaw-config-reader.test.ts          # Parser regression tests (modern + legacy schema)
  ├── ssh-config-parser.ts                    # Parse ~/.ssh/config for host aliases
  ├── remote-node-attachment-orchestrator.ts  # SSH tunnel orchestration
  └── ssh-tunnel-runtime.ts                   # SSH tunnel lifecycle

apps/desktop/src/
  ├── App.tsx                  # Root component, auto-connect, sidecar detection
  ├── main.tsx                 # React entry + providers (Toast, Ticker, ErrorBoundary)
  ├── styles.css               # Dark theme CSS (2100+ lines)
  ├── shell/                   # AppShell, SidebarNav, StatusStrip, TopMachineContextBar
  ├── views/                   # 10 views: Overview, Agents, Tunnels, Machines, Sessions, Channels, Runs, Logs, Tasks, Settings
  ├── components/              # FilterTabs, Toast, GaugeBar, LiveDuration, RunDetail, badges/
  ├── hooks/                   # useEndpointManager, useEventToasts, useManagedBridges, useSmartPoll
  └── utils/                   # time, derive-agents, lifecycle
```

## TypeScript Constraints

- `exactOptionalPropertyTypes`: optional props must explicitly include `undefined` in type
- `noUncheckedIndexedAccess`: array/object index access returns `T | undefined`
- All cron file I/O uses synchronous Node.js `fs` (suitable for local; remote needs SSH relay)

## Ports

| Service           | Port  | Protocol    |
| ----------------- | ----- | ----------- |
| API Server        | 9700  | HTTP + SSE  |
| Desktop UI (Vite) | 1420  | HTTP        |
| Tauri IPC         | —     | Rust invoke |
| Bridge Remote     | 19700 | Reverse SSH |

## CI Workflows

| Workflow      | File                | Jobs                                               | Trigger         |
| ------------- | ------------------- | -------------------------------------------------- | --------------- |
| repo-ci       | `ci.yml`            | quality-gates, monorepo-build                      | push/PR to main |
| desktop-ci    | `desktop-ci.yml`    | web-bundle (ubuntu+windows), tauri-build (windows) | push/PR to main |
| workflow-lint | `workflow-lint.yml` | actionlint                                         | push/PR to main |
