# Browser navigation migration verification

Runs use Chromium, Metro, and isolated test daemons. The production daemon is not used.
Only the listed specs or named cases were run locally; the full suite is left to CI.

## Checks

| Check                                                                                          | Result                                                                                                                                                                                                | Raw output                                                                                                           |
| ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Desktop rail and compact project picker                                                        | 3 passed                                                                                                                                                                                              | [Project navigation](project-navigation.txt)                                                                         |
| Sidebar actions, status badges, activity ordering, and pin shortcuts                           | 13 passed initially; the remaining pin case passed on retry                                                                                                                                           | [Initial core run](core-initial.txt), [pin retry](pin-retry.txt)                                                     |
| Empty projects, plugin navigation, and host filtering                                          | Initial migration runs exposed outdated assertions; corrected cases passed in the runs below                                                                                                          | [Initial layout run](layout-initial.txt), [layout follow-up](layout-followup.txt), [focused retry](layout-retry.txt) |
| Popover anchoring, drawer utilities, activity ordering, compact label editing, and snoozing    | 9 passed                                                                                                                                                                                              | [Final layout run](layout-final.txt)                                                                                 |
| Workspace creation, status transitions, preselection, restart repair, and cross-host selection | 13 passed initially; the remaining cross-host case passed after adding project selection                                                                                                              | [Lifecycle run](lifecycle.txt), [cross-host retry](host-retry.txt)                                                   |
| Cached workspaces, host appearance, terminal titles, plugin icons, and published old daemon    | 20 passed; scroll assertion corrected below; terminal restoration failed here and was fixed in the [follow-up](../terminal-title-reload/verification.md); old-daemon case deferred to the focused run | [Neighbor run](neighbors.txt)                                                                                        |
| Scroll retention and published old-daemon navigation                                           | 2 passed                                                                                                                                                                                              | [Compatibility run](compatibility.txt)                                                                               |
| Root typecheck                                                                                 | Passed                                                                                                                                                                                                | [Typecheck](typecheck.txt)                                                                                           |
| Root lint                                                                                      | Passed                                                                                                                                                                                                | [Lint](lint.txt)                                                                                                     |
| Root format                                                                                    | Passed                                                                                                                                                                                                | [Format](format.txt)                                                                                                 |

The first core run timed out once when entering Inbox after pin reordering. Its isolated retry
passed; that initial failure is retained above. Later migration failures came from obsolete
controls, implicit project scope, an extra drawer-open click, platform-specific shortcut text,
and measuring popover text instead of its outer surface. The scroll test now selects an offset
within the available overflow rather than assuming the list can scroll 160 pixels.

The terminal-title case failed on its first reload: it expected `My named terminal` but
received the working-directory path, before the newly added project-selection steps. The
[follow-up investigation and fix](../terminal-title-reload/verification.md) confirmed a missing
rename request to the PTY worker. The original browser assertions now pass.

Two early browser commands overlapped while using Playwright's default artifact directory.
The lifecycle log includes an artifact-copy error from that overlap. The final neighbor and compatibility runs use
separate output directories.

## Coverage limits

Desktop and compact browser layouts were exercised. Native iOS, Android, and Electron shells
were not run for this test migration. The existing real-provider snooze spec was migrated but
not executed locally. CI was queued when these changes were pushed.
