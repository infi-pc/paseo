# Keep every open workspace accounted for

Status: implemented; validation is recorded with the change. This document preserves the agreed implementation scope. Current behavior is documented in [mobile panels](../mobile-panels.md#inbox-and-project-navigation) and [workspace snoozing](../agent-lifecycle.md#workspace-snoozing).
Reviewed independently through Paseo by Gemini Argon and Claude Code Fable;
concrete findings incorporated below. No implementation changes have been made.

Every unarchived workspace appears in Running, Inbox, or Snoozed. Reading a session,
clearing its green dot, or crossing an age boundary must never hide its workspace.
Archive and snooze are the explicit ways to clear a workspace from Inbox. Apply this
within the existing user-visible workspace inventory and selected host/project scope;
do not surface deliberately background/internal workspaces or bypass explicit filters.

## Derive placement from existing records

| Situation                                                       | Placement                                            |
| --------------------------------------------------------------- | ---------------------------------------------------- |
| Workspace has working sessions                                  | Running                                              |
| Workspace has sessions waiting for input or review              | Inbox                                                |
| Workspace has no working sessions, including an empty workspace | Inbox                                                |
| Workspace is snoozed                                            | Snoozed; actual running work also remains in Running |
| Workspace is archived                                           | Removed from active lists                            |

A mixed workspace can appear in Running and Inbox with different children. Old idle
sessions still count as open work; age does not remove the workspace. A runtime that
was unloaded but remains resumable is not an archived session.

After all results have been read, an open workspace remains in Inbox until you continue
working, snooze it, or archive it. Preserve the existing archive flow and its safeguards.
Snoozing does not stop execution.

Do not implement the earlier Dismiss from Inbox / Return to Inbox proposal, handled
revisions, or a separate Inbox item database. Keyboard shortcuts are deferred. Use
context menus for Archive workspace and Snooze workspace on desktop and mobile.

| Concern                               | Source of truth                      |
| ------------------------------------- | ------------------------------------ |
| Workspace ownership and archive state | Workspace record                     |
| Session ownership and archive state   | Session record                       |
| Running or blocked execution          | Agent lifecycle and pending requests |
| Green-dot read state                  | Existing attention/read state        |
| Snooze condition and deadline         | Workspace snooze record              |
| Expansion and selection               | Per-device UI state                  |

Derive lists and counts. Never persist copies of section membership. Clear snooze in
one workspace registry update, then use the existing wake notification callback with
its reason. No persistent wake record, wake unread flag, acknowledgement, or review item
is needed. Losing a notification does not hide the workspace: it returns to the normal
Running/Inbox projection, which may be Running only if all its sessions are working.

Reuse `requiresAttention`, `attentionReason`, and `attentionTimestamp` and the existing
read/clear operations. Do not add read revisions, replace the attention subsystem, or
change read semantics as a prerequisite. If implementation demonstrates an independent
read race, report it separately with a reproducer and the smallest justified fix.

The only essential new durable field is optional `config.deadlineAt` on conditional
snoozes. Reuse the existing snooze identity to reject stale check/unsnooze operations.
Do not persist a second duration that can disagree with the deadline: keep the existing
deadline when editing, display it, and offer the preset picker to replace it. Existing
expansion preferences can be reused; new persistence for cosmetic defaults is optional.

## Keep the implementation narrow

Simplicity serves the user's workflow and long-term correctness, independent of fork
maintenance or upstream mergeability. Reuse existing navigation, forms, menus, stores,
notification delivery, and directory subscriptions. A shared pure sidebar projection and
a small send guard are enough; do not introduce a generic attention-event framework,
notification outbox, separate Inbox service, or new lifecycle orchestration layer.

Only extend protocol fields/actions needed for conditional deadlines and an unsnooze
operation conditional on the displayed snooze ID. Derive sidebar state on the client
from existing directory summaries. Do not require a broad Inbox capability or new read
RPCs just to show the new layout. Preserve current sorting where possible; stabilize
stream-driven row movement without inventing new durable sorting clocks.

Keep the requested behavior: mixed-session visibility, existing green dots, permission
wake, a conditional timeout, and the send dialog. Further options, customization,
notification-policy changes, and unrelated refactors are separate work.

## Show session shortcuts beneath workspaces

Build children from host-owned sessions, not device-local open tabs. Clicking a child
uses the existing agent navigation helper to open or focus its tab in its current
workspace. Sidebar rendering must not load transcripts or start provider runtimes.

- Running shows working sessions regardless of age.
- Inbox shows relevant non-running session shortcuts.
- Project panels show each workspace once with both kinds of shortcuts.
- Child shortcuts qualify when running, blocked, active within 48 hours, or unread.
  Keep the selected session visible too.
- A workspace row remains even when no child qualifies. It opens the normal workspace
  view, where the other sessions remain accessible.
- Retain recent children during the current view visit so reading or aging does not
  remove a row under the pointer. Archive and execution transitions still apply.

Reuse the workspace-root policy: root sessions and cross-workspace subagents get
shortcuts. Preserve the documented same-workspace descendant contract: running work
contributes to its workspace-root session; descendant permission, error, and completion
states remain in the parent's subagents track. Do not create a second parent-status
aggregation in the sidebar. Exclude internal helper sessions. A missing parent during
hydration must not hide a workspace; retain the workspace row and resolve session
placement using existing directory/detail data once available.

Default Running and Inbox groups to expanded. Default project workspace children to
collapsed and remember expansion per device. Show aggregate work/attention indicators
on collapsed rows. Use a collapsed Snoozed section in the global view, with a count and
deadlines; project views retain snoozed workspaces with a snooze indicator.

Use existing activity timestamps with stable identity tie-breaks for section and child
ordering. Reuse an available execution-start timestamp for Running if it exists; do not
add a persisted clock for sorting. Permissions take priority in Inbox. Streamed tokens must not shuffle rows. Preserve existing
workspace-number shortcuts: duplicated workspace groups share one workspace target,
and children do not consume workspace numbers.

## Handle mixed execution states

| Event or situation                                      | Behavior                                                                                                                         |
| ------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| A runs while B finishes                                 | A appears under Running; B appears under Inbox.                                                                                  |
| You read B                                              | Clear B's green dot without removing its workspace from Inbox.                                                                   |
| A new turn starts in B                                  | Move B to Running when execution actually starts, not on a failed send or queue admission.                                       |
| A waits for permission                                  | Show A in Inbox as blocked even if its turn remains open.                                                                        |
| A has a blocked descendant while other descendants work | Keep the existing running contribution and expose the request through the subagents track; do not invent a blocked parent state. |
| You stop a session                                      | Once execution settles, represent it as non-running work in Inbox.                                                               |
| A host disconnects                                      | Keep last-known rows with an offline indication; do not infer completion.                                                        |
| A session moves                                         | Regroup under its current workspace without resetting read state.                                                                |
| A workspace is restored                                 | Derive placement from current lifecycle and snooze state.                                                                        |

Never duplicate one session across Running and Inbox. Its own pending request takes precedence,
with an indicator for any work that continues. Workspace identity is host plus workspace
ID, never its directory path. Derive placement from execution and pending-request facts,
not the aggregate green-dot/attention bucket. Reading can change that bucket without
changing execution. A root's own blocked turn is not working; unrelated working roots
still keep the workspace in Running.

## Put a deadline on conditional snoozes

Timed snoozes keep their chosen wake time. Both AI-condition and status-change snoozes
get a persisted deadline. Wake when the condition is satisfied or the deadline expires,
whichever happens first.

Below the main condition controls, show a subtle selector:

> Remind me anyway after 2 weeks

Choices: 1 day, 3 days, 1 week, 2 weeks, 1 month. Default: 2 weeks.

- Persist the deadline when creating the snooze.
- Polling, failed checks, reconnects, and restarts never extend it.
- Editing only the condition preserves the deadline. Explicitly changing the duration
  calculates a new deadline.
- Reuse existing date utilities to calculate an absolute deadline from the selected
  preset. One month means one calendar month in the selecting device's timezone; the
  daemon only needs the resulting UTC instant, not a new timezone scheduling subsystem.
- Treat a conditional snooze as due at the earlier of its next check or deadline.
  Check expiry before dispatching condition checks and before their concurrency limits.
  An in-flight/slow AI or status check cannot delay the deadline. Clear only the matching
  snooze ID, cancel its check using existing teardown, and reject late results.
- Process an overdue deadline once after downtime, including when condition checks fail.
- A timeout clears snooze and returns the workspace to its normal Running/Inbox view.
  Its notification says "Reminder due"; do not claim the condition is false when its
  latest check failed or was inconclusive. Change the existing unconditional
  "[Workspace] is ready" wake title to a neutral "[Workspace]: snooze ended" so timeout
  and condition wakes can reuse the callback without new saved event kinds.
- Initialize existing conditional snoozes without deadlines from their original
  creation time plus two weeks. Keep the field optional on wire and storage schemas so
  old records parse before normalization. Use the existing load/update path; no migration
  runner or separate job. Persist the fixed result without resetting the snooze ID.
  Overdue snoozes wake normally. This intentional upgrade behavior prevents legacy
  snoozes from remaining indefinite; mention it in release notes.
- Archived workspaces do not wake. Existing snooze revision checks prevent stale check
  results from overwriting an edited or canceled snooze.

## Ask about snooze when sending a message

Opening, reading, focusing, and typing do not change snooze. A user-triggered send into
a snoozed workspace opens this dialog:

> "[Workspace]" is snoozed until [time or condition].
>
> Unsnooze this workspace when sending your message? This also resumes Inbox updates
> and notifications for its other sessions.

| Action                | Result                                                                                                          |
| --------------------- | --------------------------------------------------------------------------------------------------------------- |
| Unsnooze and send     | Cancel snooze, then submit. Existing attention becomes visible; future events follow normal notification rules. |
| Keep snoozed and send | Submit and retain snooze. Work remains visible in Running; completion/error notifications remain deferred.      |
| Cancel                | Preserve the draft and send nothing.                                                                            |

Use one small UI guard from the explicit user-action entry points. In the composer,
call it before `submitAgentInput` chooses queue/steer/send and before a draft or attachment
is cleared; the lower-level `submitMessage` alone misses queue admission. Cover manual
"send queued now" and the separate recommended-prompt send action with the same guard.
Preserve the existing parent-managed draft submission override.

Ask when the user submits or enqueues, not when `drainQueuedAgentMessage` later runs.
The automatic drain, scheduled work, agent-to-agent messages, and transport dispatch
never open dialogs or unsnooze. If a user queued work and then snoozed the workspace,
the queued work still runs and respects that snooze. No per-message snooze token or new
queue orchestration is needed. Do not remember a global choice: another explicit send
while snoozed asks again.

Recheck before submission. If snooze has already ended, send normally. Bind the choice
to the snooze revision shown; if another device changes it, refresh the dialog instead
of canceling the replacement snooze. If unsnoozing fails, preserve the draft and show
the error. If unsnoozing succeeds but sending fails, leave the workspace awake, preserve
the draft, and explain that the message was not sent. Prevent duplicate submission.

Manual unsnoozing does not send an additional wake notification. Existing
unread attention becomes visible without replaying its notifications.

## Let permissions break snooze

A new permission request automatically cancels the workspace snooze and surfaces the
blocked session. Send one permission notification without a separate wake notification
for the same interruption. Previously deferred attention becomes visible without replay.

Prevent creating a snooze while an unresolved permission would immediately break it;
explain that the request must be resolved first. Include descendant requests in this
policy, using their owning workspace and the parent presentation rules above.

## Keep read state independent and make snooze quiet

- Reading acknowledges the viewed session, not every session in its workspace.
- Marking unread changes the green dot, never placement.
- Wake leaves the sessions' green dots unchanged; its reason is in the notification.
- Preserve the existing viewed/read behavior and stored fields.
- Tool output, Git refreshes, runtime reloads, and history replay do not fabricate new
  attention events or send notifications.

Snooze currently controls visibility; suppressing completion/error notifications is an
explicit behavior change in this plan, required by "Keep snoozed and send" and the dialog
copy. It does not suppress lifecycle/attention state updates or clear green dots.

Reuse existing notification delivery, deduplication, and presence rules. Scope changes
to snooze suppression and permission-triggered wake. Keep current error-push eligibility;
expanding notification preferences is separate work. Completion/error attention can
remain recorded while snoozed, but suppress its delivery and do not replay it on wake.
Use the normal wake notification instead. Apply the same quiet policy to existing
terminal/script attention delivery for the snoozed workspace, without inventing new
terminal permission semantics. Audit both `Session.forwardAgentStream` and WebSocket
push/toast fan-out: muting push alone leaves in-app banners. Share a small policy check
at the existing delivery boundaries; keep state messages flowing with notification
presentation disabled. Commit permission-triggered unsnoozing before its normal
notification dispatch. Do not build durable delivery/retry machinery.

Session notification taps open that session; wake taps open the workspace. Neither tap
archives or snoozes work. Push remains best-effort; missed delivery leaves the workspace
discoverable. Verify real iOS push separately from simulator tap routing.

## Implement through the existing boundaries

Paths below identify the researched owners; recheck them against the implementation
checkout before editing.

| Area                                  | Starting points                                                                                                |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Sidebar section/child projection      | `packages/app/src/components/sidebar/navigation/`, `packages/app/src/components/sidebar/sidebar-projection.ts` |
| Rows and context menus                | Sidebar row/menu components and `packages/app/src/components/left-sidebar.tsx`                                 |
| Session visibility/navigation         | `packages/app/src/workspace-tabs/agent-visibility.ts`, `packages/app/src/utils/navigate-to-agent/`             |
| Execution, permissions, and attention | `packages/server/src/server/agent/`, `packages/app/src/hooks/use-agent-attention-clear.ts`                     |
| Snooze deadline and clearing          | `packages/server/src/server/workspace-snooze/service.ts`, workspace registry                                   |
| Send confirmation                     | Shared user-message submission flow and snooze form                                                            |
| Push                                  | `packages/server/src/server/agent-attention-policy.ts`, `websocket-server.ts`, app `notification-open/`        |
| Additive sync contract                | Protocol schemas, client methods, existing agent/workspace directory summaries                                 |

Use optional wire fields, pure structural schemas, and dotted names for any required
new RPC pair. Gate the deadline-aware snooze controls once per host; an unsupported host
gets an update indication for those controls, not a replacement Inbox implementation.
Preserve older-client parsing, existing project navigation, and directory subscriptions.
Update authorization registration and generated validators only where the contract changes.

## Deliver and verify in vertical slices

1. Shared placement rules and mixed-session projection.
2. Indented session shortcuts, context menus, and Snoozed visibility.
3. Conditional deadlines using existing snooze persistence and wake delivery.
4. Snooze-on-send dialog and permission-triggered unsnoozing.
5. Verify unchanged read state; implement and test explicit snooze notification suppression.
6. Compatibility, performance, native navigation, and documentation.

Extend existing suites. Cover read-independent membership, mixed sessions, old/empty
workspaces, descendant permissions, disconnected hosts, session movement, restart and
reconnect, deadlines after downtime, repeated checks, concurrent snooze edits, all user
send entry points, draft preservation, send failures, and notification deduplication.
Specifically test deadline expiry before `nextCheckAt`, during a busy checker, and after
legacy normalization; queue admission versus automatic draining; banners versus push;
and root/descendant state agreement. Delete obsolete workspace membership/visit-retention
code and rewrite its owning docs when the feature ships. Child retention is transient UI
state only, scoped to the existing view visit.

Verify cross-device read state and snooze changes; large lists without transcript
subscriptions or token-driven reorder; desktop/web and native context menus; warm/cold
notification taps; and actual iOS push on a device. Report unavailable platform coverage.

Run targeted test files only, required workspace builds, typecheck, lint, and formatting.
Do not run the full test suite locally or restart the main daemon. Update the owning
lifecycle, mobile navigation, notification, data-model, and fork documentation when
behavior ships, then retire this plan or replace it with links to those contracts.

## Estimate the implementation size

Rough planning estimate, not a measured diff. Counts are hand-written lines added or
substantially rewritten, counted once; they are not net repository growth. Excludes
generated validators, lockfiles, documentation, and broad unrelated refactors.

| Work area                                                     | Implementation LoC |      Test LoC |
| ------------------------------------------------------------- | -----------------: | ------------: |
| Sidebar projection, child rows, expansion, and existing menus |          700–1,100 |       300–500 |
| Minimal snooze protocol/client changes and capability         |            100–200 |       100–180 |
| Conditional deadlines and permissions breaking snooze         |            200–350 |       200–350 |
| Duration selector and form handling                           |            120–220 |       100–180 |
| Shared send guard, dialog, and failure handling               |            200–350 |       150–250 |
| Existing push integration and read-state regression coverage  |             50–120 |       100–180 |
| **Total**                                                     |    **1,370–2,340** | **950–1,640** |

Budget roughly **2,300–4,000 hand-written LoC including tests**. The read/wake-state
work has been removed, but review identified more sidebar integration and real send
entry points than the initial estimate allowed. Deleted workspace filtering reduces
net growth; this range is not net additions.

The main uncertainties are shared user-send coverage and reuse of mixed-session and
descendant selectors. Inspect these before implementation. Do not resolve uncertainty
by adding general infrastructure; revise the estimate if concrete requirements justify it.

## Adversarial review decisions

Gemini Argon and Claude Code Fable independently reviewed the simplified plan through
Paseo. Accepted findings: deadlines independent of condition polling; optional schema
fields before legacy normalization; real user-send entry points separated from queue
draining; explicit in-app and push snooze suppression; neutral wake copy; preservation
of existing descendant status rules; removal of obsolete workspace retention code.

Retain agreed product choices: running work stays visible even while snoozed, mixed
workspaces can appear in both sections, and child shortcuts use recent/unread filtering.
Deduplicate workspace shortcut targets across sections. These are deliberate tradeoffs,
not additional sources of durable truth. A single-section layout or unfiltered child
list remains an optional later UX decision; do not quietly substitute either during
implementation. An empty filtered child list must not suggest the workspace has no
sessions: omit an empty expander and preserve normal workspace navigation.

Reject indefinite legacy snoozes: they violate the timeout guarantee. Keep their fixed
creation-based default rather than adding an upgrade clock. Do not adopt the Argon
review's LoC calculation: it quoted a different estimate table and conflated session
navigation links with deferred keyboard shortcuts. Use the actual scoped table above,
with a larger sidebar allowance informed by Fable's integration review.

Acceptance criterion: you can account for every unarchived workspace, and clearing a
green dot can never make one disappear.
