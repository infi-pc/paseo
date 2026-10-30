import { create } from "zustand";

interface SidebarNavigationState {
  projectKey: string | null;
  inboxVisit: number;
  selectProject: (key: string | null) => void;
}

// A new app session opens Inbox. Switching projects never changes the open workspace.
export const useSidebarNavigationStore = create<SidebarNavigationState>((set) => ({
  projectKey: null,
  inboxVisit: 0,
  selectProject: (projectKey) =>
    set((state) =>
      projectKey === state.projectKey
        ? state
        : {
            projectKey,
            inboxVisit: state.inboxVisit + 1,
          },
    ),
}));
