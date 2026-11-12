import { isWorkspaceRootAgent } from "@/subagents/policies";
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
    Pick<Agent, "id" | "workspaceId" | "archivedAt" | "lastActivityAt" | "requiresAttention"> &
      Partial<Pick<Agent, "turn" | "lastUserMessageAt" | "createdAt">>
  >;
}

// FORK(project-navigation): session activity, not git refreshes or status transitions, orders navigation.
export function buildSessionActivity(
  sources: readonly ActivitySource[],
): Map<string, SessionActivity> {
  const activity = new Map<string, SessionActivity>();
  for (const source of sources) {
    for (const agent of source.agents.values()) {
      if (agent.archivedAt || !agent.workspaceId) continue;
      const key = `${source.serverId}:${agent.workspaceId}`;
      const previous = activity.get(key);
      const timestamp = navigationActivityDate(agent);
      activity.set(key, {
        lastActivityAt: Math.max(previous?.lastActivityAt ?? 0, timestamp.getTime()),
        unread: Boolean(previous?.unread || agent.requiresAttention),
      });
    }
  }
  return activity;
}

export function retainSessionKeys(
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

export type InboxSection = "running" | "inbox" | "snoozed";
export interface SidebarSession {
  id: string;
  serverId: string;
  title: string;
  running: boolean;
  blocked: boolean;
  unread: boolean;
  lastActivityAt: number;
}

export type NavigationAgent = Pick<
  Agent,
  | "id"
  | "workspaceId"
  | "title"
  | "parentAgentId"
  | "archivedAt"
  | "pendingPermissions"
  | "turn"
  | "requiresAttention"
  | "lastActivityAt"
  | "createdAt"
  | "lastUserMessageAt"
>;

function navigationActivityDate(agent: {
  lastActivityAt: Date;
  turn?: Agent["turn"];
  lastUserMessageAt?: Date | null;
  createdAt?: Date;
}): Date {
  if (agent.turn?.phase === "open")
    return (
      agent.turn.startedAt ?? agent.lastUserMessageAt ?? agent.createdAt ?? agent.lastActivityAt
    );
  return agent.lastActivityAt;
}

// FORK(inbox-workspaces): project/session rows are projections of host agents, never local tabs.
export function buildWorkspaceSessions(
  sources: readonly {
    serverId: string;
    agents: ReadonlyMap<string, NavigationAgent>;
  }[],
): Map<string, SidebarSession[]> {
  const result = new Map<string, SidebarSession[]>();
  for (const { serverId, agents } of sources) {
    const roots = new Map<string, SidebarSession>();
    for (const agent of agents.values()) {
      if (agent.archivedAt || !agent.workspaceId) continue;
      const parent = agent.parentAgentId ? agents.get(agent.parentAgentId) : undefined;
      if (!isWorkspaceRootAgent(agent, parent)) continue;
      const blocked = agent.pendingPermissions.length > 0;
      const row: SidebarSession = {
        id: agent.id,
        serverId,
        title: agent.title ?? "",
        blocked,
        running: !blocked && agent.turn.phase === "open",
        unread: Boolean(agent.requiresAttention),
        lastActivityAt: navigationActivityDate(agent).getTime(),
      };
      roots.set(agent.id, row);
      const key = `${serverId}:${agent.workspaceId}`;
      const rows = result.get(key) ?? [];
      rows.push(row);
      result.set(key, rows);
    }
    contributeDescendantWork(agents, roots);
  }
  for (const rows of result.values())
    rows.sort((a, b) => b.lastActivityAt - a.lastActivityAt || a.id.localeCompare(b.id));
  return result;
}

function contributeDescendantWork(
  agents: ReadonlyMap<string, NavigationAgent>,
  roots: Map<string, SidebarSession>,
): void {
  // Same-workspace descendants contribute work, but their attention remains in the track.
  for (const agent of agents.values()) {
    if (agent.archivedAt || agent.turn.phase !== "open" || agent.pendingPermissions.length > 0)
      continue;
    const visited = new Set<string>();
    let current = agent;
    while (current.parentAgentId && !visited.has(current.id)) {
      visited.add(current.id);
      const parent = agents.get(current.parentAgentId);
      if (!parent || parent.workspaceId !== agent.workspaceId) break;
      const root = roots.get(parent.id);
      if (root && !root.blocked) root.running = true;
      current = parent;
    }
  }
}

export function workspaceSections(
  workspace: SidebarWorkspaceEntry,
  sessions: readonly SidebarSession[],
): InboxSection[] {
  const running =
    sessions.some((session) => session.running) ||
    workspace.hasRunningScripts ||
    (workspace.statusBucket === "running" && !sessions.some((session) => session.blocked));
  if (workspace.snooze) return running ? ["running", "snoozed"] : ["snoozed"];
  const inbox = sessions.some((session) => !session.running) || !running;
  return [...(running ? ["running" as const] : []), ...(inbox ? ["inbox" as const] : [])];
}

export function sessionIsVisible(
  session: SidebarSession,
  now: number,
  selectedId?: string,
): boolean {
  return (
    session.running ||
    session.blocked ||
    session.unread ||
    session.id === selectedId ||
    session.lastActivityAt >= now - INBOX_ACTIVITY_WINDOW_MS
  );
}
