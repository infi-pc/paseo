import type { Agent } from "@/stores/session-store";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";

export const INBOX_ACTIVITY_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface SessionActivity {
  lastActivityAt: number;
  unread: boolean;
}

export interface ActivitySource {
  serverId: string;
  agents: ReadonlyMap<
    string,
    Pick<Agent, "id" | "workspaceId" | "archivedAt" | "lastActivityAt" | "requiresAttention">
  >;
}

// FORK(project-navigation): session activity, not git refreshes or status transitions, orders navigation.
export function buildSessionActivity(
  sources: readonly ActivitySource[],
  liveActivity: ReadonlyMap<string, Date>,
): Map<string, SessionActivity> {
  const activity = new Map<string, SessionActivity>();
  for (const source of sources) {
    for (const agent of source.agents.values()) {
      if (agent.archivedAt || !agent.workspaceId) continue;
      const key = `${source.serverId}:${agent.workspaceId}`;
      const previous = activity.get(key);
      const timestamp = liveActivity.get(agent.id) ?? agent.lastActivityAt;
      activity.set(key, {
        lastActivityAt: Math.max(previous?.lastActivityAt ?? 0, timestamp.getTime()),
        unread: Boolean(previous?.unread || agent.requiresAttention),
      });
    }
  }
  return activity;
}

export function inboxWorkspaceKeys(input: {
  workspaces: ReadonlyMap<string, SidebarWorkspaceEntry>;
  activity: ReadonlyMap<string, SessionActivity>;
  now: number;
}): Set<string> {
  const keys = new Set<string>();
  for (const workspace of input.workspaces.values()) {
    if (workspace.snooze) continue;
    const activity = input.activity.get(workspace.workspaceKey);
    if (!activity) continue;
    if (activity.unread || activity.lastActivityAt >= input.now - INBOX_ACTIVITY_WINDOW_MS) {
      keys.add(workspace.workspaceKey);
    }
  }
  return keys;
}

export function retainInboxKeys(
  previous: ReadonlySet<string>,
  eligible: ReadonlySet<string>,
): ReadonlySet<string> {
  if ([...eligible].every((key) => previous.has(key))) return previous;
  return new Set([...previous, ...eligible]);
}

export function sortBySessionActivity(
  workspaces: readonly SidebarWorkspaceEntry[],
  activity: ReadonlyMap<string, SessionActivity>,
): SidebarWorkspaceEntry[] {
  return [...workspaces].sort((a, b) => {
    const delta =
      (activity.get(b.workspaceKey)?.lastActivityAt ?? 0) -
      (activity.get(a.workspaceKey)?.lastActivityAt ?? 0);
    return delta || a.workspaceKey.localeCompare(b.workspaceKey);
  });
}

// FORK(project-navigation): main-folder workspaces precede worktrees within a project.
export function groupMainFolderWorkspaces<T extends { workspaceKind: string }>(
  workspaces: readonly T[],
): T[] {
  return [
    ...workspaces.filter((workspace) => workspace.workspaceKind !== "worktree"),
    ...workspaces.filter((workspace) => workspace.workspaceKind === "worktree"),
  ];
}
