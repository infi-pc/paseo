import { describe, expect, it } from "vitest";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import { routeKeyboardShortcut } from "@/keyboard/route-shortcut";

import { buildSidebarShortcutModel, getRelativeSidebarShortcutTarget } from "./sidebar-shortcuts";

function workspace(input: {
  serverId: string;
  workspaceId: string;
  workspaceDirectory: string;
  name: string;
  projectKey?: string;
  statusBucket?: SidebarWorkspaceEntry["statusBucket"];
  statusEnteredAt?: Date | null;
}): SidebarWorkspaceEntry {
  return {
    workspaceKey: `${input.serverId}:${input.workspaceId}`,
    serverId: input.serverId,
    workspaceId: input.workspaceId,
    projectViewKey: input.projectKey ?? "project-default",
    projectName: input.projectKey ?? "Project",
    workspaceDirectory: input.workspaceDirectory,
    workspaceDirectoryLabel: input.workspaceDirectory,
    projectKind: "git",
    workspaceKind: "checkout",
    name: input.name,
    title: null,
    currentBranch: null,
    statusBucket: input.statusBucket ?? "done",
    archivingAt: null,
    statusEnteredAt: input.statusEnteredAt ?? null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
  };
}

function project(projectKey: string, workspaces: SidebarWorkspaceEntry[]): SidebarProjectEntry {
  return {
    viewKey: projectKey,
    projectName: projectKey,
    projectKind: "git",
    iconWorkingDir: workspaces[0]?.workspaceDirectory ?? "",
    hosts: [
      {
        serverId: workspaces[0]?.serverId ?? "s1",
        projectId: projectKey,
        iconWorkingDir: workspaces[0]?.workspaceDirectory ?? "",
        worktreeSupport: "supported" as const,
      },
    ],
    workspaces,
  };
}

describe("buildSidebarShortcutModel", () => {
  it.each([
    [9, 1, 10],
    [10, -1, 9],
    [12, 1, 1],
    [1, -1, 12],
  ] as const)(
    "navigates from workspace %i by %i to workspace %i across the full visible sidebar",
    (current, delta, next) => {
      const workspaces = Array.from({ length: 12 }, (_, index) =>
        workspace({
          serverId: "s",
          workspaceId: `ws-${index + 1}`,
          workspaceDirectory: `/repo/w${index + 1}`,
          name: `w${index + 1}`,
        }),
      );
      const model = buildSidebarShortcutModel({
        projects: [project("p", workspaces)],
        collapsedProjectKeys: new Set<string>(),
      });

      expect(
        routeKeyboardShortcut(
          { action: "workspace.navigate.relative", payload: { delta } },
          {
            pathname: `/h/s/workspace/ws-${current}`,
            isMobile: false,
            sidebarShortcutTargets: model.shortcutTargets,
            navigationActiveWorkspace: null,
            commandCenterOpen: false,
            shortcutsDialogOpen: false,
          },
        ),
      ).toEqual({ kind: "navigate-workspace", serverId: "s", workspaceId: `ws-${next}` });
      expect(model.shortcutIndexByWorkspaceKey.size).toBe(9);
      expect(model.shortcutIndexByWorkspaceKey.get("s:ws-9")).toBe(9);
      expect(model.shortcutIndexByWorkspaceKey.has("s:ws-10")).toBe(false);
    },
  );

  it("builds shortcut targets in visual order and excludes collapsed projects", () => {
    const projects = [
      project("p1", [
        workspace({
          serverId: "s1",
          workspaceId: "ws-main",
          workspaceDirectory: "/repo/main",
          name: "main",
        }),
        workspace({
          serverId: "s1",
          workspaceId: "ws-feat-a",
          workspaceDirectory: "/repo/feat-a",
          name: "feat-a",
        }),
      ]),
      project("p2", [
        workspace({
          serverId: "s1",
          workspaceId: "ws-repo2-main",
          workspaceDirectory: "/repo2/main",
          name: "main",
        }),
        workspace({
          serverId: "s1",
          workspaceId: "ws-repo2-feat-a",
          workspaceDirectory: "/repo2/feat-a",
          name: "feat-a",
        }),
      ]),
    ];

    const model = buildSidebarShortcutModel({
      projects,
      collapsedProjectKeys: new Set<string>(["p2"]),
    });

    expect(model.shortcutTargets).toEqual([
      { serverId: "s1", workspaceId: "ws-main" },
      { serverId: "s1", workspaceId: "ws-feat-a" },
    ]);
    expect(model.shortcutIndexByWorkspaceKey.get("s1:ws-main")).toBe(1);
    expect(model.shortcutIndexByWorkspaceKey.get("s1:ws-feat-a")).toBe(2);
    expect(model.shortcutIndexByWorkspaceKey.get("s1:ws-repo2-main")).toBeUndefined();
  });

  it("keeps all traversal targets while numbering only the first 9", () => {
    const workspaces = Array.from({ length: 20 }, (_, index) =>
      workspace({
        serverId: "s",
        workspaceId: `ws-${index + 1}`,
        workspaceDirectory: `/repo/w${index + 1}`,
        name: `w${index + 1}`,
      }),
    );
    const projects = [project("p", workspaces)];

    const model = buildSidebarShortcutModel({
      projects,
      collapsedProjectKeys: new Set<string>(),
    });

    expect(model.shortcutTargets).toHaveLength(20);
    expect(model.shortcutTargets[8]).toEqual({ serverId: "s", workspaceId: "ws-9" });
    expect(model.shortcutTargets[9]).toEqual({ serverId: "s", workspaceId: "ws-10" });
    expect(model.shortcutIndexByWorkspaceKey.get("s:ws-9")).toBe(9);
    expect(model.shortcutIndexByWorkspaceKey.get("s:ws-10")).toBeUndefined();
  });

  it("excludes a collapsed project's workspaces regardless of project kind", () => {
    const gitProject = project("p1", [
      workspace({
        serverId: "s1",
        workspaceId: "ws-main",
        workspaceDirectory: "/repo/main",
        name: "main",
      }),
    ]);
    const directoryProject = project("p2", [
      workspace({
        serverId: "s1",
        workspaceId: "ws-script",
        workspaceDirectory: "/scripts",
        name: "scripts",
      }),
    ]);
    directoryProject.projectKind = "directory";
    directoryProject.hosts = directoryProject.hosts.map((host) => ({
      ...host,
      worktreeSupport: "unsupported" as const,
    }));

    const model = buildSidebarShortcutModel({
      projects: [gitProject, directoryProject],
      collapsedProjectKeys: new Set<string>(["p1", "p2"]),
    });

    expect(model.shortcutTargets).toEqual([]);
  });
});

describe("getRelativeSidebarShortcutTarget", () => {
  const targets = [
    { serverId: "s1", workspaceId: "ws-1" },
    { serverId: "s1", workspaceId: "ws-2" },
    { serverId: "s1", workspaceId: "ws-3" },
  ];

  it("moves backward and forward through the numbered shortcut target list", () => {
    expect(
      getRelativeSidebarShortcutTarget({
        targets,
        currentTarget: { serverId: "s1", workspaceId: "ws-2" },
        delta: -1,
      }),
    ).toEqual({ serverId: "s1", workspaceId: "ws-1" });

    expect(
      getRelativeSidebarShortcutTarget({
        targets,
        currentTarget: { serverId: "s1", workspaceId: "ws-2" },
        delta: 1,
      }),
    ).toEqual({ serverId: "s1", workspaceId: "ws-3" });
  });

  it("wraps around the numbered shortcut target list", () => {
    expect(
      getRelativeSidebarShortcutTarget({
        targets,
        currentTarget: { serverId: "s1", workspaceId: "ws-1" },
        delta: -1,
      }),
    ).toEqual({ serverId: "s1", workspaceId: "ws-3" });

    expect(
      getRelativeSidebarShortcutTarget({
        targets,
        currentTarget: { serverId: "s1", workspaceId: "ws-3" },
        delta: 1,
      }),
    ).toEqual({ serverId: "s1", workspaceId: "ws-1" });
  });

  it("falls back to the nearest edge when the current route is not in the numbered list", () => {
    expect(
      getRelativeSidebarShortcutTarget({
        targets,
        currentTarget: { serverId: "s1", workspaceId: "ws-hidden" },
        delta: 1,
      }),
    ).toEqual({ serverId: "s1", workspaceId: "ws-1" });

    expect(
      getRelativeSidebarShortcutTarget({
        targets,
        currentTarget: { serverId: "s1", workspaceId: "ws-hidden" },
        delta: -1,
      }),
    ).toEqual({ serverId: "s1", workspaceId: "ws-3" });
  });
});
