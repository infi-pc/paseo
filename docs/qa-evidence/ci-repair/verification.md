# Repair PR #9 CI contracts and regressions

Verified on macOS with isolated test daemons, Chromium desktop and compact viewports, and Electron's lifecycle harness. The production daemon on port 6767 was not restarted. Full suites and Windows execution are left to GitHub Actions.

## What CI exposed

- The file-observation job requested `macos-14` during GitHub's October 29 deprecation brownout. It now uses `macos-15`; the CI contract test names the same image. [GitHub runner announcement](https://github.com/actions/runner-images/issues/13518).

- The browser suite contained an Electron-bridge startup case. It now belongs to the existing desktop renderer suite.
- Older assertions omitted existing Chapters and remembered-agent state, diff breakdowns, or the renamed sidebar file. Translation-parity enforcement also contradicted this fork's English-only policy.
- Background-activity updates lacked a source-owned delivery lifetime. Matching subscription IDs on separate sockets now stay independent.
- MCP JSON serialization turned absent response metadata into null fields outside its declared schema. Projections now omit absent fields, including nested metadata fields.
- Definition navigation dropped column ranges between the file host and source panel. The optional plugin file-panel contract carries the full range to the editor.
- Resizing Explorer registered a CSS class for each measured tab width. Tab widths now use the existing inline-style lane. The performance test waits for loaded Files content before measuring; its zero-mutation and zero-pane-render assertions remain.
- Browser flows still assumed all workspaces appeared in Inbox, duplicated visible prompt text, or reused a mutated timeline across pinned-prompt cases. Helpers now select the relevant project and assertions identify their owning surface.
- The Electron browser-eviction harness and packaged Linux smoke also assumed every project's workspaces appeared together. They now select the owning project's rail button before opening a workspace. The packaged smoke retains its real installer, sandbox, renderer, daemon, and terminal assertions.
- The Windows OpenCode integration reused the legacy manager after the previous case deleted its install. Each versioned fixture now owns its manager and checks the freshly installed CLI's version before exercising the runtime's short probe deadline.
- The nested package-script UI test inherited the Linux runner's shell, which has no Paseo command-completion integration. Its daemon fixture now selects zsh, and browser CI installs it. The exit-code and sidebar-status assertions remain.

## Verification

[Command and result excerpts](checks.txt) cover root typecheck and lint, the CI ownership guard, every changed app/server/website unit-test file, desktop startup and daemon lifecycle, and targeted browser reruns. Each Vitest file ran individually with `--bail=1`; browser runs used one worker.

The three code-language cases passed in a focused browser batch: real TypeScript hover/definition/usages, working-diff inspection, and compact Changes opening a file sheet with the selected symbol. That batch also exposed the resize-content setup and shared pinned-timeline issues; their final reruns passed separately:

| Focused browser verification                            | Result                                                           |
| ------------------------------------------------------- | ---------------------------------------------------------------- |
| Explorer resize                                         | 1 passed; zero stylesheet mutations and pane renders during drag |
| Pinned prompts                                          | 7 passed                                                         |
| Responsive usage summaries                              | 3 passed                                                         |
| Worktree retained until its final workspace is archived | 1 passed, selecting each owning project                          |

The navigation batch exercised draft remount/retry, directory synchronization, Explorer bulk close, preserving the global New workspace form, collapsed-project status, mobile startup, retained and split chats, workspace lifecycle/reconnect/cold URLs, stale notification routing, and package scripts. Its usage-summary assertions were corrected and rerun as shown above.

[Desktop TypeScript hover](desktop-language-hover.png) · [Compact Changes](compact-language-changes.png)

Both pinned OpenCode runtime cases passed locally after isolation. The real Electron browser run reached and completed the cross-project eviction sequence, then failed the existing hidden-window frame assertion on macOS (`before-capture: hidden browser produced 122 animation frames`). Its Linux CI rerun remains the full browser-harness verification; the frame assertion is unchanged.
