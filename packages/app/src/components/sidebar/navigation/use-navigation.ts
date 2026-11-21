import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import { useMemo, useState } from "react";
import { useStoreWithEqualityFn } from "zustand/traditional";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import {
  buildSessionActivity,
  buildWorkspaceSessions,
  groupMainFolderWorkspaces,
  sortBySessionActivity,
  sessionIsVisible,
  workspaceSections,
  retainSessionKeys,
  type InboxSection,
  type SidebarSession,
} from "./model";
import { useSidebarNavigationStore } from "./store";

export function useSidebarNavigation(
  projects: SidebarProjectEntry[],
  workspaces: ReadonlyMap<string, SidebarWorkspaceEntry>,
) {
  const projectKey = useSidebarNavigationStore((state) => state.projectKey);
  const inboxVisit = useSidebarNavigationStore((state) => state.inboxVisit);
  const collapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedProjectKeys);
  const lastFocused = useWorkspaceLayoutStore((state) => state.lastFocusedAgentByWorkspace);
  const serverIds = useMemo(
    () => [...new Set(projects.flatMap((project) => project.hosts.map((host) => host.serverId)))],
    [projects],
  );
  const sources = useStoreWithEqualityFn(
    useSessionStore,
    (state): { serverId: string; agents: ReadonlyMap<string, Agent> }[] =>
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
  const activity = useMemo(() => buildSessionActivity(sources), [sources]);
  const active = useActiveWorkspaceSelection();
  const activeKey = active ? `${active.serverId}:${active.workspaceId}` : null;
  const sessions = useMemo(() => buildWorkspaceSessions(sources), [sources]);
  const selectedProject = projects.find((project) => project.viewKey === projectKey) ?? null;
  const [visit, setVisit] = useState({ id: inboxVisit, keys: new Set<string>() });
  const retained = visit.id === inboxVisit ? visit.keys : new Set<string>();
  const eligible = new Set(retained);
  for (const [key, rows] of sessions) {
    for (const row of rows) {
      if (sessionIsVisible(row, Date.now(), key === activeKey ? lastFocused[key] : undefined))
        eligible.add(`${row.serverId}:${row.id}`);
    }
  }
  const keys = retainSessionKeys(retained, eligible);
  if (visit.id !== inboxVisit || keys !== visit.keys)
    setVisit({ id: inboxVisit, keys: new Set(keys) });
  const visibleSessions = useMemo(
    () =>
      new Map(
        [...sessions].map(([key, rows]) => [
          key,
          rows.filter((row) => keys.has(`${row.serverId}:${row.id}`)),
        ]),
      ),
    [sessions, keys],
  );
  const sorted = useMemo(
    () => sortBySessionActivity([...workspaces.values()], activity),
    [workspaces, activity],
  );
  const sections = useMemo(
    () =>
      (["running", "inbox", "snoozed"] as const).map((id) => ({
        id,
        collapsed:
          id === "snoozed"
            ? !collapsed.has("inbox:snoozed:expanded")
            : collapsed.has(`inbox:${id}`),
        workspaces: sorted
          .filter((workspace) =>
            workspaceSections(workspace, sessions.get(workspace.workspaceKey) ?? []).includes(id),
          )
          .sort((a, b) =>
            id === "inbox"
              ? blockedPriority(sessions.get(b.workspaceKey)) -
                blockedPriority(sessions.get(a.workspaceKey))
              : 0,
          ),
      })),
    [sorted, sessions, collapsed],
  );
  const rows = useMemo(
    () =>
      selectedProject
        ? groupMainFolderWorkspaces(
            sorted.filter((workspace) => workspace.projectViewKey === selectedProject.viewKey),
          )
        : sections.flatMap((section) => (section.collapsed ? [] : section.workspaces)),
    [selectedProject, sorted, sections],
  );
  const unreadByProject = useMemo(() => {
    const counts = new Map<string, number>();
    for (const workspace of workspaces.values()) {
      if (workspace.snooze || !activity.get(workspace.workspaceKey)?.unread) continue;
      counts.set(workspace.projectViewKey, (counts.get(workspace.projectViewKey) ?? 0) + 1);
    }
    return counts;
  }, [workspaces, activity]);
  return useMemo(
    () => ({ rows, selectedProject, unreadByProject, sessions: visibleSessions, sections }),
    [rows, selectedProject, unreadByProject, visibleSessions, sections],
  );
}

export function sectionPreferenceKey(id: InboxSection): string {
  return id === "snoozed" ? "inbox:snoozed:expanded" : `inbox:${id}`;
}

function blockedPriority(rows: SidebarSession[] | undefined): number {
  return Number(rows?.some((row) => row.blocked) ?? false);
}
