# Editable Desktop Phase 0 benchmarks

Measured on 2026-11-23 in the arm64 macOS worktree at `3107728af`, using Node.js 26.7.0 and npm 11.19.0. Each timing is the elapsed `real` value from `/usr/bin/time -p` for a successful command. Commands ran sequentially.

| Operation                                                                                          | Wall time |
| -------------------------------------------------------------------------------------------------- | --------: |
| Dependency readiness check                                                                         |    0.00 s |
| `npm run build:app-deps`                                                                           |   14.90 s |
| `npm run typecheck --workspace=@getpaseo/app`, first run                                           |    4.15 s |
| `npm run typecheck --workspace=@getpaseo/app`, immediate repeat                                    |    3.48 s |
| `npm run typecheck --workspace=@getpaseo/desktop`                                                  |    0.18 s |
| `CI=1 PASEO_WEB_PLATFORM=electron npx --no-install expo export --platform web` from `packages/app` |   38.28 s |
| `npm run lint -- packages/app/src/app/_layout.tsx`                                                 |    0.82 s |

The checkout already had `node_modules` and workspace declarations. The readiness check verified the installed executables, then the app dependency build refreshed the declarations. A fresh `npm ci` was unnecessary and has no timing here. The first app typecheck was the first invocation in the measured sequence after rebuilding dependencies. The OS filesystem cache was left in place. The single-file lint benchmark used the app layout as the representative file because this track makes no app source edits. Oxlint reported 181 ms internally, with zero warnings and errors.

## Expo renderer export

The export produced one SPA entry document. `dist/index.html` loads the 26,560,084-byte script `/_expo/static/js/web/index-ac2a98e652b71d4a83641bf05b9856b9.js` with a root-relative URL. The manifest, touch icon, favicon, and stylesheet URLs also begin at the origin root.

The entry bundle references five root-relative dynamic chunks under `/_expo/static/js/web/`. They are the desktop attachment bridge and store, the IndexedDB attachment store, the native file attachment store, and a secondary `index` bundle. Each filename includes a content hash. The desktop protocol keeps `paseo://app` for all windows. It searches the active release for unscoped assets and then other open windows' pinned releases so a lazy import can fetch its original hash after a switch.

## Upstream desktop auto-updater audit

`packages/desktop/electron-builder.yml` publishes to GitHub `getpaseo/paseo` and uses the upstream desktop application identity. The updater selects the upstream `latest` or `beta` feed, downloads eligible updates, and can install a downloaded update during quit. A newer upstream package can replace a fork installation if the platform accepts it. macOS signing and Windows publisher checks may block a differently signed update, so they cannot be the fork's update policy.

The desktop fork now requires `PASEO_ALLOW_UPSTREAM_DESKTOP_UPDATES=1` for automatic and manual checks, downloads, and installs, including install-on-quit. The guard applies before the first editable release is installed and while the app runs in recovery. The two update mechanisms use different trust roots. Editable renderer updates verify the local Ed25519 key and signed channel before using a release.

## Recovery and previews

Use `--safe-renderer` or `PASEO_SAFE_RENDERER=1` to force the built-in renderer for a launch. The native Editable menu can also switch the current window to the built-in renderer, load the latest installed signed channel, or close preview windows. The menu's recovery action keeps the accepted channel selection on disk so it can be reloaded. A failed trial release is quarantined on disk and rolls back to the last known good release or the built-in UI.

Metro preview windows use a temporary Electron session and open only an explicit HTTP loopback URL. The preview window has no desktop preload. Full desktop integration runs through a signed release.

## Verification

- `npm run test --workspace=@getpaseo/desktop` passed with Node.js 22.23.2 and a temporary `PASEO_HOME`. Vitest reported 480 passed and 9 skipped, including a passing preload sandbox test. The initial sandboxed run on Node 26 encountered loopback and uptime permission errors and a new warning in the console-stream assertions.
- `npm run build:main --workspace=@getpaseo/desktop`, `npm run typecheck --workspace=@getpaseo/desktop`, `npm run lint`, `npm run format:check`, and `git diff --check` passed.
- An isolated Electron 44.2.0 smoke test loaded two signed fixtures through the actual preload and desktop protocol. It checked the lazy chunks for both windows, shared localStorage and IndexedDB, the older window's pin after a reload, recovery from a renderer crash, and immediate recovery when a hidden window's signed entry document became unavailable. It also opened a temporary loopback preview and verified that the desktop bridge was absent.
