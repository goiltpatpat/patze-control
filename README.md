<p align="center">
  <img src="apps/desktop/public/Patzeclaw.svg" width="80" alt="Patze Control" />
</p>

<h1 align="center">Patze Control</h1>

<p align="center">
  Desktop control plane for <a href="https://github.com/nicepkg/openclaw">OpenClaw</a> fleets.<br/>
  Fleet&nbsp;telemetry,&nbsp;config&nbsp;diffs,&nbsp;and&nbsp;reverse&nbsp;SSH&nbsp;tunnels&nbsp;—&nbsp;unified&nbsp;in&nbsp;one&nbsp;Tauri&nbsp;desktop.
</p>

<p align="center">
  <a href="https://github.com/goiltpatpat/patze-control/actions/workflows/ci.yml"><img src="https://github.com/goiltpatpat/patze-control/actions/workflows/ci.yml/badge.svg?branch=main" alt="repo-ci" /></a>
  <a href="https://github.com/goiltpatpat/patze-control/actions/workflows/desktop-ci.yml"><img src="https://github.com/goiltpatpat/patze-control/actions/workflows/desktop-ci.yml/badge.svg?branch=main" alt="desktop-ci" /></a>
  <a href="https://github.com/goiltpatpat/patze-control/actions/workflows/workflow-lint.yml"><img src="https://github.com/goiltpatpat/patze-control/actions/workflows/workflow-lint.yml/badge.svg?branch=main" alt="workflow-lint" /></a>
  <br/>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT" /></a>
  <img src="https://img.shields.io/badge/TypeScript-5.7+-3178c6.svg" alt="TypeScript" />
  <img src="https://img.shields.io/badge/Tauri-2-ffc131.svg" alt="Tauri" />
  <img src="https://img.shields.io/badge/React-19-61dafb.svg" alt="React" />
  <img src="https://img.shields.io/badge/Fastify-5-000.svg" alt="Fastify" />
</p>

---

## Highlights

- **Full config management** — CRUD agents, model profiles, and channel bindings through a visual UI backed by a command queue with preview → apply → rollback
- **Real-time fleet telemetry** — SSE snapshots, cost analytics, session tracking, and run timelines across local + VPS targets
- **VPS bridge onboarding** — reverse SSH tunnels with SSH alias auto-resolution from `~/.ssh/config`
- **SFTP file manager** — browse, upload, download, rename, and manage files on any connected remote
- **Built-in recipe catalog** — one-click OpenClaw setup wizards with parameterized execution
- **3D virtual office** — interactive agent workspace with voxel avatars, desks, and live status

## Stack

| Layer    | Technology                                               |
| -------- | -------------------------------------------------------- |
| Monorepo | pnpm workspaces                                          |
| Language | TypeScript 5.7+ (`strict`, `exactOptionalPropertyTypes`) |
| Desktop  | Tauri 2 + React 18 + Vite 6                              |
| 3D       | React Three Fiber + Drei                                 |
| API      | Fastify 5 + SSE                                          |
| Remote   | `ssh2` tunnels + SFTP + bridge push                      |
| Quality  | ESLint 9, Prettier 3, GitHub Actions CI                  |

## Repository Layout

```text
patze-control/
├── apps/
│   ├── api-server/          REST + SSE control plane (Fastify)
│   └── desktop/             Tauri + React application
├── packages/
│   ├── telemetry-core/      Event model, ingestor, projections, scheduler, sync
│   ├── control-client/      Browser SSE client with reconnect + dedup
│   └── openclaw-bridge/     Bridge runtime and mappers
├── scripts/                 Sidecar, build, and bridge helper scripts
└── docs/                    Specs, schemas, test plans
```

## Views

| View               | Description                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| **Overview**       | Fleet KPIs, cost summary, health posture, activity heatmap, quick nav  |
| **Agents**         | Agent profiles with CRUD, model assignment, cost/token tracking        |
| **Models**         | Model profile management — provider, API key, base URL per target      |
| **Channels**       | Channel config, DM/group policies, agent binding, account summaries    |
| **Runs**           | Filterable run timeline with session/agent/machine drill-down          |
| **Sessions**       | Session lifecycle by origin (WhatsApp, Telegram, Slack, Discord, cron) |
| **Machines**       | Machine-level gauges (CPU, memory, disk) with health badges            |
| **System Monitor** | Fleet-wide resource monitoring with per-machine network rate           |
| **Logs**           | Centralized searchable logs with level filtering                       |
| **Tasks**          | Scheduler (`at`/`every`/`cron`), run history, snapshots, rollback      |
| **Tunnels**        | VPS bridge lifecycle, SSH setup, credential management, log panel      |
| **Costs**          | Cost analytics by agent, model, and timeline with token breakdown      |
| **File Manager**   | SFTP remote file browser with upload, download, rename, mkdir          |
| **Workspace**      | Multi-root file explorer with editor, syntax highlighting, search      |
| **Memory Browser** | Per-agent memory files (MEMORY.md, SOUL.md, TASKS.md, etc.)            |
| **Terminal**       | Safe terminal with allowlisted commands and quick-action buttons       |
| **Recipes**        | Built-in recipe catalog with parameterized CookWizard execution        |
| **Settings**       | Auth, diagnostics, config history with diff viewer and rollback        |
| **Office 3D**      | Interactive voxel office — agent desks, avatars, minimap, camera modes |

## Data Flow

```text
                       OpenClaw sources
                (local files / CLI / remote nodes)
                                |
                 +--------------+--------------+
                 |                             |
           Push path                       Pull path
   openclaw-bridge → /ingest          SSH tunnel → remote /events
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
                         /snapshot  /events (SSE)
                               v
                       Desktop control-client
```

**Guarantees:**

- At-least-once delivery with idempotent dedup across ingest and client layers
- Single merged view from local + remote telemetry streams
- Backpressure-friendly sync using timeout loops + exponential backoff
- Failure-isolated listener fanout — one bad subscriber cannot break the stream

## Prerequisites

- **Node.js** 22+
- **pnpm** 9+
- **Rust** toolchain (for Tauri builds only)

Linux/WSL2 system packages for Tauri:

```bash
sudo apt install -y pkg-config libsoup-3.0-dev libwebkit2gtk-4.1-dev libjavascriptcoregtk-4.1-dev
```

## Quick Start

```bash
pnpm install
pnpm dev          # Daily dev (auth disabled, isolated local settings)
```

Open `http://localhost:1420` in your browser, or run `pnpm dev:desktop:tauri` for the native window.

### Dev Targets

- `pnpm dev*` uses isolated settings (`PATZE_SETTINGS_DIR=.patze-control-dev`) with `TELEMETRY_AUTH_MODE=none` for frictionless local work.
- `pnpm dev:secure*` uses normal API auth behavior (`none`/`token`) for security-flow verification.

| Command                      | What it runs                         |
| ---------------------------- | ------------------------------------ |
| `pnpm dev`                   | API + desktop (dev-safe auth off)    |
| `pnpm dev:all`               | API + bridge + desktop (auth off)    |
| `pnpm dev:api-server`        | API server only (auth off)           |
| `pnpm dev:secure`            | API + desktop with normal auth flow  |
| `pnpm dev:secure:all`        | API + bridge + desktop (normal auth) |
| `pnpm dev:secure:api-server` | API server only (normal auth)        |
| `pnpm dev:desktop`           | Desktop (Vite) only                  |
| `pnpm dev:desktop:tauri`     | Desktop with native Tauri shell      |
| `pnpm dev:openclaw-bridge`   | OpenClaw bridge only                 |

### Troubleshooting Connect/Auth

If the app UI loads but stays at `Connecting...` or keeps failing to connect:

1. Verify API mode:
   ```bash
   curl -s http://127.0.0.1:9700/health
   ```
   If `authMode` is `token`, you must provide a valid bearer token in the top bar.
2. Verify your token quickly:
   ```bash
   curl -i -H "Authorization: Bearer <your-token>" http://127.0.0.1:9700/snapshot
   ```
   `200` means token is valid. `401` means token is wrong/missing.
3. For daily local dev, prefer:
   ```bash
   pnpm dev
   ```
   This runs with isolated dev settings and `TELEMETRY_AUTH_MODE=none` to avoid auth drift from `~/.patze-control/auth.json`.
4. For auth/security testing, use:
   ```bash
   pnpm dev:secure
   ```
   This keeps normal auth behavior (`none`/`token`) and is intended for auth flow verification.

### Build & Quality

| Command              | Description                        |
| -------------------- | ---------------------------------- |
| `pnpm build`         | Build all workspace packages       |
| `pnpm build:sidecar` | Build API sidecar binary for Tauri |
| `pnpm build:app`     | Sidecar + native desktop bundle    |
| `pnpm lint`          | Lint all packages                  |
| `pnpm typecheck`     | Type-check all packages            |
| `pnpm test`          | Run telemetry-core tests           |
| `pnpm format`        | Check formatting (Prettier)        |
| `pnpm format:write`  | Auto-fix formatting                |
| `pnpm ci:verify`     | Typecheck + lint + format + test   |
| `pnpm ci:build`      | Full build pipeline                |

## Configuration

```bash
cp apps/api-server/.env.example apps/api-server/.env
cp packages/openclaw-bridge/.env.example packages/openclaw-bridge/.env
```

### API Server

| Variable               | Default            | Description                   |
| ---------------------- | ------------------ | ----------------------------- |
| `PORT`                 | `9700`             | API port                      |
| `HOST`                 | `0.0.0.0`          | Bind address                  |
| `TELEMETRY_AUTH_MODE`  | `none`             | `none` or `token`             |
| `TELEMETRY_AUTH_TOKEN` | —                  | Required when mode is `token` |
| `PATZE_SETTINGS_DIR`   | `~/.patze-control` | Runtime settings directory    |
| `HEARTBEAT_TIMEOUT_MS` | `120000`           | Offline threshold             |

Auth mode and token can also be changed at runtime from **Settings > Authentication** in the desktop UI.

### OpenClaw Bridge

| Variable                 | Default                 | Description            |
| ------------------------ | ----------------------- | ---------------------- |
| `CONTROL_PLANE_BASE_URL` | `http://127.0.0.1:9700` | Control plane URL      |
| `CONTROL_PLANE_TOKEN`    | —                       | Bearer token           |
| `MACHINE_ID`             | auto                    | Stable machine ID      |
| `MACHINE_KIND`           | `local`                 | `local` or `vps`       |
| `OPENCLAW_BRIDGE_SOURCE` | `files`                 | `files` or `cli`       |
| `HEARTBEAT_INTERVAL_MS`  | `5000`                  | Poll/heartbeat cadence |

## Connecting to a VPS

### From the UI

1. Go to **Tunnels** and click **+ Bridge Setup**
2. Type your SSH alias (e.g. `my-vps`) or IP address
3. If the host is in `~/.ssh/config`, user/port/key are resolved automatically
4. Click **Run Pre-flight** to verify SSH connectivity
5. Click **Connect** to establish a reverse tunnel + optional bridge install

### From terminal

```bash
./scripts/connect-vps.sh root@your-vps-ip --token YOUR_TOKEN

# With explicit options:
./scripts/connect-vps.sh root@your-vps-ip \
  --token YOUR_TOKEN \
  --local-port 9700 \
  --remote-port 19700 \
  --expires-in 7d
```

## OpenClaw Config Management

Patze Control provides a full visual interface for managing OpenClaw configurations:

**Command Queue workflow:**

1. Changes (add agent, update model, bind channel) are queued as CLI commands
2. **Preview** shows a diff of what will change in `openclaw.json`
3. **Apply** executes the queued commands on the target
4. **Rollback** restores a previous config snapshot if needed

Supported operations:

- **Agents** — create, edit, delete agent profiles
- **Models** — create, edit, delete model profiles (provider, API key, base URL)
- **Channels** — edit DM/group policies, bind/unbind agents
- **Recipes** — pre-built templates for common setups (e.g. "Add Telegram bot with GPT-4o")
- **Config Snapshots** — automatic versioning with diff viewer and one-click rollback

## API Surface

<details>
<summary><strong>Core Telemetry</strong></summary>

| Method | Path            | Description                |
| ------ | --------------- | -------------------------- |
| `GET`  | `/health`       | Health check               |
| `POST` | `/ingest`       | Single event ingestion     |
| `POST` | `/ingest/batch` | Batch event ingestion      |
| `GET`  | `/snapshot`     | Current telemetry snapshot |
| `GET`  | `/events`       | SSE event stream           |

</details>

<details>
<summary><strong>Settings</strong></summary>

| Method | Path             | Description            |
| ------ | ---------------- | ---------------------- |
| `GET`  | `/settings/auth` | Get auth config        |
| `POST` | `/settings/auth` | Update auth mode/token |

</details>

<details>
<summary><strong>Remote & Tunnels</strong></summary>

| Method | Path                  | Description                  |
| ------ | --------------------- | ---------------------------- |
| `POST` | `/remote/attach`      | Attach remote node           |
| `POST` | `/remote/detach`      | Detach remote node           |
| `GET`  | `/remote/attachments` | List remote attachments      |
| `GET`  | `/tunnels`            | List SSH tunnels             |
| `GET`  | `/ssh/config-hosts`   | List SSH config host aliases |

</details>

<details>
<summary><strong>Bridge Management</strong></summary>

| Method   | Path                             | Description             |
| -------- | -------------------------------- | ----------------------- |
| `POST`   | `/bridge/preflight`              | SSH connectivity check  |
| `POST`   | `/bridge/setup`                  | Setup new bridge        |
| `GET`    | `/bridge/managed`                | List managed bridges    |
| `GET`    | `/bridge/managed/:id`            | Bridge detail           |
| `POST`   | `/bridge/managed/:id/disconnect` | Disconnect bridge       |
| `DELETE` | `/bridge/managed/:id`            | Remove bridge           |
| `GET`    | `/bridge/connections`            | List bridge connections |
| `POST`   | `/openclaw/bridge/cron-sync`     | Bridge cron sync        |

</details>

<details>
<summary><strong>Tasks & Scheduler</strong></summary>

| Method   | Path                          | Description           |
| -------- | ----------------------------- | --------------------- |
| `GET`    | `/tasks`                      | List scheduled tasks  |
| `POST`   | `/tasks`                      | Create task           |
| `PATCH`  | `/tasks/:taskId`              | Update task           |
| `DELETE` | `/tasks/:taskId`              | Delete task           |
| `POST`   | `/tasks/:taskId/run`          | Trigger manual run    |
| `GET`    | `/tasks/history`              | Task run history      |
| `GET`    | `/tasks/snapshots`            | Task config snapshots |
| `POST`   | `/tasks/rollback/:snapshotId` | Rollback to snapshot  |
| `GET`    | `/tasks/events`               | SSE task event stream |

</details>

<details>
<summary><strong>OpenClaw Targets</strong></summary>

| Method   | Path                                      | Description                   |
| -------- | ----------------------------------------- | ----------------------------- |
| `GET`    | `/openclaw/targets`                       | List targets with sync status |
| `POST`   | `/openclaw/targets`                       | Add target                    |
| `PATCH`  | `/openclaw/targets/:targetId`             | Update target                 |
| `DELETE` | `/openclaw/targets/:targetId`             | Remove target                 |
| `GET`    | `/openclaw/targets/:targetId/jobs`        | Target cron jobs              |
| `GET`    | `/openclaw/targets/:targetId/runs/:jobId` | Job run history               |
| `GET`    | `/openclaw/targets/:targetId/health`      | Target health check           |

</details>

<details>
<summary><strong>OpenClaw Config (Agents, Models, Channels)</strong></summary>

| Method   | Path                                                     | Description           |
| -------- | -------------------------------------------------------- | --------------------- |
| `GET`    | `/openclaw/targets/:targetId/config`                     | Parsed config         |
| `GET`    | `/openclaw/targets/:targetId/config-raw`                 | Raw config string     |
| `GET`    | `/openclaw/targets/:targetId/agents`                     | List agents           |
| `POST`   | `/openclaw/targets/:targetId/agents`                     | Create agent          |
| `PATCH`  | `/openclaw/targets/:targetId/agents/:agentId`            | Update agent          |
| `DELETE` | `/openclaw/targets/:targetId/agents/:agentId`            | Delete agent          |
| `GET`    | `/openclaw/targets/:targetId/models`                     | List model profiles   |
| `POST`   | `/openclaw/targets/:targetId/models`                     | Create model profile  |
| `PATCH`  | `/openclaw/targets/:targetId/models/:modelId`            | Update model profile  |
| `DELETE` | `/openclaw/targets/:targetId/models/:modelId`            | Delete model profile  |
| `GET`    | `/openclaw/targets/:targetId/bindings`                   | List bindings         |
| `GET`    | `/openclaw/channels`                                     | List channels         |
| `PATCH`  | `/openclaw/targets/:targetId/channels/:channelId`        | Update channel config |
| `POST`   | `/openclaw/targets/:targetId/channels/:channelId/bind`   | Bind agent            |
| `POST`   | `/openclaw/targets/:targetId/channels/:channelId/unbind` | Unbind agent          |

</details>

<details>
<summary><strong>Command Queue & Config Snapshots</strong></summary>

| Method   | Path                                                            | Description     |
| -------- | --------------------------------------------------------------- | --------------- |
| `POST`   | `/openclaw/queue`                                               | Queue commands  |
| `GET`    | `/openclaw/queue/:targetId`                                     | Queue state     |
| `POST`   | `/openclaw/queue/:targetId/preview`                             | Preview diff    |
| `POST`   | `/openclaw/queue/:targetId/apply`                               | Apply commands  |
| `DELETE` | `/openclaw/queue/:targetId`                                     | Discard queue   |
| `GET`    | `/openclaw/targets/:targetId/config-snapshots`                  | List snapshots  |
| `GET`    | `/openclaw/targets/:targetId/config-snapshots/:snapId`          | Snapshot detail |
| `POST`   | `/openclaw/targets/:targetId/config-snapshots/:snapId/rollback` | Rollback        |

</details>

<details>
<summary><strong>Workspace & Memory</strong></summary>

| Method | Path                      | Description          |
| ------ | ------------------------- | -------------------- |
| `GET`  | `/workspace/roots`        | List workspace roots |
| `GET`  | `/workspace/tree`         | Directory listing    |
| `GET`  | `/workspace/file`         | Read file            |
| `PUT`  | `/workspace/file`         | Write file           |
| `GET`  | `/workspace/search`       | Full-text search     |
| `GET`  | `/workspace/memory-files` | Agent memory files   |
| `PUT`  | `/workspace/memory-file`  | Write memory file    |

</details>

<details>
<summary><strong>File Manager (SFTP)</strong></summary>

| Method   | Path                      | Description             |
| -------- | ------------------------- | ----------------------- |
| `GET`    | `/files/connections`      | List SFTP connections   |
| `POST`   | `/files/connections`      | Add SSH connection      |
| `DELETE` | `/files/connections/:id`  | Remove connection       |
| `GET`    | `/files/:connId/ls`       | List remote directory   |
| `GET`    | `/files/:connId/stat`     | Stat remote path        |
| `GET`    | `/files/:connId/download` | Download file           |
| `POST`   | `/files/:connId/upload`   | Upload file (multipart) |
| `POST`   | `/files/:connId/mkdir`    | Create directory        |
| `POST`   | `/files/:connId/rename`   | Rename file/dir         |
| `DELETE` | `/files/:connId/rm`       | Remove file/dir         |

</details>

<details>
<summary><strong>Terminal & Recipes</strong></summary>

| Method | Path                         | Description                 |
| ------ | ---------------------------- | --------------------------- |
| `POST` | `/terminal/exec`             | Execute allowlisted command |
| `GET`  | `/terminal/allowlist`        | List allowed commands       |
| `GET`  | `/recipes`                   | List recipes                |
| `GET`  | `/recipes/:recipeId`         | Recipe detail               |
| `POST` | `/recipes/:recipeId/resolve` | Resolve recipe params       |

</details>

## CI and Governance

- **repo-ci** — quality gates + monorepo build
- **desktop-ci** — web matrix + Windows Tauri artifact
- **workflow-lint** — GitHub Actions workflow validation
- Dependabot, CODEOWNERS, PR template, and issue templates enabled

## Install

Download the latest release from [GitHub Releases](https://github.com/goiltpatpat/patze-control/releases):

| Platform              | Format                     |
| --------------------- | -------------------------- |
| macOS (Apple Silicon) | `.dmg`                     |
| macOS (Intel)         | `.dmg`                     |
| Windows               | `.exe` installer, portable |
| Linux                 | `.deb` / `.AppImage`       |

## Releasing

```bash
# 1. Generate signing keys (first time only)
pnpm --filter @patze/desktop tauri signer generate -w ~/.tauri/patze-control.key

# 2. Add secrets to GitHub repo settings:
#    TAURI_SIGNING_PRIVATE_KEY          — contents of ~/.tauri/patze-control.key
#    TAURI_SIGNING_PRIVATE_KEY_PASSWORD — the password you chose

# 3. Copy the public key into apps/desktop/src-tauri/tauri.conf.json → plugins.updater.pubkey

# 4. Tag and push
git tag v0.1.0
git push origin v0.1.0
```

The `release.yml` workflow builds for all platforms and publishes a GitHub Release with installers and auto-update manifest.

## Security

- Event ID dedup across ingest and client paths
- Constant-time token comparison (HMAC-based)
- Size limits on ingest and bridge sync payloads
- Per-machine rate limiting on bridge sync endpoint
- SSH key path restricted to `~/.ssh/` directory
- Config snapshot rollback for safe recovery
- Atomic persistence for critical local state files

## License

[MIT](LICENSE)
