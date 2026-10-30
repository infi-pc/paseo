import { visibleRailProjectCount } from "./navigation/project-order";
import {
  buildSessionActivity,
  groupMainFolderWorkspaces,
  inboxWorkspaceKeys,
  retainInboxKeys,
  sortBySessionActivity,
  INBOX_ACTIVITY_WINDOW_MS,
} from "./navigation/model";
import { useSidebarNavigationStore } from "./navigation/store";
import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
  SidebarWorkspacePlacement,
} from "@/hooks/use-sidebar-workspaces-list";
import { buildSidebarProjection } from "./sidebar-projection";

function makeWorkspace(
  id: string,
  statusBucket: SidebarWorkspaceEntry["statusBucket"] = "done",
  labels: string[] = [],
  projectViewKey = "project",
) {
  const placement: SidebarWorkspacePlacement = {
    workspaceKey: `srv:${id}`,
    serverId: "srv",
    workspaceId: id,
    projectViewKey,
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: id,
  };
  const entry: SidebarWorkspaceEntry = {
    ...placement,
    workspaceDirectory: "",
    workspaceDirectoryLabel: "",
    title: null,
    currentBranch: null,
    statusBucket,
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    labels,
  };
  return { placement, entry };
}

function makeProject(
  workspaces: SidebarWorkspacePlacement[],
  viewKey = "project",
): SidebarProjectEntry {
  return {
    viewKey,
    projectName: "Project",
    projectKind: "git",
    iconWorkingDir: `/repo/${viewKey}`,
    hosts: [
      {
        serverId: "srv",
        projectId: viewKey,
        iconWorkingDir: `/repo/${viewKey}`,
        worktreeSupport: "supported" as const,
      },
    ],
    workspaces,
  };
}

function projectionInput(options?: { pinnedCollapsed?: boolean }) {
  const pinned = makeWorkspace("pinned", "running");
  const unpinned = makeWorkspace("unpinned", "needs_input");
  return {
    projects: [makeProject([pinned.placement, unpinned.placement])],
    pinnedKeys: {
      pinnedWorkspaceKeys: [pinned.placement.workspaceKey],
      pinnedAtByKey: { [pinned.placement.workspaceKey]: "2026-07-12T12:00:00.000Z" },
    },
    pinnedWorkspaceOrder: [],
    workspaceEntriesByKey: new Map([
      [pinned.entry.workspaceKey, pinned.entry],
      [unpinned.entry.workspaceKey, unpinned.entry],
    ]),
    projectNamesByViewKey: new Map([["project", "Project"]]),
    pinnedCollapsed: options?.pinnedCollapsed ?? false,
    collapsedProjectKeys: new Set<string>(),
  };
}

/**
 * Two projects, one workspace each, both labelled — so every grouping mode puts rows from more
 * than one project on screen, and a mode that asked for fewer icons than it renders would show it.
 */
function twoProjectInput() {
  const first = makeWorkspace("first", "running", ["Urgent"], "project");
  const second = makeWorkspace("second", "needs_input", ["Backend"], "other-project");
  return {
    ...projectionInput(),
    projects: [makeProject([first.placement]), makeProject([second.placement], "other-project")],
    pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
    workspaceEntriesByKey: new Map([
      [first.entry.workspaceKey, first.entry],
      [second.entry.workspaceKey, second.entry],
    ]),
    projectNamesByViewKey: new Map([
      ["project", "Project"],
      ["other-project", "Other project"],
    ]),
  };
}

describe("buildSidebarProjection", () => {
  it("fetches project icons for every rendered project and Inbox row", () => {
    const input = twoProjectInput();
    for (const flatWorkspaces of [undefined, [...input.workspaceEntriesByKey.values()]]) {
      const projection = buildSidebarProjection({ ...input, flatWorkspaces });
      expect(projection.projectIconTargets.map((target) => target.projectViewKey).sort()).toEqual([
        "other-project",
        "project",
      ]);
    }
  });

  it("uses one pin-aware projection for project rows and shortcut order", () => {
    const projection = buildSidebarProjection(projectionInput());

    expect(projection.pinnedGroups.pinnedChats.map((entry) => entry.workspaceId)).toEqual([
      "pinned",
    ]);
    const remainingProject = projection.pinnedGroups.unpinnedProjects[0];
    expect(remainingProject?.workspaces.map((entry) => entry.workspaceId)).toEqual(["unpinned"]);
    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "pinned" },
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });

  it("does not number pinned chats while the pinned section is collapsed", () => {
    const projection = buildSidebarProjection(projectionInput({ pinnedCollapsed: true }));

    expect(projection.shortcutModel.shortcutTargets).toEqual([
      { serverId: "srv", workspaceId: "unpinned" },
    ]);
  });
});

// FORK(project-navigation): Inbox membership and keyboard order share the visible row projection.
describe("Inbox navigation", () => {
  const now = Date.parse("2026-10-29T12:00:00Z");
  const old = now - INBOX_ACTIVITY_WINDOW_MS - 1;

  it("includes the 48-hour boundary and older unread sessions, excluding old read and snoozed workspaces", () => {
    const entries = ["recent", "boundary", "unread", "old", "snoozed"].map(
      (id) => makeWorkspace(id).entry,
    );
    const snoozed = entries[4];
    snoozed.snooze = {
      id: "snooze",
      createdAt: new Date(now).toISOString(),
      config: { mode: "time", wakeAt: "2026-11-01T12:00:00Z", timezone: "UTC" },
      nextCheckAt: "2026-11-01T12:00:00Z",
      lastCheck: null,
    };
    const workspaces = new Map(entries.map((entry) => [entry.workspaceKey, entry]));
    const activity = new Map([
      ["srv:recent", { lastActivityAt: now, unread: false }],
      ["srv:boundary", { lastActivityAt: now - INBOX_ACTIVITY_WINDOW_MS, unread: false }],
      ["srv:unread", { lastActivityAt: old, unread: true }],
      ["srv:old", { lastActivityAt: old, unread: false }],
      ["srv:snoozed", { lastActivityAt: now, unread: true }],
    ]);
    expect([...inboxWorkspaceKeys({ workspaces, activity, now })]).toEqual([
      "srv:recent",
      "srv:boundary",
      "srv:unread",
    ]);
  });

  it("uses the latest session activity while retaining unread from a different session in the workspace", () => {
    const activity = buildSessionActivity(
      [
        {
          serverId: "srv",
          agents: new Map([
            [
              "older",
              {
                id: "older",
                workspaceId: "one",
                lastActivityAt: new Date(old),
                requiresAttention: true,
              },
            ],
            [
              "newer",
              {
                id: "newer",
                workspaceId: "one",
                lastActivityAt: new Date(now - 100),
                requiresAttention: false,
              },
            ],
            [
              "archived",
              {
                id: "archived",
                workspaceId: "two",
                lastActivityAt: new Date(now),
                archivedAt: new Date(now),
              },
            ],
          ]),
        },
      ],
      new Map([["newer", new Date(now)]]),
    );
    expect(activity.get("srv:one")).toEqual({ lastActivityAt: now, unread: true });
    expect(activity.has("srv:two")).toBe(false);
  });

  it("retains read workspaces through the Inbox visit, and adds incoming workspaces", () => {
    const held = new Set(["srv:old-unread"]);
    expect(retainInboxKeys(held, new Set())).toBe(held);
    expect([...retainInboxKeys(held, new Set(["srv:new"]))]).toEqual(["srv:old-unread", "srv:new"]);
    const before = useSidebarNavigationStore.getState().inboxVisit;
    useSidebarNavigationStore.getState().selectProject("another-project");
    expect(useSidebarNavigationStore.getState().inboxVisit).toBe(before + 1);
    useSidebarNavigationStore.getState().selectProject(null);
    expect(useSidebarNavigationStore.getState().inboxVisit).toBe(before + 2);
  });

  it("keeps pinned Inbox workspaces in activity order and gives shortcuts the same order", () => {
    const input = projectionInput();
    const rows = sortBySessionActivity(
      [...input.workspaceEntriesByKey.values()],
      new Map([
        ["srv:pinned", { lastActivityAt: old, unread: true }],
        ["srv:unpinned", { lastActivityAt: now, unread: false }],
      ]),
    );
    const projection = buildSidebarProjection({ ...input, flatWorkspaces: rows });
    expect(rows.map((row) => row.workspaceId)).toEqual(["unpinned", "pinned"]);
    expect(projection.pinnedGroups.pinnedChats).toEqual([]);
    expect(projection.shortcutModel.shortcutTargets.map((target) => target.workspaceId)).toEqual([
      "unpinned",
      "pinned",
    ]);
  });
});

describe("project rail capacity", () => {
  it("reserves Add project and More without creating a scrolling rail", () => {
    expect(visibleRailProjectCount(0, 5)).toBe(0);
    expect(visibleRailProjectCount(80, 5)).toBe(0);
    expect(visibleRailProjectCount(124, 5)).toBe(1);
    expect(visibleRailProjectCount(168, 3)).toBe(3);
    expect(visibleRailProjectCount(167, 3)).toBe(1);
    expect(visibleRailProjectCount(480, 0)).toBe(0);
  });
});

describe("project workspace grouping", () => {
  it("puts main-folder workspaces first and keeps the shortcut order aligned", () => {
    const worktreeNew = makeWorkspace("worktree-new").entry;
    const mainNew = {
      ...makeWorkspace("main-new").entry,
      workspaceKind: "local_checkout" as const,
    };
    const worktreeOld = makeWorkspace("worktree-old").entry;
    const mainOld = { ...makeWorkspace("main-old").entry, workspaceKind: "checkout" as const };
    const rows = groupMainFolderWorkspaces([worktreeNew, mainNew, worktreeOld, mainOld]);
    expect(rows.map((row) => row.workspaceId)).toEqual([
      "main-new",
      "main-old",
      "worktree-new",
      "worktree-old",
    ]);
    const projection = buildSidebarProjection({
      ...projectionInput(),
      pinnedKeys: { pinnedWorkspaceKeys: [], pinnedAtByKey: {} },
      projects: [makeProject(rows)],
    });
    expect(projection.shortcutModel.shortcutTargets.map((target) => target.workspaceId)).toEqual([
      "main-new",
      "main-old",
      "worktree-new",
      "worktree-old",
    ]);
  });

  it("keeps empty and single-kind lists unchanged", () => {
    const worktree = makeWorkspace("worktree").entry;
    const main = { ...makeWorkspace("main").entry, workspaceKind: "local_checkout" as const };
    expect(groupMainFolderWorkspaces([])).toEqual([]);
    expect(groupMainFolderWorkspaces([worktree])).toEqual([worktree]);
    expect(groupMainFolderWorkspaces([main])).toEqual([main]);
  });
});
