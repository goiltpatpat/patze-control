# Patze Control

[![CI](https://github.com/goiltpatpat/patze-control/actions/workflows/ci.yml/badge.svg)](https://github.com/goiltpatpat/patze-control/actions/workflows/ci.yml)
[![Desktop CI](https://github.com/goiltpatpat/patze-control/actions/workflows/desktop-ci.yml/badge.svg)](https://github.com/goiltpatpat/patze-control/actions/workflows/desktop-ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Real-time telemetry monitoring desktop application for [OpenClaw](https://github.com/goiltpatpat/openclaw-patzelife) machines, agents, sessions and runs. Built with event sourcing architecture.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Monorepo | pnpm workspaces |
| Language | TypeScript 5.7+ (strict) |
| Desktop | Tauri 2 + React 18 + Vite 6 |
| Backend | Fastify 5 (telemetry ingest + SSE) |
| SSH | ssh2 (remote node attachment) |
| Linting | ESLint 9 + Prettier 3 |

## Architecture

```
patze-control/
├── apps/
│   ├── api-server/          Fastify telemetry ingest server (REST + SSE)
│   ├── desktop/             Tauri + React desktop app (web + native)
│   └── openclaw-bridge/     Bridge agent → forwards OpenClaw events to control plane
├── packages/
│   ├── telemetry-core/      Shared domain: events, projections, transports
│   ├── control-client/      Browser-side SSE client with reconnection
│   └── openclaw-bridge/     Shared bridge types & utilities
└── docs/                    Specs, schemas, checklists
```

### Event Flow

```
OpenClaw Machine → openclaw-bridge → HTTP POST → api-server → EventStore → EventBus
                                                                              ↓
                                                                         Projector
                                                                              ↓
                                                                         Aggregator
                                                                              ↓
                                                              SSE → control-client → Desktop UI
```

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

# Development — API server
pnpm dev:api-server

# Development — Desktop (web only, no Tauri)
pnpm dev:desktop

# Development — Desktop (Tauri native)
pnpm dev:desktop:tauri

# Development — OpenClaw bridge
pnpm dev:openclaw-bridge
```

## Environment Variables

Copy the example files and adjust:

```bash
cp apps/api-server/.env.example apps/api-server/.env
cp packages/openclaw-bridge/.env.example packages/openclaw-bridge/.env
```

See each `.env.example` for available configuration options.

## Scripts

| Command | Description |
|---------|------------|
| `pnpm build` | Build all packages |
| `pnpm build:api-server` | Build API server + telemetry-core |
| `pnpm build:desktop` | Build desktop web bundle |
| `pnpm build:openclaw-bridge` | Build OpenClaw bridge |
| `pnpm dev:api-server` | Start API server in dev mode |
| `pnpm dev:desktop` | Start desktop frontend in dev mode |
| `pnpm dev:desktop:tauri` | Start desktop as native Tauri app |
| `pnpm dev:openclaw-bridge` | Start OpenClaw bridge in dev mode |
| `pnpm lint` | Lint all packages |
| `pnpm format` | Check formatting (Prettier) |
| `pnpm format:write` | Auto-fix formatting |
| `pnpm typecheck` | Type-check all packages |

## License

[MIT](LICENSE)
