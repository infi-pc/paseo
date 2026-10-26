import type { SidebarStateBucket } from "@/hooks/sidebar-workspaces-view-model";

export type SidebarGroupVisibilityPolicy<T> =
  | { kind: "pinned"; isSnoozed: (item: T) => boolean }
  | {
      kind: "workspaces";
      getStatusBucket: (item: T) => SidebarStateBucket;
      isSnoozed: (item: T) => boolean;
    };

// A placement can outrun its entry: a retained sidebar that is inactive (compact layout with the
// sidebar closed) or still waiting for sessions keeps an empty entry map. A missing entry renders
// no row, so it counts as Done and claims no slot past the limit.
export function createWorkspaceVisibilityPolicy<T extends { workspaceKey: string }>(
  entriesByKey: ReadonlyMap<string, { statusBucket: SidebarStateBucket; snooze?: unknown }>,
): SidebarGroupVisibilityPolicy<T> {
  return {
    kind: "workspaces",
    isSnoozed: (item) => Boolean(entriesByKey.get(item.workspaceKey)?.snooze),
    getStatusBucket: (item) => entriesByKey.get(item.workspaceKey)?.statusBucket ?? "done",
  };
}

export function selectSidebarGroupVisibility<T>(
  items: readonly T[],
  expanded: boolean,
  policy: SidebarGroupVisibilityPolicy<T>,
) {
  const limit = policy.kind === "pinned" ? 20 : 7;
  // FORK(workspace-snooze): hidden workspaces remain available under Show all.
  const awake = items.filter((item) => !policy.isSnoozed(item));
  const snoozed = items.filter((item) => policy.isSnoozed(item));
  const baseline = awake.filter(
    (item, index) =>
      index < limit || (policy.kind === "workspaces" && policy.getStatusBucket(item) !== "done"),
  );
  return {
    visibleItems: expanded ? [...awake, ...snoozed] : baseline,
    canToggle: baseline.length < items.length,
  };
}
