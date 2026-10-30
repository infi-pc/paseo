# Mobile panels

Compact layouts have three mutually exclusive destinations:

- `agent-list` on the left
- `agent` in the center
- `file-explorer` on the right

They are one interaction, not two independent drawers. The implementation lives in
`packages/app/src/mobile-panels/`.

## Inbox and project navigation

Desktop uses an icon rail; compact layouts use the selector at the top of the left drawer.
Both select the workspace list independently of the open workspace. Choosing a project must not
navigate the center panel. Choosing a workspace still closes the compact drawer.

Inbox includes workspaces with session activity in the last 48 hours or unread sessions of any age,
ordered by latest session activity. Keep qualifying rows for the current Inbox visit so reading a
session cannot remove the row under the user. Selecting a project ends that visit; returning to
Inbox reevaluates membership. Snoozed and removed workspaces do not remain through this retention.
Session activity has its own durable clock: access, metadata snapshots, history replay, and runtime
reloads must not advance it. Git refreshes and metadata-only status snapshots must not advance it.
Pins remain in activity order in Inbox; project views retain their pinned section. Both lists have a fixed presentation;
there is no grouping preference or grouping command.

Desktop project icons use the persisted sidebar project order. Reserve space for Add project and
show only the icons that fit between Inbox and the footer. The overflow button opens all projects;
dragging there and in the rail changes the same order, also used by the compact picker. Selection
never promotes a project into the visible rail; reorder it to keep it there.

Sidebar selection starts at Inbox in a new app session. It is shared across layout changes, while
the drawer's visibility remains owned by the compact panel model below.

## Ownership

React/Zustand owns the durable intent:

```ts
interface MobilePanelSelection {
  target: "agent-list" | "agent" | "file-explorer";
  revision: number;
}
```

Every semantic target change increments `revision`. Repeating the current target is idempotent.
Compact panel selection is not persisted; a cold start begins at `agent`.

The UI worklet owns transient motion:

- one normalized position (`-1` left, `0` center, `1` right)
- the current motion target
- the active gesture's starting revision
- the last settled target

React publishes the active panel only when the canonical target and the UI-thread position agree at
the final anchor. Retained content never observes gesture previews, progress, or an unsettled target.
The gesture hosts stay mounted. The Gesture Handler web patch keeps initially disabled hosts
from capturing paragraph pointers; that capture confines browser selection to its starting paragraph.
Native worklets own overlay opacity and pointer events while
React owns settled panel activity and accessibility. Keep hidden native overlays laid out: collapsing
their scroll ranges makes Android spring retained offsets back to zero during touch cancellation or
release. Native panel hosts and their dependent draggable lists
also retain identity across appearance hydration and settings changes. Do not wrap those hosts in
appearance keys; see [Unistyles appearance boundaries](unistyles.md#runtime-theme-patching-for-user-preferences).

## Why one position

Both transforms and both backdrop opacities are derived from the same normalized position. Window
width is only a projection input. Rotation changes the projection, not the panel state.

This makes these invalid states unrepresentable:

- a panel and its backdrop disagreeing
- left and right drawers both claiming to be open
- a width-sync effect resetting an active drag
- one animation context settling a transition owned by the other

Do not add another panel translate shared value, backdrop shared value, or width synchronization
effect.

## Ordering and interruption

A gesture captures the current revision when it becomes active. Per-frame updates are accepted only
while that revision still owns the gesture.

When a React command arrives during a drag, its newer revision clears gesture ownership and starts
motion toward the new target. The older gesture's remaining updates and finish callback are ignored.
Canceled gestures return to the latest canonical target. A successful gesture starts its finishing
motion immediately; the matching React command adopts that motion instead of restarting it. Position
settlement and command acceptance may arrive in either order. Activity changes after both agree on
the same target.

Manual gesture arbitration has two phases:

1. Before activation, determine whether horizontal intent may begin.
2. After activation, stop running begin checks and let the active revision own updates.

Re-running the begin gate after activation self-cancels the gesture because an active gesture is, by
definition, no longer eligible to begin.

## Integration rules

- Callers request semantic targets through `panel-store`; they never write shared values.
- Gesture behavior comes from the four explicit hooks in `mobile-panels/gestures.ts`.
- A focused interactive surface may block panel-opening gestures through
  `useBlockMobilePanelOpenGestures`. Register only while the conflicting interaction is active and
  unregister when the surface is hidden or unfocused. The blocker never disables gestures that close
  an already-open panel.
- Keep `SidebarModelProvider` outside `MobileGestureWrapper`. The provider shares sidebar derivation
  across consumers, while Gesture Handler requires the wrapper's direct child to be a native `View`
  so its injected `collapsable={false}` reaches Android/Fabric.
- Mobile sidebars render through `MobilePanelOverlay`; do not duplicate overlay lifecycle or motion
  styles in sidebar components.
- The desktop left sidebar is retained too. App chrome owns separate mounted and visible decisions:
  closing it or yielding its width marks it inactive and applies `display: none` without conditionally
  removing the sidebar tree.
- Animated panel nodes use React Native static styles plus inline theme values. Do not attach
  Unistyles-generated styles to those nodes; Unistyles and Reanimated patching the same Fabric node
  has caused native crashes.
- `FORCE_REACT_RENDER_FOR_SETTLED_ANIMATIONS` stays off in `packages/app/package.json`. It is a
  compile-time flag; changing it needs a native rebuild. With it on, Reanimated 4.3 hands settled
  animated props back to React through a collector that forgets entries older than two seconds. A JS
  stall across a panel settle loses the final position, and the next React commit reverts the overlay
  to its last synced props: a backdrop over the workspace while the store says closed. Upstream fixed
  the collector in 4.4.3, which needs React Native 0.83.
- Gesture start and progress must not update React state. The retained overlay is already mounted and
  offscreen; only the shared position and its derived native styles move during a drag.
- Hidden tabs and workspaces use `RetainedPanel`. It owns a non-collapsible native root, visibility,
  pointer events, and the active signal consumed by `useRetainedPanelActive`.
- Panels whose gesture wrapper already owns visibility use `RetainedPanelActivity` to provide the
  same active signal without adding another layout root. Persistent animations, timers, polling, and
  shared clocks must subscribe to that signal and stop when their final visible consumer leaves.
- Synchronized step animations use one wall-clock-aligned source. Register a local shared value only
  while its retained panel is active so hidden animated styles remain mounted without receiving clock
  updates. Do not give every instance its own loop or leave hidden styles subscribed to the source.
- Retention order and render order are separate concerns. LRU metadata may change on every switch;
  keyed retained roots must keep a stable sibling order. Moving large retained roots triggered Fabric
  Differ failures (`addViewAt` / `removeViewAt` view reuse) on Android.
- `useIsMobilePanelActive` follows the settled target, not the requested target. Position at the
  canonical target's anchor is the settlement signal; animation duration and completion callbacks
  do not own activity. Cancellation publishes nothing.
- Do not suspend retained native subtrees with `Suspense`/`react-freeze`. Suspension changes native
  ownership and can detach descendants. Keep the tree mounted, stabilize its subscriptions/selectors,
  and use the retained-panel active signal to stop timers, polling, and other genuine background work.
  Hidden chat content is suspended on web only, through `retained-chat-content.web.tsx`, where DOM
  nodes carry no Fabric ownership; the native file keeps the chat live.

## Tests

`packages/app/src/mobile-panels/model.test.ts` exercises command, drag, cancellation, interruption,
rapid-command, position-settlement, and width-projection sequences through the transition model. Add
a sequence there whenever ownership or ordering changes.
