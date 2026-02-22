# Product Context

_Last updated: 2026-02-22_

## Why This Exists

OpenClaw users running AI agents across multiple machines (local dev, VPS, cloud) need a unified control plane to:

- See what's happening across all machines in real-time
- Schedule recurring tasks (health checks, reports, webhooks)
- Monitor OpenClaw cron jobs without SSH-ing into each server
- Diagnose issues quickly with health checks and doctor diagnostics
- Understand channel risk posture across providers

## Problems Solved

1. **Visibility gap** — No single view across distributed OpenClaw deployments
2. **Manual monitoring** — Checking each machine via CLI is tedious and error-prone
3. **No scheduling** — OpenClaw has cron jobs but no cross-instance management UI
4. **Delayed issue detection** — Without real-time monitoring, failures go unnoticed
5. **Channel risk blindness** — No way to see DM policy, allowFrom wildcards, or account health across providers at a glance

## How It Works

1. **Desktop app connects** to API server (local sidecar or remote)
2. **Telemetry flows in** via push (openclaw-bridge) or pull (SSH tunnel SSE)
3. **Events are projected** into real-time snapshots (machines, sessions, runs, agents)
4. **Tasks are scheduled** with at/every/cron expressions, executed with backoff
5. **OpenClaw targets sync** native cron files with rich schema (stagger, payload, wake mode, runtime state)
6. **Channel intelligence** parses provider configs for policy, allowFrom, account health, and risk scoring
7. **SSE pushes updates** to the UI for sub-second reactivity

## User Experience Goals

- **Zero friction start** — `pnpm dev` gets everything running, auto-connects
- **Glanceable health** — Stats bars, color-coded badges, health indicators at every level
- **Progressive disclosure** — Overview first, click to drill down into details
- **Smart degradation** — Circuit breaker, adaptive polling, request dedup — UI stays responsive even when backends hiccup
- **Keyboard-friendly** — Number keys 1-9 for view switching, tab/enter for navigation
- **Actionable insights** — Risk badges, context-aware recommendations, not just raw data
