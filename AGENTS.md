# Patze Control — Agent Instructions

## Cursor Cloud specific instructions

### Overview

Patze Control is a Tauri 2 desktop control plane for OpenClaw AI agent fleets. In dev mode it runs as two services accessible via browser (no Rust/Tauri required):

| Service | Port | Start command |
|---------|------|---------------|
| API Server (Fastify 5) | 9700 | `pnpm dev:api-server` |
| Desktop UI (Vite + React) | 1420 | `pnpm dev:desktop` |

Run both concurrently with `pnpm dev`. No external databases, Docker, or third-party services are required — all state is in-memory or JSON file-based (`~/.patze-control/`).

### Key commands

See `package.json` root scripts. Summary:

- **Dev**: `pnpm dev` (builds `telemetry-core` first, then starts API + UI concurrently)
- **Lint**: `pnpm lint`
- **Test**: `pnpm test` (runs `telemetry-core` tests via Node.js built-in test runner)
- **Typecheck**: `pnpm typecheck` (builds `telemetry-core` + `control-client` first, then typechecks all)
- **Format**: `pnpm format` (Prettier check) / `pnpm format:write` (auto-fix)
- **Full CI check**: `pnpm ci:verify`

### Non-obvious caveats

- **Build order matters**: `telemetry-core` must be built before `api-server`, `control-client`, or `desktop` can typecheck or run. The dev scripts handle this automatically, but if you run individual package commands directly, build `telemetry-core` first (`pnpm --filter @patze/telemetry-core build`).
- **`control-client` must also be built** before `desktop` typecheck (`pnpm --filter @patze/control-client build`). The root `typecheck` script handles this.
- **Telemetry envelope format** requires `version`, `id`, `ts`, `machineId`, `severity`, `type`, `payload`, and `trace` fields. See `packages/telemetry-core/src/ingestor.test.ts` for a working example.
- **No Rust toolchain needed** for web dev mode. Rust is only required for native Tauri builds (`pnpm dev:desktop:tauri`, `pnpm build:app`).
- **.env files**: Copy `apps/api-server/.env.example` to `apps/api-server/.env` and `packages/openclaw-bridge/.env.example` to `packages/openclaw-bridge/.env` before running dev servers.
