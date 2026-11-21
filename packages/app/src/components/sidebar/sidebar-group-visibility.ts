import type { SidebarStateBucket } from "@/hooks/sidebar-workspaces-view-model";
import type { ActiveWorkspaceSelection } from "@/stores/last-workspace-selection";

export interface SidebarGroupItem {
  serverId: string;
  workspaceId: string;
}

export interface SidebarGroupVisibilityInput<T> {
  items: readonly T[];
  expanded: boolean;
  policy: SidebarGroupVisibilityPolicy<T>;
  /** The workspace the group's rows highlight as selected. Null when no row can be selected. */
  selection: ActiveWorkspaceSelection | null;
}

export interface SidebarGroupVisibility<T> {
  /**
   * The open workspace when the collapsed limit would hide it. Rendered before `visibleItems`,
   * out of group order, outside any drag list. Never also present in `visibleItems`.
   */
  leadingItem: T | null;
  visibleItems: T[];
  canToggle: boolean;
}

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

function isOpenWorkspace(
  item: SidebarGroupItem,
  selection: ActiveWorkspaceSelection | null,
): boolean {
  return (
    selection !== null &&
    item.serverId === selection.serverId &&
    item.workspaceId === selection.workspaceId
  );
}

export function selectSidebarGroupVisibility<T extends SidebarGroupItem>(
  input: SidebarGroupVisibilityInput<T>,
): SidebarGroupVisibility<T> {
  const { items, expanded, policy, selection } = input;
  // FORK(project-navigation): keep twenty project rows visible, matching pinned groups.
  const limit = 20;
  const baseline: T[] = [];
  let leadingItem: T | null = null;
  let canToggle = false;

  const awake = items.filter((item) => !policy.isSnoozed(item));
  const snoozed = items.filter((item) => policy.isSnoozed(item));
  // Snoozed workspaces remain accounted for in project panels.
  canToggle = false;
  awake.forEach((item, index) => {
    const inBaseline =
      index < limit || (policy.kind === "workspaces" && policy.getStatusBucket(item) !== "done");
    if (inBaseline) {
      baseline.push(item);
    } else if (leadingItem === null && isOpenWorkspace(item, selection)) {
      leadingItem = item;
    } else {
      canToggle = true;
    }
  });

  if (expanded || !canToggle) {
    return { leadingItem: null, visibleItems: [...awake, ...snoozed], canToggle };
  }

  return {
    leadingItem,
    visibleItems: [...baseline, ...snoozed],
    canToggle,
  };
}
