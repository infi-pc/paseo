import { create } from "zustand";
import type { SidebarGroupMode } from "@/stores/sidebar-view-store";

interface SidebarNavigationState {
  projectKey: string | null;
  inboxVisit: number;
  grouping: SidebarGroupMode;
  selectProject: (key: string | null) => void;
  setGrouping: (grouping: SidebarGroupMode) => void;
}

// A new app session opens Inbox. Switching projects never changes the open workspace.
export const useSidebarNavigationStore = create<SidebarNavigationState>((set) => ({
  projectKey: null,
  inboxVisit: 0,
  grouping: "project",
  selectProject: (projectKey) =>
    set((state) => ({
      projectKey,
      inboxVisit: state.inboxVisit + Number(projectKey !== state.projectKey),
    })),
  setGrouping: (grouping) => set({ grouping }),
}));
