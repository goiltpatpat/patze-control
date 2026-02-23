# Patze Control

[![CI](https://github.com/goiltpatpat/patze-control/actions/workflows/ci.yml/badge.svg)](https://github.com/goiltpatpat/patze-control/actions/workflows/ci.yml)
[![Desktop CI](https://github.com/goiltpatpat/patze-control/actions/workflows/desktop-ci.yml/badge.svg)](https://github.com/goiltpatpat/patze-control/actions/workflows/desktop-ci.yml)
[![Workflow Lint](https://github.com/goiltpatpat/patze-control/actions/workflows/workflow-lint.yml/badge.svg)](https://github.com/goiltpatpat/patze-control/actions/workflows/workflow-lint.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178c6.svg)](https://www.typescriptlang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2-ffc131.svg)](https://tauri.app/)

Patze Control is a desktop control plane for OpenClaw fleets.
It consolidates telemetry, runs, sessions, tasks, channel status, and remote connectivity across local and VPS targets.

## What It Does

- Real-time fleet visibility with SSE snapshots and drill-down views
- Multi-target OpenClaw sync (local + remote) with per-target health diagnostics
- Scheduled task orchestration (`at`, `every`, `cron`) with run history and rollback snapshots
- VPS bridge onboarding from UI (reverse SSH + optional bridge install)
- Token auth management from Settings with persisted runtime configuration

## Stack

| Layer    | Technology                                               |
| -------- | -------------------------------------------------------- |
| Monorepo | pnpm workspaces                                          |
| Language | TypeScript 5.7+ (`strict`, `exactOptionalPropertyTypes`) |
| Desktop  | Tauri 2 + React 18 + Vite 6                              |
| API      | Fastify 5 + SSE                                          |
| Remote   | `ssh2` tunnels + bridge push                             |
| Quality  | ESLint 9, Prettier 3, GitHub Actions                     |

## Repository Layout

```text
patze-control/
├── apps/
│   ├── api-server/        REST + SSE control plane
│   └── desktop/           Tauri + React application
├── packages/
│   ├── telemetry-core/    Event model, ingestor, projections, scheduler, sync
│   ├── control-client/    Browser SSE client with reconnect + dedup
│   └── openclaw-bridge/   Bridge runtime and mappers
├── scripts/               Sidecar/build/bridge helper scripts
└── docs/                  Specs, schemas, test plans
```

## Data Flow (Production Model)

Patze Control supports two ingestion modes that converge into one read model.

```text
                         OpenClaw sources
                  (local files / CLI / remote nodes)
                                  |
                   +--------------+--------------+
                   |                             |
             Push path                       Pull path
     openclaw-bridge -> /ingest(*)      SSH tunnel -> remote /events
                   |                             |
                   +-------------+---------------+
                                 v
                      DefaultTelemetryIngestor
                       (schema + size + dedup)
                                 v
                        InMemoryEventStore
                                 v
                         TelemetryProjector
                                 v
                        TelemetryAggregator
                 (local node + mirrored remote nodes)
                                 v
                              /snapshot
                              /events (SSE)
                                 v
                         desktop control-client
```

### Flow Guarantees

- **At-least-once delivery, idempotent apply**: duplicate event IDs are dropped in ingestion/client layers
- **Single merged view**: local and remote telemetry streams are reduced into one unified snapshot
- **Backpressure-friendly sync**: OpenClaw sync uses timeout loops + exponential backoff (no fixed `setInterval`)
- **Failure containment**: listener fanout uses isolation; one failing subscriber does not break the stream

### Why This Matters

- Push mode is efficient for VPS/edge nodes that continuously emit state
- Pull mode allows incremental adoption where remote API servers already exist
- Both paths keep one operator UX: one desktop, one fleet model, one timeline

## Views

- `Overview`: fleet KPIs and health posture
- `Agents`: derived agent activity and usage
- `Tunnels`: endpoint and VPS bridge lifecycle
- `Machines`: machine-level telemetry cards
- `Sessions`: session lifecycle tracking
- `Channels`: OpenClaw channel config and status
- `Runs`: run timeline + tool/model details
- `Logs`: centralized searchable logs
- `Tasks`: scheduler + target management + doctor checks
- `Settings`: auth, diagnostics, and runtime config

## Prerequisites

- Node.js 22+
- pnpm 9+
- Rust toolchain (for Tauri builds)

Linux/WSL2 packages for Tauri:

```bash
sudo apt install -y pkg-config libsoup-3.0-dev libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev
```

## Quick Start

```bash
pnpm install
pnpm build
pnpm dev
```

Useful dev targets:

```bash
pnpm dev:api-server
pnpm dev:desktop
pnpm dev:desktop:tauri
pnpm dev:openclaw-bridge
```

## Configuration

Create local env files:

```bash
cp apps/api-server/.env.example apps/api-server/.env
cp packages/openclaw-bridge/.env.example packages/openclaw-bridge/.env
```

### API Server (key env)

| Variable               | Default            | Description                         |
| ---------------------- | ------------------ | ----------------------------------- |
| `PORT`                 | `9700`             | API port                            |
| `HOST`                 | `0.0.0.0`          | Bind address                        |
| `TELEMETRY_AUTH_MODE`  | `none`             | `none` or `token`                   |
| `TELEMETRY_AUTH_TOKEN` | —                  | Required when token mode is enabled |
| `PATZE_SETTINGS_DIR`   | `~/.patze-control` | Runtime settings directory          |
| `HEARTBEAT_TIMEOUT_MS` | `120000`           | Offline threshold                   |

`Settings > Authentication` in desktop overrides auth mode/token at runtime and persists to disk.

### OpenClaw Bridge (key env)

| Variable                 | Default                 | Description            |
| ------------------------ | ----------------------- | ---------------------- |
| `CONTROL_PLANE_BASE_URL` | `http://127.0.0.1:9700` | Control plane URL      |
| `CONTROL_PLANE_TOKEN`    | —                       | Bearer token           |
| `MACHINE_ID`             | auto                    | Stable machine ID      |
| `MACHINE_KIND`           | `local`                 | `local` or `vps`       |
| `OPENCLAW_BRIDGE_SOURCE` | `files`                 | `files` or `cli`       |
| `HEARTBEAT_INTERVAL_MS`  | `5000`                  | Poll/heartbeat cadence |

## Scripts

| Command              | Description                           |
| -------------------- | ------------------------------------- |
| `pnpm dev`           | API + desktop concurrently            |
| `pnpm dev:all`       | API + bridge + desktop concurrently   |
| `pnpm build`         | Build workspace packages              |
| `pnpm build:sidecar` | Build API sidecar binary for Tauri    |
| `pnpm build:app`     | Build sidecar + native desktop bundle |
| `pnpm lint`          | Lint all packages                     |
| `pnpm typecheck`     | Type-check all packages               |
| `pnpm test`          | Run telemetry-core tests              |
| `pnpm ci:verify`     | Typecheck + lint + format + test      |
| `pnpm ci:build`      | Full build pipeline                   |

## CI and Governance

- `repo-ci`: quality gates + monorepo build
- `desktop-ci`: web matrix + Windows Tauri artifact
- `workflow-lint`: Action workflow validation
- Dependabot, CODEOWNERS, PR template, and issue templates enabled

## API Surface

### Core Telemetry

- `GET /health`
- `POST /ingest`
- `POST /ingest/batch`
- `GET /snapshot`
- `GET /events`

### Remote and Tunnels

- `POST /remote/attach`
- `POST /remote/detach`
- `GET /remote/attachments`
- `GET /tunnels`

### Tasks

- `GET /tasks`
- `POST /tasks`
- `PATCH /tasks/:taskId`
- `DELETE /tasks/:taskId`
- `POST /tasks/:taskId/run`
- `GET /tasks/history`
- `GET /tasks/snapshots`
- `POST /tasks/rollback/:snapshotId`
- `GET /tasks/events`

### OpenClaw Targets and Channels

- `GET /openclaw/targets`
- `POST /openclaw/targets`
- `PATCH /openclaw/targets/:targetId`
- `DELETE /openclaw/targets/:targetId`
- `GET /openclaw/targets/:targetId/jobs`
- `GET /openclaw/targets/:targetId/runs/:jobId`
- `GET /openclaw/targets/:targetId/health`
- `GET /openclaw/channels`

### Bridge Management

- `POST /bridge/setup`
- `GET /bridge/managed`
- `GET /bridge/managed/:id`
- `POST /bridge/managed/:id/disconnect`
- `DELETE /bridge/managed/:id`
- `GET /bridge/connections`
- `POST /openclaw/bridge/cron-sync`

## VPS Bridge Quick Connect

From terminal:

```bash
./scripts/connect-vps.sh root@your-vps-ip --token YOUR_TOKEN
```

With explicit ports/expiry:

```bash
./scripts/connect-vps.sh root@your-vps-ip \
  --token YOUR_TOKEN \
  --local-port 9700 \
  --remote-port 19700 \
  --expires-in 7d
```

## Install

Download the latest release for your platform from [GitHub Releases](https://github.com/goiltpatpat/patze-control/releases):

| Platform              | Format                     |
| --------------------- | -------------------------- |
| macOS (Apple Silicon) | `.dmg`                     |
| macOS (Intel)         | `.dmg`                     |
| Windows               | `.exe` installer, portable |
| Linux                 | `.deb` / `.AppImage`       |

## Releasing

Releases are automated via GitHub Actions. To cut a new release:

```bash
# 1. Generate signing keys (first time only)
pnpm --filter @patze/desktop tauri signer generate -w ~/.tauri/patze-control.key

# 2. Add secrets to GitHub repo settings:
#    TAURI_SIGNING_PRIVATE_KEY      — contents of ~/.tauri/patze-control.key
#    TAURI_SIGNING_PRIVATE_KEY_PASSWORD — the password you chose

# 3. Copy the public key into apps/desktop/src-tauri/tauri.conf.json → plugins.updater.pubkey

# 4. Tag and push
git tag v0.1.0
git push origin v0.1.0
```

The `release.yml` workflow builds for all platforms and publishes a GitHub Release with installers and auto-update manifest (`latest.json`).

## Reliability and Security Notes

- Event ID dedup across ingest/client paths
- Constant-time token comparison for auth
- Size limits on ingest and bridge sync payloads
- Per-machine rate limiting on bridge sync endpoint
- Snapshot rollback for task config recovery
- Atomic persistence for critical local state files

## License

[MIT](LICENSE)
