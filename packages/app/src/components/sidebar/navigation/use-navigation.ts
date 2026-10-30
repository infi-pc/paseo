import { useMemo, useState } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore } from "@/stores/session-store";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import {
  buildSessionActivity,
  groupMainFolderWorkspaces,
  inboxWorkspaceKeys,
  retainInboxKeys,
  sortBySessionActivity,
  type ActivitySource,
} from "./model";
import { useSidebarNavigationStore } from "./store";

export function useSidebarNavigation(
  projects: SidebarProjectEntry[],
  workspaces: ReadonlyMap<string, SidebarWorkspaceEntry>,
) {
  const projectKey = useSidebarNavigationStore((state) => state.projectKey);
  const inboxVisit = useSidebarNavigationStore((state) => state.inboxVisit);
  const serverIds = useMemo(
    () => [...new Set(projects.flatMap((project) => project.hosts.map((host) => host.serverId)))],
    [projects],
  );
  const sources = useStoreWithEqualityFn(
    useSessionStore,
    (state): ActivitySource[] =>
      serverIds.flatMap((serverId) => {
        const session = state.sessions[serverId];
        return session ? [{ serverId, agents: session.agents }] : [];
      }),
    (a, b) =>
      a.length === b.length &&
      a.every(
        (source, index) =>
          source.serverId === b[index].serverId && source.agents === b[index].agents,
      ),
  );
  const liveActivity = useSessionStore((state) => state.agentLastActivity);
  const activity = useMemo(
    () => buildSessionActivity(sources, liveActivity),
    [sources, liveActivity],
  );
  const selectedProject = projects.find((project) => project.viewKey === projectKey) ?? null;
  const eligible = inboxWorkspaceKeys({ workspaces, activity, now: Date.now() });
  const [visit, setVisit] = useState({ id: inboxVisit, keys: eligible });
  const previousKeys = visit.id === inboxVisit ? visit.keys : new Set<string>();
  const retainedKeys = selectedProject ? previousKeys : retainInboxKeys(previousKeys, eligible);
  if (visit.id !== inboxVisit || retainedKeys !== visit.keys) {
    setVisit({ id: inboxVisit, keys: new Set(retainedKeys) });
  }
  const rows = useMemo(() => {
    const included = [...workspaces.values()].filter((workspace) =>
      selectedProject
        ? workspace.projectViewKey === selectedProject.viewKey
        : retainedKeys.has(workspace.workspaceKey) && !workspace.snooze,
    );
    const sorted = sortBySessionActivity(included, activity);
    return selectedProject ? groupMainFolderWorkspaces(sorted) : sorted;
  }, [workspaces, selectedProject, retainedKeys, activity]);
  const unreadByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const workspace of workspaces.values()) {
      if (workspace.snooze || !activity.get(workspace.workspaceKey)?.unread) continue;
      counts.set(workspace.projectViewKey, (counts.get(workspace.projectViewKey) ?? 0) + 1);
    }
    return counts;
  }, [activity, workspaces]);
  return useMemo(
    () => ({
      rows,
      selectedProject,
      unreadByProject,
    }),
    [rows, selectedProject, unreadByProject],
  );
}
