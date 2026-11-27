# Editable Paseo

Editable Paseo lets you inspect and modify this personal Paseo fork while using `/Applications/Paseo.app` daily, with isolated Git worktrees, signed UI and daemon hot-swaps, and a read-only live app inspector.

## Architecture and repository topology

Two repositories cooperate at runtime:

1. **Paseo fork (`infi-pc/paseo`, branch `paseo-customizations`)**
   - Upstream mirror `main` stays read-only (see [Maintaining the fork](fork.md)).
   - `~/.editable-paseo/repo` is a dedicated **detached-HEAD** clone tracking `paseo-customizations`. **Never edit files directly inside `~/.editable-paseo/repo`** and keep its `HEAD` detached so `paseo-ed ship` can advance `paseo-customizations` cleanly.
   - Every editing session gets an isolated worktree under `~/.editable-paseo/worktrees/<slug>` on branch `ed/wip/<slug>`.
2. **Standalone CLI and Cloud Shelf (`~/www/playground/editable-paseo`, private repo `infi-pc/editable-paseo`)**
   - `packages/core` — canonical JSON, Ed25519 signing/verification, safe tar.gz packing/extraction, Paseo impact classifier, monotonic state persistence.
   - `packages/cli` — `paseo-ed` CLI (symlinked at `~/.local/bin/paseo-ed`), including the native macOS `clonefile(2)` helper (`packages/cli/native/clonefile.c`).
   - `packages/cloud-shelf` — Cloudflare Worker + R2 bucket hosting immutable signed archives, channel pointers, `wip-index.json`, and iOS Expo OTA manifests.

### Runtime directories

```text
~/.editable-paseo/
  config.json                       # baseBranch, autoPush, runtime versions, Cloud Shelf URL
  cloud.env                         # 0600 Cloud Shelf tokens (auto-loaded by paseo-ed)
  keys/                             # Ed25519 signing.private.pem (0600) + signing.public.pem
  repo/                             # Dedicated detached-HEAD clone (never edit directly)
  worktrees/<slug>/                 # Isolated WIP worktrees (branch ed/wip/<slug>)
  warm-pool/                        # 1-slot CoW standby worktree (slot/ + meta.json)
  locks/                            # Outside-worktree locks (<slug>.deps.{lock,ready}, warm-pool.lock)
  branches/<slug>.json              # Local WIP metadata (title, icon, agentId, services, digests)
  releases/
    electron-web/
      <digest>/                     # Extracted signed UI release + manifest.json
      channel.json                  # Signed prod channel pointer
      channels/
        wip-index.json              # Signed index of staged WIP branches
        wip-<slug>.json             # Per-WIP signed channel pointer
    daemon/<digest>/                # Extracted signed daemon-1 release + manifest.json
  device-state.json                 # Active, lastKnownGood, and quarantined UI + daemon digests
  inspector.json                    # 0600 pointer to editable-inspector.sock
  editable-inspector.sock           # 0600 local read-only HTTP-over-Unix-socket inspector

~/.paseo/                           # Live daily daemon (:6767) + editable-daemon-running.json
~/.paseo-workshop/                  # Isolated Workshop daemon (:6769, relay disabled)
```

## Official `Paseo.app` vs. `Paseo Dev.app` sandbox

- **Daily driver (`/Applications/Paseo.app`, bundle ID `sh.paseo.desktop`)**:
  - Automatically activates Editable mode whenever `~/.editable-paseo/config.json` exists.
  - Reuses live `~/.paseo` (`:6767`), `~/Library/Application Support/Paseo`, and `~/.local/bin/paseo`.
  - Disables upstream desktop auto-updates (`allowUpstreamDesktopUpdates()` defaults to `false`).
  - Enables `allowProductionSwap` in `packages/desktop/src/editable/daemon-swap.ts` so signed `daemon-1` releases can hot-swap `:6767`, while still strictly refusing to touch the Workshop daemon (`:6769`).
- **Isolated sandbox (`Paseo Dev.app`, bundle ID `cz.infi.paseo.dev`)**:
  - Built with `npm run build:dev-app --workspace=@getpaseo/desktop` (`electron-builder.dev.yml`, `build/paseo-dev-profile.json`).
  - Runs strictly isolated on `~/.paseo-dev`, port `6770`, scheme `paseo-dev:`, and release store `~/.paseo-dev/editable`. Never touches `~/.paseo` (`:6767`) or `~/.paseo-workshop` (`:6769`).
- **Workshop daemon (`~/.paseo-workshop`, `127.0.0.1:6769`, relay off)**:
  - Hosts the Workshop agents that edit Paseo so an agent modifying or swapping the live `:6767` daemon never kills itself.

## Services model and daemon hot-swap (`daemon-1`)

`classifyPaseoImpact()` maps changed files onto four user-facing services:

| Service   | Release surface | Runtime version | Delivery path                                 |
| --------- | --------------- | --------------- | --------------------------------------------- |
| `ui`      | `electron-web`  | `desktop-1`     | Signed renderer hot-swap (no app rebuild)     |
| `daemon`  | `daemon`        | `daemon-1`      | Signed daemon hot-swap (keeps terminals open) |
| `desktop` | —               | —               | Local rebuild of `Paseo.app` required         |
| `ios`     | `ios-ota`       | Expo runtime    | Signed Expo OTA (or Xcode rebuild if native)  |

### How `daemon-1` hot-swap works

1. Signed daemon tarballs extract under `~/.editable-paseo/releases/daemon/<digest>/`, with entrypoint `node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js`.
2. Electron launches the daemon with `PASEO_EDITABLE_DAEMON_DIR` and `--import=.../daemon-release-loader.mjs` (compiled from `packages/desktop/src/daemon/daemon-release-loader.mts`). The loader serves `@getpaseo/*` code from the signed release directory while resolving third-party runtime dependencies from packaged `app.asar`.
3. `packages/server/scripts/supervisor-entrypoint.ts` explicitly forwards `--import=.../daemon-release-loader.mjs` from `process.execArgv` to spawned worker processes because packaged Electron helper processes can ignore `NODE_OPTIONS`.
4. `keepsTerminalsOnStop("editable_swap", "darwin" | "linux")` keeps active terminal sessions alive across daemon swaps.

### Quarantine and recovery

- If a hot-swapped daemon fails startup or health checks, Desktop records its digest in `device-state.json` under `quarantinedDaemonDigests` and automatically falls back to `lastKnownGoodDaemonDigest` or the bundled daemon inside `Paseo.app`.
- When loading a UI-only WIP branch, `usableProdDaemonPointer()` in `packages/desktop/src/editable/branches.ts` ignores quarantined `prod` daemon pointers so a previously quarantined `prod` daemon cannot block UI branch switching.
- **Important:** When a fix lands in daemon launch/supervisor code (such as `supervisor-entrypoint.ts`), publish a fresh signed `daemon` release to `prod` (`paseo-ed build-daemon` + `paseo-ed sign-publish --channel prod --upload`) so older incompatible daemon artifacts are replaced on Cloud Shelf.

## Fast worktree creation (`clonefile(2)` + `.warm` pool)

Paseo uses npm workspaces with a ~1.5 MB `package-lock.json` and 13 `patch-package` postinstall patches (`scripts/postinstall-patches.mjs`), resulting in a ~3.1 GB `node_modules` tree. Two alternatives were evaluated and intentionally rejected:

- **Top-level `node_modules` symlink farm:** unsafe if a WIP runs `npm install`, shares mutable `.cache`/`.vite` state across parallel worktrees, trips Metro/Watchman, and breaks active WIPs when the base checkout reinstalls.
- **Switching Paseo to `pnpm`:** still runs postinstall patches and `build:app-deps` (slower than CoW cloning) and adds heavy conflict friction on every upstream sync.

Instead, `paseo-ed` uses two layers on macOS APFS:

1. **Native APFS `clonefile(2)` helper (`packages/cli/native/clonefile.c` -> `dist/bin/clonefile-darwin`):**
   - Clones `node_modules` using `clonefile(src, dst, CLONE_NOFOLLOW)` (~5.6s vs ~22s for `cp -cRP`), preserving relative workspace symlinks (`@getpaseo/* -> ../../packages/*`) with full copy-on-write isolation. Falls back to `cp -cRP` on macOS or `cp --reflink=auto` on Linux if unavailable.
2. **Lockfile-stamped 1-slot `.warm` standby pool (`~/.editable-paseo/warm-pool/`):**
   - Keeps one pre-cloned worktree (`warm-pool/slot`) stamped in `meta.json` with `git rev-parse <baseSha>:package-lock.json` and `node_modules` mtimes.
   - `paseo-ed wip create <slug>` atomically claims the warm slot via `git worktree move` (~370ms with ready `node_modules` + `dist`) and spawns a background refill.
   - Code-only commits on `paseo-customizations` fast-refresh the existing warm slot via `git reset --hard` (~360–850ms). Lockfile or `node_modules` changes self-invalidate the slot; `paseo-ed ship` also refreshes `~/.editable-paseo/repo/node_modules` when `package-lock.json` changes.
   - If the warm slot is cold or busy, `wip create` returns immediately with a bare worktree and launches lock-coordinated background `paseo-ed wip bootstrap-deps <slug>`. Locks live under `~/.editable-paseo/locks/<slug>.deps.{lock,ready}` (outside the worktree so `git status` stays clean). Commands that need dependencies (`verify`, `stage`, `preview`, `build-electron`, `build-daemon`, `ship`, `check`) automatically wait for that lock.

## Branching, Stage/Ship, Auto-Sync, and `paseo-ed check`

### In-app editing flow

1. Press **`Option + Click`** on any element (or use the bottom-right Editable pill) to open the embedded Workshop popover.
2. Submitting a prompt creates a WIP branch (`ed/wip/<slug>`) and optimistically renders it in the branch list immediately (`pendingBranches` in `use-workshop.ts`).
3. The Workshop prompt is intent-first: pure questions leave the worktree unedited; requested changes are edited, verified, and staged by the agent via `paseo-ed stage <slug> --summary "..." --upload`. **Workshop agents never run `ship`.**
4. Clicking **Load** on a staged WIP switches the live UI and/or daemon to that branch's signed `wip-<slug>` channel.
5. Clicking **Ship** runs `paseo-ed ship <slug> --upload`:
   - Reuses staged verification if the worktree is clean and unchanged since `stage`.
   - Lands Git changes onto `paseo-customizations` **before** updating any release channel pointer.
   - If the branch fast-forwards (`behindMain === 0`), promotes the already-staged signed UI/daemon artifacts straight to `prod` without rebuilding; if diverged, merges and rebuilds cleanly.
   - Cleans up the WIP worktree, updates `wip-index.json`, and triggers a background `.warm` refill.

### Auto-sync and `git-sync`

- When `~/.editable-paseo/config.json` sets `"autoPush": true`, `paseo-ed ship` automatically pushes `paseo-customizations` to `origin` after landing (soft-warning when offline instead of failing the ship; pass `--no-push` to skip).
- `paseo-ed git-sync` fetches `origin` and fast-forwards `paseo-customizations` (and pushes if local is ahead and `autoPush` is enabled). Desktop's `branches.ts` triggers `git-sync` in the background, throttled to at most once every 60 seconds.

### Fast local confidence check

Instead of waiting on full GitHub CI, run:

```bash
paseo-ed check                 # Check ~/.editable-paseo/repo
paseo-ed check <slug>          # Check a specific WIP worktree
paseo-ed check --skip-smoke    # Typecheck + core unit tests only
```

`paseo-ed check` runs full-workspace `tsgo`, core unit suites (`protocol`, `client`, `desktop`, `app/editable`), and Playwright browser smoke tests against an isolated temporary `PASEO_HOME`.

## Click-time rich context, live inspector (`paseo-ed app`), and redaction policy

### Click-time context

When you **`Option + Click`** an element:

1. Before mounting `<InlinePopover>`, Desktop captures a cropped PNG screenshot via `window.paseoDesktop.editable.captureScreenshot` (padded around the target rect, resized to <=1200px wide).
2. The renderer captures a compact `EditableElementSnapshot` (React fiber ancestor stack, props, hooks, DOM neighborhood, overflow metrics, computed styles, viewport, theme/density, and a 60-second health digest of recent errors/warnings/failed requests/long tasks) and pins the element as the inspector's active `--target`.

### Live inspector CLI (`paseo-ed app`)

Desktop serves a read-only HTTP-over-Unix-socket bridge at `~/.editable-paseo/editable-inspector.sock` (mode `0600`, pointer written to `~/.editable-paseo/inspector.json`). No MCP tools are registered, avoiding prompt schema bloat.

```bash
paseo-ed app status
paseo-ed app screenshot --target [--out /tmp/shot.png]
paseo-ed app dom --target [--depth 4] [--full]
paseo-ed app react --target [--component Name] [--full]
paseo-ed app css --target                    # Uses Electron CDP CSS.getMatchedStylesForNode
paseo-ed app logs [--level error|warn|all] [--limit 50]
paseo-ed app network [--failed] [--limit 50]
paseo-ed app perf                            # Long tasks, event timing, heap + Electron processMetrics
paseo-ed app store [session|settings|layout] [--agent <id>] [--full]
```

Always-on renderer ring buffers stay strictly bounded (80 console logs, 80 fetch entries, 50 performance entries, 20 breadcrumbs) with no idle `requestAnimationFrame` loop.

### Secret-only redaction policy

Because Editable Paseo runs locally on your own personal machine, inspection uses **secret-only redaction**:

- **Always redacted:** `Authorization`, `Cookie`, `Set-Cookie`, bearer/JWT tokens, and fields matching token/secret/password/apiKey/privateKey patterns.
- **Kept inspectable:** real UI text, chat content, React props/hooks, DOM/CSS styles, bounded ring buffers, and cropped screenshots. Output is truncated for compactness by default and available untruncated via `--full`.

## Rebuilding `/Applications/Paseo.app` locally and rollback

UI (`packages/app/**`) and daemon (`packages/server/**`, `packages/protocol/**`) edits hot-swap automatically. Rebuild `/Applications/Paseo.app` only when `packages/desktop/src/**` or native/packaging dependencies change:

```bash
cd ~/.editable-paseo/repo
rm -rf packages/app/dist packages/desktop/release
npm run build:desktop -- --publish never --mac dir --arm64 \
  -c.mac.hardenedRuntime=false \
  -c.mac.notarize=false \
  -c.mac.identity="E36CA5209D7CC999DE39D1C24FC16FD228888040"
```

Quit Paseo, then swap the signed bundle with APFS copy-on-write and reopen:

```bash
rm -rf "/Applications/Paseo.app"
cp -cRP "$HOME/.editable-paseo/repo/packages/desktop/release/mac-arm64/Paseo.app" "/Applications/Paseo.app"
open "/Applications/Paseo.app"
```

### Recovery options

- **Native menu:** **Editable -> Use Recovery Renderer** (works even when renderer JS cannot boot).
- **CLI rollback:** `paseo-ed rollback-local` (reverts to `lastKnownGoodDigest` and quarantines the broken digest) or `paseo-ed rollback-local --packaged` (reverts to the bundled renderer).
- **Git rollback:** `paseo-ed revert <sha> [--push]`.
- **Full app backup:** `/Applications/Paseo Backup.app` (created prior to cutover).

## Operational gotchas and invariants

- **Never edit `~/.editable-paseo/repo` directly** — keep its `HEAD` detached. Do manual Paseo work in a normal worktree, push/merge to `paseo-customizations`, and let `paseo-ed git-sync` fast-forward the clone.
- **Sandboxed preload rule:** `packages/desktop/src/preload.ts` MUST NOT emit any runtime import other than `"electron"`. Import Editable types with `import type` only (enforced by `packages/desktop/src/preload-sandbox.test.ts`).
- **macOS `SUN_LEN` limit (104 bytes):** Unix domain socket paths fail with `EINVAL` if longer than 104 bytes. Tests such as `inspector-server.test.ts` use short `/tmp` paths when `os.tmpdir()` is long.
- **Stale protocol types after merges:** After pulling or merging changes touching `packages/protocol`, run `npm run build:protocol` so `packages/protocol/dist/*.d.ts` is current before running `tsgo`.
- **Isolated test home:** Never point tests, `verify`, or `check` at live `~/.paseo` (`:6767`); always run them against a temporary `PASEO_HOME`.
