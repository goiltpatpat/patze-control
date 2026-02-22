# Project Brief

_Last updated: 2026-02-21_

## Mission

Patze Control is a real-time telemetry monitoring and task management desktop application for OpenClaw AI agents. It provides a single pane of glass to observe, schedule, and control multiple OpenClaw instances across local and remote machines.

## Core Requirements

1. **Real-time monitoring** — Live dashboards for machines, agents, sessions, runs, tool calls, model usage, logs
2. **Multi-machine** — Connect to multiple OpenClaw instances via SSH tunnels or direct HTTP
3. **Scheduled tasks** — Cron-like task scheduler with webhooks, health checks, OpenClaw job execution
4. **Multi-target OpenClaw** — Manage multiple OpenClaw installations (local + remote VPS) from one desktop
5. **Health diagnostics** — Doctor system for per-target health checks with actionable insights
6. **Desktop-native** — Tauri 2 for cross-platform native app with sidecar API server

## Success Criteria

- Zero-config local usage (auto-detect sidecar port, auto-create default OpenClaw target)
- Sub-second SSE updates for task and sync status changes
- Graceful degradation (circuit breaker, adaptive polling, offline-tolerant UI)
- Production-safe (auth, input validation, SSRF protection, atomic persistence)

## Scope Boundaries

- **In scope**: Monitoring, scheduling, OpenClaw sync, health checks, multi-target management
- **Out of scope**: OpenClaw job editing/creation (delegated to OpenClaw CLI), remote code execution
