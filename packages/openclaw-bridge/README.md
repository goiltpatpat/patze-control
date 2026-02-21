# OpenClaw Bridge

`@patze/openclaw-bridge` is the single source of truth for translating OpenClaw runtime state into `telemetry.v1` envelopes and forwarding them to Patze Control.

## Behavior

- On startup: emits `machine.registered`
- On interval: emits `machine.heartbeat`
- On run state changes: emits `run.state.changed`

## Source Modes

- `files` (default): read JSON files from `OPENCLAW_SESSION_DIR`
- `cli`: execute `OPENCLAW_BIN` with `OPENCLAW_CLI_ARGS`

## Environment

- `CONTROL_PLANE_BASE_URL` (default: `http://127.0.0.1:8080`)
- `CONTROL_PLANE_TOKEN` (optional)
- `MACHINE_ID` (optional; persisted if omitted)
- `MACHINE_LABEL` (default: hostname)
- `MACHINE_KIND` (`local` | `vps`, default: `local`)
- `OPENCLAW_BRIDGE_SOURCE` (`files` | `cli`, default: `files`)
- `OPENCLAW_SESSION_DIR` (default: `~/.openclaw/sessions`)
- `OPENCLAW_BIN` (default: `openclaw`)
- `OPENCLAW_CLI_ARGS` (default: `runs --json`)
- `HEARTBEAT_INTERVAL_MS` (default: `5000`)
