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

No production daemon restart, release, or push was performed. This pass does not establish native
device behavior, packaged desktop startup, or full app browser journeys. Native timeline and
adaptive-header changes should receive device smoke coverage before a release. The full test suite
was not run, following repository policy.
