# Terminal titles survive reload

The terminal worker adapter renamed only its parent-process cache. The PTY worker never
received the rename and remained in automatic-title mode. A later shell OSC title could
replace the custom name with the working-directory path.

The adapter now forwards the title to the worker, which applies the existing manual-title
policy. The parent mirrors the title immediately; the worker event publishes the title
change once. No client/daemon wire messages or disk persistence changed.

| Check                                                                                                                                                                      | Result                                                                                    | Raw output                        |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------------- |
| New worker regression before the fix                                                                                                                                       | Failed: parent title was `User terminal`, worker snapshot title was `Initial shell title` | [Before](regression-before.txt)   |
| `npx vitest run src/terminal/worker-terminal-manager.test.ts --bail=1` from `packages/server`                                                                              | 27 passed                                                                                 | [Worker tests](worker-tests.txt)  |
| `npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/terminal-tab-title-loading.spec.ts --workers=1 --max-failures=1 --output=/tmp/terminal-title-browser-artifacts` | 1 passed                                                                                  | [Browser test](browser-after.txt) |
| `npm run typecheck`                                                                                                                                                        | Passed                                                                                    | [Typecheck](typecheck.txt)        |
| `npm run lint`                                                                                                                                                             | Passed                                                                                    | [Lint](lint.txt)                  |

The worker regression uses a real PTY worker, checks its authoritative snapshot after a
rename, and emits a later shell title to verify the custom title remains. The original
browser assertions are unchanged: the title survives reload, a first visit from another
workspace, and returning to the retained workspace, without flashing `Terminal`.

Browser verification used Chromium and an isolated daemon. The production daemon was not
restarted. Native and Electron shells were not exercised.
