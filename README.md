# Patze Control

[![CI](https://github.com/goiltpatpat/patze-control/actions/workflows/ci.yml/badge.svg)](https://github.com/goiltpatpat/patze-control/actions/workflows/ci.yml)
[![Desktop CI](https://github.com/goiltpatpat/patze-control/actions/workflows/desktop-ci.yml/badge.svg)](https://github.com/goiltpatpat/patze-control/actions/workflows/desktop-ci.yml)
[![Workflow Lint](https://github.com/goiltpatpat/patze-control/actions/workflows/workflow-lint.yml/badge.svg)](https://github.com/goiltpatpat/patze-control/actions/workflows/workflow-lint.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7+-3178c6.svg)](https://www.typescriptlang.org/)
[![Tauri](https://img.shields.io/badge/Tauri-2-ffc131.svg)](https://tauri.app/)

Real-time telemetry monitoring desktop application for [OpenClaw](https://github.com/goiltpatpat/openclaw-patzelife) AI agents.
Track machines, agents, sessions, runs, tool calls, model usage and logs — across multiple OpenClaw instances — from a single dashboard.

Built on event sourcing with SSH tunnel support for multi-machine monitoring.

## Key Features

- **Real-time dashboard** — live CPU, memory, disk gauges, activity feed, cost summary
- **Multi-OpenClaw** — connect to multiple remote machines via SSH tunnels simultaneously
- **Multi-target OpenClaw management** — manage multiple OpenClaw installations (local + remote VPS) with per-target sync, health checks, and doctor diagnostics
- **Scheduled task system** — cron-like scheduler with `at`, `every`, `cron` expressions, webhook delivery, health checks, OpenClaw job execution, run history, snapshots/rollback
- **Agent monitoring** — derived agent view with active/idle status, token usage, estimated cost
- **Session & run tracking** — full lifecycle with state transitions, failure reasons, drill-down
- **Tool call inspection** — per-run tool calls with name, status, duration, errors
- **Centralized logs** — level filtering, full-text search, auto-scroll
- **Circuit breaker resilience** — adaptive polling with exponential backoff for sync failures
- **VPS bridge setup from UI** — connect VPS running OpenClaw directly from the Connections page (SSH reverse tunnel + auto-install bridge agent)
- **Runtime auth management** — enable/disable token auth from Settings UI, persisted across restarts
- **Token-based auth** — HMAC comparison, no credential storage, event deduplication
- **Desktop-native** — Tauri 2 for lightweight, cross-platform native app

## Tech Stack

| Layer    | Technology                                                  |
| -------- | ----------------------------------------------------------- |
| Monorepo | pnpm workspaces                                             |
| Language | TypeScript 5.7+ (strict mode, `exactOptionalPropertyTypes`) |
| Desktop  | Tauri 2 + React 18 + Vite 6                                 |
| Backend  | Fastify 5 (telemetry ingest + SSE streaming)                |
| SSH      | ssh2 (remote node attachment via TCP tunnels)               |
| Linting  | ESLint 9 + Prettier 3                                       |
| CI       | GitHub Actions (lint + typecheck + desktop build)           |

## Architecture

```
patze-control/
├── apps/
│   ├── api-server/            Fastify control-plane (REST + SSE + SSH orchestration)
│   ├── desktop/               Tauri + React desktop app (10 views, 15+ components)
│   └── openclaw-bridge/       Bridge deployment entry point
├── packages/
│   ├── telemetry-core/        Domain kernel: events, ingestor, projections, transports
│   ├── control-client/        Browser-side SSE client with reconnection & dedup
│   └── openclaw-bridge/       Bridge agent: polls OpenClaw → emits telemetry events
└── docs/                      Specs, schemas, checklists
```

### Data Flow

Two pathways feed data into the control plane:

```
                    ┌─ Push Model ─────────────────────────────────────────────┐
                    │                                                          │
                    │  OpenClaw Machine                                        │
                    │  ┌────────────────┐    HTTP POST     ┌────────────────┐  │
                    │  │ openclaw-bridge │──/ingest/batch─→ │  API Server    │  │
                    │  │ (polls CLI or   │   telemetry      │  (Fastify)     │  │
                    │  │  session files) │   events         │                │  │
                    │  └────────────────┘                   │  Ingestor      │  │
                    │                                       │    ↓           │  │
                    │                                       │  EventStore    │  │
                    ├─ Pull Model (Multi-OpenClaw) ────────→│    ↓           │  │
                    │                                       │  Aggregator    │  │
                    │  Remote Machine B                     │    ↓  ↑       │  │
                    │  ┌────────────────┐    SSH Tunnel     │  Mirror Nodes  │  │
                    │  │ api-server (B) │←─────────────────│  (per remote)  │  │
                    │  └────────────────┘    SSE pull       │                │  │
                    │                                       └───────┬────────┘  │
                    │  Remote Machine C                             │           │
                    │  ┌────────────────┐    SSH Tunnel             │ SSE       │
                    │  │ api-server (C) │←─────────────────        │ /events   │
                    │  └────────────────┘                           ↓           │
                    │                                       ┌────────────────┐  │
                    │                                       │  Desktop App   │  │
                    │                                       │  (React+Tauri) │  │
                    │                                       └────────────────┘  │
                    └──────────────────────────────────────────────────────────┘
```

**Push model** — `openclaw-bridge` daemon runs on each machine, polls OpenClaw every 5s, translates runs/sessions into telemetry events, sends via HTTP batch.

**Pull model** — API server opens SSH tunnels to remote `api-server` instances, creates a mirror `TelemetryNode` per connection, streams events via tunneled SSE. All nodes merge into a single `Aggregator` → unified snapshot.

### Telemetry Events

11 event types flowing through the pipeline:

| Event                   | Description                                           |
| ----------------------- | ----------------------------------------------------- |
| `machine.registered`    | Machine comes online with name, kind, status          |
| `machine.heartbeat`     | Periodic health: CPU, memory, disk usage              |
| `session.state.changed` | Session lifecycle transitions (inferred from runs)    |
| `run.state.changed`     | Run lifecycle with failure reasons                    |
| `run.tool.started`      | Tool call began                                       |
| `run.tool.completed`    | Tool call finished with status and duration           |
| `run.model.usage`       | LLM token usage: provider, model, in/out tokens, cost |
| `run.log.emitted`       | Log entry with level and message                      |
| `agent.state.changed`   | Agent lifecycle (future — currently derived)          |
| `run.resource.usage`    | Per-run resource consumption (future)                 |
| `trace.span.recorded`   | Distributed trace spans (future)                      |

### Desktop UI

10 views accessible via hash routing:

| View            | Purpose                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------ |
| **Overview**    | Dashboard with cost summary, fleet health, activity feed                                                     |
| **Agents**      | Derived agent list — active/idle, machines, tokens, cost                                                     |
| **Connections** | Primary + remote endpoints + VPS bridge management (add / connect / disconnect / live logs)                  |
| **Machines**    | Machine cards with live CPU, memory, disk gauges                                                             |
| **Sessions**    | Session listing with state filters, channel origin badges, and drill-down                                    |
| **Channels**    | OpenClaw channel configuration status — DM policy, groups, connection health                                 |
| **Runs**        | Run listing with expandable detail (tools, model usage)                                                      |
| **Logs**        | Centralized log viewer with level filter and search                                                          |
| **Tasks**       | Scheduled tasks + OpenClaw multi-target management (target cards, stats bar, doctor checks, add/edit/delete) |
| **Settings**    | Connection info, auth token management, diagnostics doctor                                                   |

## Prerequisites

- Node.js 22+
- pnpm 9+
- Rust toolchain (for Tauri desktop builds)

### Linux / WSL2

Tauri requires native dependencies on Linux:

```bash
sudo apt install -y pkg-config libsoup-3.0-dev libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev
```

## Getting Started

```bash
# Install dependencies
pnpm install

# Build all packages
pnpm build

# Start API server (control plane)
pnpm dev:api-server

# Start desktop UI (web mode)
pnpm dev:desktop

# Start desktop UI (native Tauri)
pnpm dev:desktop:tauri

# Start OpenClaw bridge (on each monitored machine)
pnpm dev:openclaw-bridge
```

## Configuration

Copy the example files and adjust:

```bash
cp apps/api-server/.env.example apps/api-server/.env
cp packages/openclaw-bridge/.env.example packages/openclaw-bridge/.env
```

### API Server

| Variable               | Default            | Description                                               |
| ---------------------- | ------------------ | --------------------------------------------------------- |
| `PORT`                 | `9700`             | HTTP listen port                                          |
| `HOST`                 | `0.0.0.0`          | Bind address                                              |
| `TELEMETRY_AUTH_MODE`  | `none`             | `none` or `token` (overridden by UI settings)             |
| `TELEMETRY_AUTH_TOKEN` | —                  | Required when mode is `token` (overridden by UI settings) |
| `PATZE_SETTINGS_DIR`   | `~/.patze-control` | Directory for persisted settings (auth.json)              |
| `HEARTBEAT_TIMEOUT_MS` | `120000`           | Mark machine offline after this silence                   |

> **Auth from UI:** Token auth can be enabled/disabled from **Settings > Authentication** in the desktop app. The setting is persisted to `~/.patze-control/auth.json` and takes priority over environment variables.

### OpenClaw Bridge

| Variable                 | Default                 | Description                                                          |
| ------------------------ | ----------------------- | -------------------------------------------------------------------- |
| `CONTROL_PLANE_BASE_URL` | `http://127.0.0.1:9700` | API server URL to push events                                        |
| `CONTROL_PLANE_TOKEN`    | —                       | Bearer token (must match API server)                                 |
| `MACHINE_ID`             | auto-generated          | Stable machine identifier                                            |
| `MACHINE_LABEL`          | hostname                | Display name in UI                                                   |
| `MACHINE_KIND`           | `local`                 | `local` or `vps`                                                     |
| `OPENCLAW_BRIDGE_SOURCE` | `files`                 | `cli` (runs `openclaw runs --json`) or `files` (reads session files) |
| `OPENCLAW_SESSION_DIR`   | `~/.openclaw/sessions`  | Session files directory (for `files` source)                         |
| `OPENCLAW_BIN`           | `openclaw`              | Binary name/path (for `cli` source)                                  |
| `OPENCLAW_CLI_ARGS`      | `runs --json`           | CLI arguments (for `cli` source)                                     |
| `HEARTBEAT_INTERVAL_MS`  | `5000`                  | Heartbeat + poll interval                                            |

## Scripts

| Command                      | Description                                           |
| ---------------------------- | ----------------------------------------------------- |
| `pnpm dev`                   | Start API server + desktop UI concurrently            |
| `pnpm dev:all`               | Start API server + bridge + desktop UI concurrently   |
| `pnpm dev:api-server`        | Start API server in dev mode                          |
| `pnpm dev:desktop`           | Start desktop frontend in dev mode                    |
| `pnpm dev:desktop:tauri`     | Start desktop as native Tauri app                     |
| `pnpm dev:openclaw-bridge`   | Start OpenClaw bridge in dev mode                     |
| `pnpm build`                 | Build all packages                                    |
| `pnpm build:api-server`      | Build API server + telemetry-core                     |
| `pnpm build:desktop`         | Build desktop web bundle                              |
| `pnpm build:openclaw-bridge` | Build OpenClaw bridge                                 |
| `pnpm build:sidecar`         | Build API server as Tauri sidecar binary              |
| `pnpm build:app`             | Build sidecar + native desktop app                    |
| `pnpm lint`                  | Lint all packages                                     |
| `pnpm format`                | Check formatting (Prettier)                           |
| `pnpm format:write`          | Auto-fix formatting                                   |
| `pnpm typecheck`             | Type-check all packages                               |
| `pnpm test`                  | Run telemetry-core test suite                         |
| `pnpm ci:verify`             | Repo quality gates (typecheck + lint + format + test) |
| `pnpm ci:build`              | Build all workspace packages                          |

## GitHub Workflow Readiness

- `repo-ci`: quality gates and full monorepo build on PR/push to `main`
- `desktop-ci`: desktop-focused matrix build (web + Windows Tauri artifact)
- `workflow-lint`: validates workflow files with `actionlint`
- `dependabot`: weekly dependency and GitHub Actions update PRs
- `PR template`, `Issue templates`, and `CODEOWNERS` enabled for governance

## API Endpoints

### Telemetry & Core

| Method | Path            | Description                                |
| ------ | --------------- | ------------------------------------------ |
| `GET`  | `/health`       | Health check                               |
| `POST` | `/ingest`       | Ingest single telemetry event              |
| `POST` | `/ingest/batch` | Ingest batch of events                     |
| `GET`  | `/snapshot`     | Full frontend snapshot (current state)     |
| `GET`  | `/events`       | SSE stream for real-time telemetry updates |

### Remote & Tunnels

| Method | Path                  | Description                           |
| ------ | --------------------- | ------------------------------------- |
| `POST` | `/remote/attach`      | Attach remote OpenClaw via SSH tunnel |
| `POST` | `/remote/detach`      | Detach remote endpoint                |
| `GET`  | `/remote/attachments` | List active remote attachments        |
| `GET`  | `/tunnels`            | List active SSH tunnels               |

### Scheduled Tasks

| Method   | Path                          | Description                                     |
| -------- | ----------------------------- | ----------------------------------------------- |
| `GET`    | `/tasks`                      | List all scheduled tasks                        |
| `POST`   | `/tasks`                      | Create a scheduled task                         |
| `PATCH`  | `/tasks/:taskId`              | Update a task                                   |
| `DELETE` | `/tasks/:taskId`              | Delete a task                                   |
| `POST`   | `/tasks/:taskId/run`          | Trigger immediate task execution                |
| `GET`    | `/tasks/history`              | Get run history (optionally filtered by taskId) |
| `GET`    | `/tasks/snapshots`            | List task configuration snapshots               |
| `POST`   | `/tasks/rollback/:snapshotId` | Rollback tasks to a snapshot                    |
| `GET`    | `/tasks/events`               | SSE stream for task + OpenClaw sync events      |

### OpenClaw Multi-Target

| Method   | Path                                      | Description                                   |
| -------- | ----------------------------------------- | --------------------------------------------- |
| `GET`    | `/openclaw/targets`                       | List all OpenClaw targets                     |
| `POST`   | `/openclaw/targets`                       | Add a new target                              |
| `PATCH`  | `/openclaw/targets/:targetId`             | Update target settings                        |
| `DELETE` | `/openclaw/targets/:targetId`             | Remove a target                               |
| `GET`    | `/openclaw/targets/:targetId/jobs`        | List jobs for a target                        |
| `GET`    | `/openclaw/targets/:targetId/runs/:jobId` | Get run history for a job                     |
| `GET`    | `/openclaw/targets/:targetId/health`      | Doctor health check for a target              |
| `GET`    | `/openclaw/channels`                      | Channel configuration and status for a target |

### VPS Bridge Management

| Method   | Path                             | Description                                            |
| -------- | -------------------------------- | ------------------------------------------------------ |
| `POST`   | `/bridge/setup`                  | Start VPS bridge setup (SSH tunnel + optional install) |
| `GET`    | `/bridge/managed`                | List managed bridges with status and logs              |
| `GET`    | `/bridge/managed/:id`            | Get specific bridge state                              |
| `POST`   | `/bridge/managed/:id/disconnect` | Disconnect a managed bridge                            |
| `DELETE` | `/bridge/managed/:id`            | Remove a managed bridge                                |
| `GET`    | `/bridge/connections`            | List bridge data connections (received telemetry)      |
| `POST`   | `/openclaw/bridge/cron-sync`     | Receive incremental cron data from bridge              |

### Auth Settings

| Method | Path             | Description                            |
| ------ | ---------------- | -------------------------------------- |
| `GET`  | `/settings/auth` | Get current auth mode                  |
| `POST` | `/settings/auth` | Update auth mode and token (persisted) |

### OpenClaw Legacy (backward-compatible)

| Method | Path                         | Description                               |
| ------ | ---------------------------- | ----------------------------------------- |
| `GET`  | `/openclaw/cron/jobs`        | List jobs from default target             |
| `GET`  | `/openclaw/health`           | Health check for default target           |
| `GET`  | `/openclaw/cron/runs/:jobId` | Run history from default target           |
| `GET`  | `/openclaw/cron/merged`      | Merged view (Patze tasks + OpenClaw jobs) |

## Connecting a VPS Running OpenClaw

Two ways to connect a remote VPS:

### From the Desktop App (recommended)

1. Go to **Settings > Authentication** and enable token auth
2. Go to **Connections > VPS Bridges** and click **+ Connect VPS**
3. Fill in your VPS SSH details (host, user, key path) and the same auth token
4. Click **Connect** — the app establishes a reverse SSH tunnel and installs the bridge agent

The bridge agent pushes incremental cron job data and run history back through the tunnel automatically.

### From the Terminal

```bash
# From the project root on your desktop
./scripts/connect-vps.sh root@your-vps-ip --token YOUR_TOKEN

# With custom ports and token expiry
./scripts/connect-vps.sh root@your-vps-ip \
  --token YOUR_TOKEN \
  --local-port 9700 \
  --remote-port 19700 \
  --expires-in 7d
```

The script opens a reverse SSH tunnel (using `autossh` if available) and remotely installs the bridge agent as a systemd service.

## Production Hardening

- **Event deduplication** — mapper + control-client both deduplicate
- **Session memory eviction** — cap 5,000 sessions + 10 min TTL after terminal
- **Late event handling** — runs arriving after session terminal are ignored
- **HMAC-based auth** — constant-time token comparison
- **Toast deduplication** — deterministic keys with 2 min TTL window
- **Fetch timeouts** — all network calls have explicit timeouts
- **Error boundaries** — React error boundaries with graceful degradation
- **Credential security** — `localStorage` stores config only, never secrets
- **Runtime auth persistence** — auth settings saved to disk, survive API server restarts
- **Bridge rate limiting** — per-machine rate limit on cron-sync endpoint (60 req/min)
- **Body size limits** — 1 MB for telemetry ingest, 4 MB for cron sync
- **Persistent machine identity** — UUID generated once per VPS, stored at `/etc/patze-bridge/machine-id`
- **Token expiry support** — bridge tokens can have time-limited validity

## License

[MIT](LICENSE)
