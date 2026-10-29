# Compose URLs work in the dev Electron app

Verified on 2026-10-29 against the real Electron renderer, preload bridge, desktop main process, and an isolated local daemon. The daemon used `.dev/compose-qa-home`; the renderer used port 57932 with CDP on 57933. The production daemon on port 6767 was not restarted.

The fixture has one git project with main and feature worktrees. Two mock-provider agents exist in the feature worktree; Agent A was focused after the newer Agent B, then the main worktree was selected.

Passed live checks:

- Launching Electron again with a `paseo://compose?...` argument reaches the running app through its real second-instance handler.
- The feature worktree URL returns from main to Feature Agent A, preserving the existing unsent draft and appending `src/Button.tsx:43:8`.
- The composer is focused after navigation.
- Repeating the same URL adds one more reference.
- Reloading the renderer preserves the workspace focus memory and draft; a subsequent URL appends `src/Button.tsx:44:9` to Agent A.
- An unregistered worktree shows a visible error with Retry and Back instead of selecting another worktree.
- The agent remains idle, and its actual timeline contains only the original QA prompt, with neither the baseline nor the inserted references sent.

The first live run exposed a retained-editor bug: the draft store changed but the mounted editor did not display the external append. Fixed by publishing an explicit replacement to retained composers when the external draft revision changes. The regression test now exercises that replacement notification on an already-mounted input owner.

Validation after the fix: repository typecheck and lint passed; 14 focused tests passed in the composer and compose-screen suites.

Evidence: `compose-success.png`, `compose-unmatched.png`, `repeated-link.json`, and `after-reload.json`.

Not covered: macOS LaunchServices selecting the installed app for `paseo://` links, or an actual LocatorJS extension click. Dev URL delivery used the Electron launch argument path.
