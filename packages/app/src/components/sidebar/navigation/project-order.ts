import { useCallback } from "react";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import { mergeWithRemainder } from "@/utils/sidebar-reorder";

export const PROJECT_RAIL_ITEM_SIZE = 36;
export const PROJECT_RAIL_ITEM_GAP = 8;
const PROJECT_RAIL_ITEM_PITCH = PROJECT_RAIL_ITEM_SIZE + PROJECT_RAIL_ITEM_GAP;

/** Reserve Add project, and reserve More only when the projects cannot all fit. */
export function visibleRailProjectCount(height: number, projectCount: number): number {
  const slots = Math.max(0, Math.floor((height + PROJECT_RAIL_ITEM_GAP) / PROJECT_RAIL_ITEM_PITCH));
  if (projectCount + 1 <= slots) return projectCount;
  return Math.max(0, slots - 2);
}

export const projectNavigationKey = (project: SidebarProjectEntry) => project.viewKey;

export function useReorderSidebarProjects() {
  return useCallback((projects: SidebarProjectEntry[]) => {
    const store = useSidebarOrderStore.getState();
    store.setProjectOrder(
      mergeWithRemainder({
        currentOrder: store.getProjectOrder(),
        reorderedVisibleKeys: projects.map(projectNavigationKey),
      }),
    );
  }, []);
}
