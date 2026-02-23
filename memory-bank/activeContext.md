# Active Context

_Last updated: 2026-02-22_

## Current Focus

Major UI/UX overhaul inspired by tenacitOS design patterns. 8 phases of enhancements shipped to `cursor/ui-ux-tenacitos-d014` branch. All CI checks passing (typecheck, lint, format, 16/16 tests).

## Recent Changes (2026-02-22 - Office 3D Rollout)

- Upgraded Office rendering from CSS-isometric-only to a hybrid model with runtime mode switch (`3D` / `Classic`)
- Added `OfficeScene3D` with `three` + `@react-three/fiber` + `@react-three/drei`
- Implemented 3D desk layout mapping from OpenClaw targets with status-based color/emissive cues
- Kept existing task drill-down behavior: selecting a desk still routes into OpenClaw task context
- Preserved safe fallback path by retaining Classic isometric view as a first-class mode
- Added robust rendering fallback: runtime WebGL capability check auto-switches to Classic mode when 3D is unavailable
- Improved scene composition using tenacitOS-inspired light rig + desk labels + centered camera target and dynamic floor bounds

## Recent Changes (2026-02-22 - Feature Parity Sprint)

### Feature 1 - System Monitor Expansion

- Wired `netRxBytes`/`netTxBytes` from telemetry heartbeat payload through projection + frontend reducer
- Added new `SystemMonitorView` route with fleet CPU/MEM/DISK and per-machine telemetry cards
- Implemented network throughput calculation in UI from cumulative counters using prev-snapshot delta/time (`B/s`)
- Added Disk `% used` gauge to `OverviewView` (with strict gauge definition)

### Feature 2 - Full-text Workspace Search

- Added `GET /workspace/search` endpoint with:
  - min query length
  - maxResults cap
  - 5s timeout
  - binary extension skip + 512KB file limit
  - compact result payload (`line`, `lineNumber`, `contextBefore`, `contextAfter`)
  - LRU content cache keyed by `path + mtime`
- Integrated async file search into `CommandPalette` with:
  - debounce 500ms
  - `AbortController` cancellation on new keystrokes
  - file result actions that open file directly in Workspace route

### Feature 3 - Memory Browser + Write Safety

- Added `GET /workspace/memory-files` for OpenClaw memory discovery across targets/workspaces
- Added `PUT /workspace/memory-file` with backend allowlist enforcement (`MEMORY.md`, `SOUL.md`, `TASKS.md`, `CHANGELOG.md`, `CONTEXT.md`, `README.md`)
- Added dedicated `MemoryBrowserView` with agent list, memory tabs, editor, and save controls
- Enforced frontend write allowlist + backend root/path validation (double defense)

### Feature 4 - Office View (Isometric CSS)

- Added new `OfficeView` route (dependency-free, CSS-only isometric floor)
- Office maps OpenClaw targets to desks (agent-centric) with status derivation:
  - active / idle / error / offline
- Added status legend, desk cards, and navigation action into task context

### Routing/UI Shell Updates

- Added new routes: `monitor`, `memory`, `office`
- Updated `SidebarNav` and `MainView` route wiring for all new views
- Extended command palette navigation to include new routes

## Recent Changes (2026-02-22)

### tenacitOS UI/UX Integration (Branch: cursor/ui-ux-tenacitos-d014)

#### Phase 8: Design System Polish

- New CSS variables: `--accent-soft`, `--green-soft`, `--amber-soft`, `--red-soft`, `--blue-soft`, `--muted-soft`
- Event type accent colors (`--type-machine`, `--type-session`, etc.)
- `.accent-line` utility, `.section-header` pattern
- Enhanced badge variants (`.badge-info`, `.badge-success`, `.badge-error`, `.badge-warning`)
- Global scrollbar styling, panel hover transitions, skeleton pulse animation
- ~1150 new lines of CSS covering all 8 phases upfront

#### Phase 1: Command Palette (⌘K)

- `CommandPalette.tsx`: Modal overlay with fuzzy search across views, machines, sessions, runs
- Arrow keys + Enter navigation, Escape to close, backdrop click dismiss
- Results grouped by type with icons and keyboard shortcut hints
- Integrated into `AppShell.tsx` with `Cmd/Ctrl + K` handler

#### Phase 2: Notification Center

- `useNotifications.ts`: Hook with localStorage persistence, max 100 notifications
- `NotificationCenter.tsx`: Bell dropdown with unread badge, type-colored icons
- Mark read, mark all read, delete, clear read operations
- Auto-generates notifications from connection state changes (connected, error, degraded, disconnected)
- Integrated into `TopMachineContextBar.tsx` with search button

#### Phase 3: Enhanced Overview Dashboard

- Quick Links grid: 6 shortcut cards to key views with keyboard hints
- Section Headers: Accent line + uppercase labels for Machines, Active Runs
- Success Rate Bar: Visual progress bar showing run success % with color coding

#### Phase 4: StatusStrip Enhancements

- MiniGauge component: 48px inline bars for CPU/MEM with color coding
- Fleet resource aggregation across all machines
- Uptime counter tracking connection duration

#### Phase 5: Activity Heatmap

- `ActivityHeatmap.tsx`: 7×24 grid (days × hours) from event timestamps
- Accent-colored cells with opacity-based intensity
- Hover tooltip, legend, empty state handling

#### Phase 6: Task Timeline

- `TaskTimeline.tsx`: 7-day forward-looking calendar grid
- Color-coded per task (8-color palette), legend, interval/cron/at support
- Merged patze tasks + openclaw jobs into unified timeline
- New "Timeline" tab in TasksView

#### Phase 7: Quick Notes (Notepad)

- `Notepad.tsx`: Auto-saving textarea with 2s debounce
- localStorage persistence, save status indicator, clear button
- Integrated into OverviewView

### New Icons (13 total)

- IconSearch, IconBell, IconCheck, IconCheckAll, IconX, IconTrash
- IconNote, IconCalendar, IconInfo, IconCheckCircle, IconAlertTriangle, IconXCircle, IconRepeat

## Verification Status

- CI: typecheck ✓, lint ✓, format ✓, test 16/16 ✓
- pnpm ci:verify: FULL GREEN
- Branch: cursor/ui-ux-tenacitos-d014 (9 commits)

## Next Steps

1. Merge UI/UX branch into main via PR
2. Visual testing of all new components in browser
3. Merge open Dependabot PRs (#2-#9) for dependency hygiene
4. Production deployment (Tauri sidecar bundling + installer)
5. E2E tests for multi-target + bridge flows
