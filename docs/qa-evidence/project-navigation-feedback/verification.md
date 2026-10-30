# Keep navigation ordered and synchronized

Inbox now consumes a persisted session activity clock separately from snapshot revisions. The
regression covers provider snapshots, reading, renaming, history replay, runtime reload, reopening
from storage, and subsequent conversation changes.

The rail and All projects dialog save the same project order. The browser regression drags both,
checks overflow at a 480-point window height, selects a hidden project, grows the window, and
checks persistence after reload. The existing pin and Show more tests still pass. The pointer
drag helpers wait out dnd-kit's 50 ms post-release click suppression before the next user action.

Navigation follows the destination project while allowing independent rail browsing. In-app history
restores each visit's Inbox/project context. Same-ID file preview replacements also synchronize the
sidebar. Browser history preserves a separate context per entry, including repeated visits to the
same workspace. Its listener registers before the router, and its browser boundary survives root
layout remounts and the router's delayed history writes.

## Verification

- `npm run typecheck` and `npm run lint`: passed.
- Preview-retarget regression failed with the sidebar still on the other project before the fix;
  the history record-location and recorder suites pass (15 tests).
- Browser Inbox-origin Back regression failed before the fix. Both it and the existing
  desktop/compact navigation case pass together. The Inbox case also checks Forward and
  distinct contexts for repeated visits to the same workspace.
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

Raw output is alongside this file, including [history regression tests](history-regressions.txt)
and [browser navigation checks](browser-navigation.txt). Browser previews: [overflow dialog](project-overflow-dialog.png)
and [reordered rail](project-rail-reordered.png).
