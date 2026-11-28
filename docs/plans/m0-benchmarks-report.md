# M0 Report: Empirical Benchmarks & Built-in Plugin RPC Spike

> [!NOTE]
> **Status: Archived empirical reference** supporting [Unified Editable Platform Blueprint](./unified-editable-platform.md).
> All benchmarks and spikes were executed live on Apple Silicon (APFS, Node `v26.7.0`, `pnpm 10.33.0`, native `clonefile-darwin` helper) against isolated throwaway `/tmp` worktrees, isolated test daemons, and a temporary Postgres DB (dropped immediately after timing). Zero changes were made to external repos or live daemons (`:6767` / `:6769`).

---

## 1. Benchmark Results (pnpm Monorepo & Paseo npm Monorepo)

### A. pnpm Monorepo Dependency Setup & Build Timings (Measured on Babli `743e1a17`)

| Workflow                                                                             | `git worktree add` |    Deps / Clone | Reconcile | `apps/cli build` |         Total to Built CLI |      `node_modules` Size |        Worktree Remove |
| ------------------------------------------------------------------------------------ | -----------------: | --------------: | --------: | ---------------: | -------------------------: | -----------------------: | ---------------------: |
| **CLI-only filtered (`pnpm install --filter babli... --offline --frozen-lockfile`)** |        0.42–0.50 s | **1.49–1.52 s** |         — |      2.00–2.08 s |                 **~4.0 s** |               **250 MB** |             **0.78 s** |
| **Full offline (`pnpm install --offline --frozen-lockfile`)**                        |             0.50 s |     **10.39 s** |         — |           2.21 s |                **~13.1 s** |                   2.0 GB |                 8.16 s |
| **CoW `clonefile-darwin` (11 dirs) + offline reconcile**                             |             0.37 s |          6.39 s |    1.62 s |           2.03 s |                **~10.4 s** |                   2.0 GB |                   ~8 s |
| **Full `init.sh` (full install + `db:setup-worktree`)**                              |             0.50 s |         10.39 s |         — |           2.21 s | **~56.2 s** _(+43.1 s DB)_ | 2.0 GB + **1,555 MB DB** | 8.16 s _(DB orphaned)_ |

#### Key Findings on pnpm Dependencies & DB Split

1. **CoW dependency caching is NOT worth building for pnpm repos:**
   - Full `pnpm install --offline --frozen-lockfile` takes **10.39 s** natively (pnpm v10 already clones from the content-addressable store).
   - CoW `clonefile-darwin` (6.39 s) + offline reconcile (1.62 s) takes **8.00 s** — only **2.4 s** faster.
2. **Splitting CLI readiness from Web DB setup is a 13× win (and saves 1.55 GB disk/WIP):**
   - `db:setup-worktree` breakdown (measured on a 582 MB Postgres dump):
     - `docker compose up -d --wait --no-recreate db` (already running): **0.69 s**
     - `CREATE DATABASE` + `pg_restore`: **35.41 s** → **1,555 MB** database
     - `pnpm db:migrate`: **6.67 s**
     - **Total DB cost:** **43.10 s** + **1,555 MB** Postgres storage per worktree.
   - Running filtered `pnpm install --filter <cli>... --offline --frozen-lockfile` for CLI-only WIPs takes **1.49 s** (250 MB `node_modules`), bringing end-to-end CLI WIP creation + build from **~56.2 s → ~4.0 s** with **0 MB** Postgres overhead.

---

### B. Whole-Worktree APFS CoW Snapshots (`stage` & Hermeticity)

| Operation                                                                                            |                   Full Worktree (2.0 GB `node_modules`) |     CLI-Filtered Worktree (250 MB `node_modules`) |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------: | ------------------------------------------------: |
| **Snapshot (`clonefile-darwin`, all top-level entries minus `.git`)**                                |                                                  4.58 s |                               **0.22 s** (216 ms) |
| **Symlink escape audit (`apps/cli/node_modules`)**                                                   |                              **29 symlinks, 0 escapes** |                                         0 escapes |
| **Run `node <snapshot>/apps/cli/dist/index.js` from foreign `cwd` _after_ deleting source worktree** | **0.23 s** (`0.15.0`, `--help`, `status --help` exit 0) | **0.16 s** (parsed foreign config & emitted JSON) |
| **Live `tsx` in active worktree from foreign `cwd`**                                                 |                                              **0.96 s** |                                                 — |

> [!IMPORTANT]
> **Confirmed `.bin` shim caveat:** Inside a cloned snapshot, `node_modules/.bin/tsx` still has `NODE_PATH` baked to the deleted source worktree. Executing `node <snapshot>/<entry>` directly bypasses `.bin` shims completely and resolves all Rollup-externalized runtime deps via relative symlinks (`../../../node_modules/.pnpm/...`).
> Therefore: **live `tsx` trials run only against an active leased WIP**, whereas **immutable staged snapshots run `node <snapshot>/<binEntry>` directly** and survive WIP deletion 100% hermetically.

---

### C. Paseo Baseline Timings (`~/.editable-paseo/repo`, `npm`)

| Operation                                                                          | Measured Wall Time | Notes                                                                   |
| ---------------------------------------------------------------------------------- | -----------------: | ----------------------------------------------------------------------- |
| `git worktree add --detach`                                                        |         **0.83 s** | Clean detached worktree                                                 |
| `clonefile-darwin` (root `node_modules` + 16 package `node_modules` & `dist` dirs) |         **7.81 s** | 17 dirs (~3.1 GB total); vastly faster than Paseo's `npm ci` (~45–90 s) |
| `git worktree remove --force`                                                      |        **11.39 s** | Dominated by unlinking 3.1 GB `node_modules`                            |

**Takeaway:** Unlike `pnpm` repos, Paseo (`npm`) gets a ~6–10× speedup from APFS `clonefile-darwin` cloning of `node_modules` + `dist`. Keeping Paseo's `clonefile-darwin` setup (guarded by a verified marker inside `node_modules/` so root `paseo.json`'s `npm ci` skips when hydrated) pays for itself immediately.

---

## 2. Built-in Plugin RPC Spike (Executable End-to-End Verification)

Executed against **two real isolated `createTestPaseoDaemon` instances** (simulating Main Daemon + Meta-Daemon) with `pluginsEnabled: false`, loading a server-only built-in plugin (`editable-spike`, no `index.client.tsx`) via `BuiltinPluginLoader`.

### Verified Results

| Check                                                                      | Result   | Evidence                                                                                                                                                                                  |
| -------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Compiles & runs with only host SDK + `zod` + Node built-ins                | **PASS** | `compileDirectoryPlugin` + `InternalPluginChild` loaded cleanly (`index.server.ts` imported only `@getpaseo/plugin`, `@getpaseo/plugin/server`, `zod`, `node:child_process`, `node:util`) |
| Stays active with `pluginsEnabled: false` & hidden from Settings → Plugins | **PASS** | `client.listPlugins()` returned `[]`                                                                                                                                                      |
| Advertised in catalog for feature detection & packaged smoke               | **PASS** | `client.getPluginCatalog()` returned `[{"id":"editable-spike","hasClientBundle":false}]` (satisfies `packages/desktop/e2e/packaged-app-smoke.js`)                                         |
| Fork app code invokes typed RPCs outside any plugin client bundle          | **PASS** | `callPluginRpc(statusRpc, (m, i) => client.invokePluginRpc("editable-spike", m, i), ...)` succeeded on both Main and Meta clients                                                         |
| In-process `context.paseo` & async subprocess spawning                     | **PASS** | Creating a workspace on Main incremented Main's `workspaceCount` `0 → 1` while Meta stayed `0`; async `execFile(process.execPath, ["-v"])` succeeded                                      |
| Streaming progress subscriptions from fork app code                        | **PASS** | `subscribePluginRpc(jobWatchSub, createPluginSubscribe({ client, pluginId: "editable-spike", lifetime }), { jobId: "stage-42" }, ...)` delivered progress events and closed cleanly       |
| Clean failure on absent plugin                                             | **PASS** | Rejected with `Plugin is not available: nonexistent-plugin` (`code=handler_error`)                                                                                                        |

### Verified Fork App Call Pattern (Zero Core Protocol Edits)

Fork code in `packages/app/src/editable/*` (and `packages/editable-cli` via `@getpaseo/client/internal/daemon-client`) invokes the built-in `editable` plugin on any specific `serverId` (Main or Meta) without touching `messages.ts`, `websocket-server.ts`, `session.ts`, or `daemon-client.ts`:

```ts
import { callPluginRpc, subscribePluginRpc } from "@getpaseo/plugin/client/host";
import { createPluginSubscribe } from "@/plugins/subscriptions";
import { getHostRuntimeStore } from "@/runtime/host-runtime";

// 1. Unary RPC (Zod-validated on both sides; <= 30s timeout)
const client = getHostRuntimeStore().getClient(serverId);
if (!client) throw new Error(`Host ${serverId} is offline`);

const result = await callPluginRpc(
  statusRpc,
  (method, input) => client.invokePluginRpc("editable", method, input),
  { project: "paseo" },
);

// 2. Streaming subscription (mandatory for >30s ops like stage/verify/build/ship)
const subscribe = createPluginSubscribe({
  client,
  pluginId: "editable",
  lifetime: abortController.signal,
});
const handle = subscribePluginRpc(jobWatchSub, subscribe, { jobId }, (event) => onProgress(event), {
  onClosed,
});
```

### Three Implementation Constraints Confirmed

1. **Hard 30-second RPC timeout (`REQUEST_TIMEOUT_MS = 30_000` in [runtime.ts](../../packages/server/src/server/plugins/runtime.ts)):** Every unary `invokePluginRpc` times out at 30 s. Long-running operations (`stage`, `verify`, `build`, `check`) **must** follow the async-job pattern: unary `job.start` (returns `{ jobId }` immediately) + `job.watch` subscription (`observePluginRpc`).
2. **Non-blocking event loop (`InternalPluginChild`):** Built-in plugins execute in-process inside the daemon's Node event loop ([internal-child.ts](../../packages/server/src/server/plugins/internal-child.ts)). Built-in plugins must **only** use async `spawn`/`execFile`, never `*Sync` calls.
3. **Contract sharing boundary (`compiler-build.ts`):** Built-in plugins may only import `@getpaseo/plugin*`, `zod`, Node built-ins, and files inside their own `server/` or `shared/` folders — they cannot import `@getpaseo/editable-core`. Keep the small Zod RPC/subscription contracts in `plugins/editable/shared/contracts.ts` and export them outward via `@getpaseo/builtin-plugins`.
