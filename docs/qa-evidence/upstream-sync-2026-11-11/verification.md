# Merge upstream while preserving the fork

Source: `getpaseo/paseo` main at `47a746318`, fetched November 11, 2026. Previous merge base:
`fa89738e3`. This imports 215 upstream commits and resolves 80 conflicted paths, including two
modify/delete conflicts. Resolution happened in `/tmp/paseo-upstream-sync` before updating the
shared customization checkout.

## What upstream adds

- Plugin sidebar views, live events and binary data, composer contributions and cursor control,
  agent options and metadata, New workspace integration, and tabbed plugin settings.
- Adaptive workspace headers and narrow-column layouts, touch navigation overlays, hardware
  keyboard shortcuts across native and desktop, and iPhone Duo layout support.
- LegendList native timelines, anchored disclosure toggles, first-frame collapsed prompts,
  steadier chat footers, cached-history freshness, and preserved unsent drafts.
- Background agents and visible/stoppable background work, better Claude/Codex/Pi/OpenCode/ACP
  lifecycle recovery, additional Claude models, and the opt-in fx provider.
- Incremental binary Changes revisions, faster initial diff trees, base-branch selection from
  Changes, inline workspace renaming, archive undo, and workspace-agent restore on unarchive.
- Host/relay reconnect fixes, terminal worker and replay fixes, cron validation fixes, and release
  metadata through `0.16.0-beta.1`.

## How it fits the fork

Inbox and ordered project navigation remain inside upstream's sidebar/plugin/toast ownership.
Upstream grouping controls remain absent, as required by the fork's navigation model. Both sidebar
row implementations retain inline renaming and merged-PR archive actions. Compact navigation retains
its project picker alongside upstream's scrollable navigation and overlay behavior.

Pinned prompts use the new native LegendList jump API. Selection and code-language overlays use
upstream's shared keyboard registry. LocatorJS appends use the same external text replacement signal
as plugin composer writes. Plan handoff copies provider options through the current draft API.
Recommended prompts retain upstream's footer geometry and disclosure holds.

Upstream's streamed diffs would otherwise lose both categorized statistics and content identities
that authorize TypeScript navigation. An optional SDK request flag negotiates a metadata-bearing end
frame. Categories and identities commit with the same revision, including inherited bodies. Old
requests keep byte-for-byte ordinary end framing; old daemons ignore the optional request field.
See [protocol compatibility](../../protocol-compatibility.md#diff-file-metadata).

The existing header base-branch controls coexist with upstream's Changes base selector. Explicit
workspace registry listings keep snooze scheduling and language-service cleanup limited to active
workspaces. Sleep-state delivery, session MCP consent, response metadata, tool summaries, background
inspection, Linear links, Codiff, and personal TestFlight configuration remain wired.

Fork PR lookup still checks the fork repository first. Open fork PRs win; terminal candidates also
participate in upstream's state/SHA/update-time comparison against parent-repository PRs.
Interrupted-agent recovery now follows upstream's opt-in default. Previously configured values
remain in effect.

## Validation

62 targeted test files passed (2264 passing tests). The daemon stack build, workspace
typecheck, lint, formatting, and clean-install lockfile validation also passed.
Per-file commands and summaries are in `tests.json`, `tests.txt`, and `checks.txt`.

The merge was pushed to `origin/paseo-customizations`; remote `main` was left unchanged because
its push triggers deployment workflows. Full CI was dispatched explicitly on the fork branch:
[initial run](https://github.com/infi-pc/paseo/actions/runs/43030661788).

That run found issues outside the initial targeted set:

- Auto-archive's joinable snooze task deferred the fresh Git read until after the emitting refresh
  could finish. Reserve the promise first and start the read immediately so upstream's
  `afterInFlight` request queues correctly. The existing behavioral tests reproduce both failures.
- The legacy JSON diff adapter did not apply end-frame metadata to inherited bodies. Copy the
  matching revision's metadata onto each materialized file, as the modern SDK does. The existing
  All-changes integration test verifies identical pre/post-commit snapshots.
- Windows timed out on the 1,000-file diff fixture because classification repeated Git reads per
  file. Categories and content identities now reuse the engine's batched snapshot source reads.
  The local streamed read fell from roughly 12.8 seconds to 1.2 seconds while retaining 16 patch
  commands for 1,000 files. Windows confirmation remains owned by the follow-up CI run.
- Pi's new history test assumed a checkpoint-only fork even when the selected reply is the latest.
  Keep the fork's current-context rule and retain the test's exclusion of abandoned branches.
- Desktop utilities had moved below the whole sidebar and duplicated Add project. Utilities now
  stay in the project rail, with plugin/Usage rows beside it. Compact layouts retain their
  horizontal utility row and upstream's overflow menus.

Follow-up local verification passed: archive behavior (13), archive unit tests (6), snooze transport
(3), Pi history (17), diff content E2E (12), diff manager (7), and desktop project picker (2).
Formatting, lint, and workspace typecheck passed again. The quote toolbar and both streamed Changes
browser regressions passed. The background-agent journey also passed after its helper accepted the
project-prefixed Inbox accessibility label. The chat memo comparison now includes `onQuoteSelection`,
so draft hydration can enable the quote action after the first render. The diff wire test harness
recognizes negotiated metadata end frames.

Browser follow-up restores the fork's desktop rail/footer geometry and keeps the compact project
picker above scrolling navigation. Compact built-in actions use a row, and plugin navigation leaves
room for a project header and its first workspace on short screens. PR shortcuts select worktree
isolation through upstream's shared setup model before choosing the PR.

Upstream fixtures that expect inactive workspaces now select their project explicitly; onboarding
checks discover added projects through the rail. The pinned-prompt test places its prompt at the
reading line after the shared scroll helper centers it. Disclosure tests disable generated tool
summaries so their labels stay deterministic, and settle scrolling before clicking the turn summary.
The overflow journey runs in the compact horizontal footer; the desktop utility checks retain the
fork's vertical rail contract.

The second full CI run at `ce38a3825` stopped every Linux browser job during apt installation
because `azure.archive.ubuntu.com` could not resolve. It therefore did not recheck the original
browser failures. The provider-removal module-export error did not recur against a fresh local build. A total of
78 distinct browser cases passed across the focused runs and corrected-case reruns, including
all 75 cases in the 12-spec follow-up set. The sidebar-view example seeds actual mock session
activity so restoring Inbox through browser history still shows its workspace. Full CI is pending
at submission. Exact browser results are recorded in `browser-ci-follow-up.txt`.

No production daemon restart or release was performed. This pass does not establish native
device behavior or packaged desktop startup. Native timeline and
adaptive-header changes should receive device smoke coverage before a release. The full test suite
was not run, following repository policy.
