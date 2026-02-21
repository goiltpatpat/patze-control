# Desktop Release Checklist (Windows-first)

## 1) CI Matrix (must be green)
- `desktop-web-matrix` on `ubuntu-latest`
- `desktop-web-matrix` on `windows-latest`
- `desktop-tauri-windows` on `windows-latest`
- Confirm artifacts are uploaded from `desktop-tauri-windows`

Reference workflow: `.github/workflows/desktop-ci.yml`

## 2) Security Baseline
- Confirm `apps/desktop/src-tauri/tauri.conf.json` has `"withGlobalTauri": false`.
- Confirm CSP is explicit and not `null`.
- Confirm no shell plugin is enabled unless explicitly needed.
- Confirm no fs plugin is enabled unless explicitly needed.
- Confirm no broad allow-all capability is introduced.

## 3) Local Preflight (before tagging)
- `pnpm install --frozen-lockfile`
- `pnpm typecheck`
- `pnpm build:desktop`
- `pnpm --filter @patze/desktop tauri build` (on Windows machine/runner)

## 4) Functional Verification (desktop app)
- Launch app and verify:
  - Connection panel starts in `idle`
  - Connect shows `connecting`
  - Healthy stream transitions to `connected`
  - Temporary stream loss transitions to `degraded`
  - Stream recovery transitions back to `connected`
  - Auth failure (`401/403`) shows explicit auth error
  - Disconnect returns to `idle` and stops updates

## 5) SSE/Reconnect Verification
- Force remote `/events` disconnect.
- Verify no tight reconnect loop (backoff behavior visible in logs/network cadence).
- Verify snapshot is retained while degraded.
- Verify reconnect does not crash app and new events continue applying.

## 6) Packaging Verification (Windows)
- Installer exists (`.exe` NSIS and/or `.msi` if configured).
- Installer can install and launch app successfully.
- App startup has no console/runtime exceptions.
- Connection + monitor flow works on installed build.

## 7) Release Gate
- If any checklist item fails, do not tag release.
- Tag only when CI matrix is green and Windows installer verification is complete.

## 8) Known v1 Limits (accepted)
- No virtualization yet for very large tables (1000+ rows may degrade UI responsiveness).
- No SSE resume protocol (`Last-Event-ID`) end-to-end yet.
- No signed code-notarization pipeline yet.
