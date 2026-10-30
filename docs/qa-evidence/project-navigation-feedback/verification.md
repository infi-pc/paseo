# Keep Inbox stable and reorder projects

Inbox now consumes a persisted session activity clock separately from snapshot revisions. The
regression covers provider snapshots, reading, renaming, history replay, runtime reload, reopening
from storage, and subsequent conversation changes.

The rail and All projects dialog save the same project order. The browser regression drags both,
checks overflow at a 480-point window height, selects a hidden project, grows the window, and
checks persistence after reload. The existing pin and Show more tests still pass. The pointer
drag helpers wait out dnd-kit's 50 ms post-release click suppression before the next user action.

## Verification

- `npm run typecheck` and `npm run lint`: passed.
- Focused session activity regression in `agent-manager.test.ts`: 1 passed.
- `agent-projections.test.ts`: 23 passed.
- `agent-storage.test.ts` and `agent-updates-service.test.ts`: 52 passed.
- Affected MCP, workspace-session, and provider-snapshot suites: 402 passed, 4 skipped.
- `agent-loading.test.ts`: 3 passed.
- App snapshot and sidebar projection suites: 15 passed.
- `sidebar-reorder.spec.ts`: all 5 cases passed across focused runs. The initial combined run
  caught the post-drag click suppression; both affected cases passed after the helper correction.

Browser tests use isolated daemons. Desktop-sized browser behavior was verified on macOS.
Native devices and packaged Electron were not exercised. Old hosts continue exposing their
existing activity clock until updated; no snapshot fields were made required.

Raw unit output is alongside this file. Browser previews: [overflow dialog](project-overflow-dialog.png)
and [reordered rail](project-rail-reordered.png).
