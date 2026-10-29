# Compose URLs work in the dev Electron app

Verified on 2026-10-29 against the real Electron renderer, preload bridge, desktop main process, and an isolated local daemon. The daemon used `.dev/compose-qa-home`; the renderer used port 57932 with CDP on 57933. The production daemon on port 6767 was not restarted.

The fixture has one git project with main and feature worktrees. Two mock-provider agents exist in the feature worktree; Agent A was focused after the newer Agent B, then the main worktree was selected.

Passed live checks:

- Launching Electron again with a `paseo://compose?...` argument reaches the running app through its real second-instance handler.
- The feature worktree URL returns from main to Feature Agent A, preserving the existing unsent draft and appending `src/Button.tsx:43:8`.
- The composer is focused after navigation.
- Repeating the same URL adds one more reference.
- Reloading the renderer preserves the workspace focus memory and draft; a subsequent URL appends `src/Button.tsx:44:9` to Agent A.
- An initial `/compose?...` renderer URL survives startup and appends `src/COLD_START_VERIFIED.tsx:171` to the remembered agent. The same entry previously redirected to the saved workspace and discarded the reference.
- With animation-frame publication held, typing changes the visible editor while the draft store still has its prior value. Delivering a compose URL preserves `Newest live typing preserved before paint`, appends `src/RACE_FIXED.tsx:12`, and focuses the input. The retained editor flushes its pending text before the append reads the draft.
- An unregistered worktree shows a visible error with Retry and Back instead of selecting another worktree.
- The agent remains idle, and its actual timeline contains only the original QA prompt, with neither the baseline nor the inserted references sent.

The first live run exposed a retained-editor bug: the draft store changed but the mounted editor did not display the external append. Fixed by publishing an explicit replacement to retained composers when the external draft revision changes. The regression test now exercises that replacement notification on an already-mounted input owner.

Validation after the fixes: repository typecheck and lint passed; 14 focused tests passed in the composer and compose-screen suites. The mounted-input regression first failed because the newest typing was missing, then passed after the pending publication was flushed before the merge.

The Playwright regression in `startup-loading.spec.ts` uses the real root navigator and an isolated daemon. It holds native startup IPC and the host WebSocket connection, verifies the initial compose URL remains mounted, then releases both and asserts the visible composer contains the existing draft plus reference and is focused. It failed before the route was moved outside the protected group (`/compose` changed to `/`), then passed after the fix.

Commands:

```text
npm run typecheck
npm run lint
NODE_OPTIONS=--no-experimental-webstorage npx vitest run src/composer/draft/input-draft.live.test.tsx src/compose/screen.test.tsx --bail=1
npx playwright test --project=browser e2e/browser/startup-loading.spec.ts -g 'initial compose URL'
```

Run the test commands from `packages/app`. Raw before/after results are committed beside this file.

Evidence: original `compose-success.png`, `compose-unmatched.png`, `repeated-link.json`, and `after-reload.json`; follow-up `initial-url-preserved.png`, `pending-typing-preserved.png`, `initial-url-after.json`, and `pending-typing-{before,after}.json`.

Not covered: a separate process-cold Electron launch, macOS LaunchServices selecting the installed app for `paseo://` links, or an actual LocatorJS extension click. Dev URL delivery used the Electron launch argument path.
