import { describe, expect, it } from "vitest";
import { canComposeIntoAgent, formatComposeReference, matchComposeWorkspace } from "./location";

describe("compose source locations", () => {
  it.each([
    { archivedAt: null, isArchiving: false, expected: true },
    { archivedAt: undefined, isArchiving: false, expected: true },
    { archivedAt: "2026-11-01T12:00:00.000Z", isArchiving: false, expected: false },
    { archivedAt: null, isArchiving: true, expected: false },
    { archivedAt: "2026-11-01T12:00:00.000Z", isArchiving: true, expected: false },
  ])("checks session eligibility for compose: %j", ({ archivedAt, isArchiving, expected }) => {
    expect(
      canComposeIntoAgent({
        agent: { workspaceId: "feature", archivedAt },
        workspaceId: "feature",
        isArchiving,
      }),
    ).toBe(expected);
  });

  it("rejects missing sessions and sessions moved to another workspace", () => {
    expect(canComposeIntoAgent({ agent: null, workspaceId: "feature", isArchiving: false })).toBe(
      false,
    );
    expect(
      canComposeIntoAgent({
        agent: { workspaceId: "main", archivedAt: null },
        workspaceId: "feature",
        isArchiving: false,
      }),
    ).toBe(false);
  });

  it("matches the exact checkout, keeping sibling and nested worktrees distinct", () => {
    const workspaces = [
      { id: "main", workspaceDirectory: "/repo" },
      { id: "feature", workspaceDirectory: "/repo-feature" },
      { id: "nested", workspaceDirectory: "/repo/worktrees/feature" },
    ];
    expect(matchComposeWorkspace(workspaces, "/repo/")).toEqual(workspaces[0]);
    expect(matchComposeWorkspace(workspaces, "/repo/worktrees/feature")).toEqual(workspaces[2]);
    expect(matchComposeWorkspace(workspaces, "/repo/src")).toEqual(workspaces[0]);
    expect(matchComposeWorkspace([...workspaces, workspaces[0]!], "/repo")).toBeNull();
  });
  it("selects the closest registered ancestor regardless of workspace order", () => {
    const workspaces = [
      { id: "root", workspaceDirectory: "/worktrees/subtle-otter" },
      { id: "nested", workspaceDirectory: "/worktrees/subtle-otter/apps/web" },
    ];
    expect(matchComposeWorkspace(workspaces, "/worktrees/subtle-otter/apps/web/src/app")).toEqual(
      workspaces[1],
    );
    expect(
      matchComposeWorkspace(workspaces.toReversed(), "/worktrees/subtle-otter/apps/web/src/app/"),
    ).toEqual(workspaces[1]);
    expect(matchComposeWorkspace(workspaces, "/worktrees/subtle-otter/apps/api")).toEqual(
      workspaces[0],
    );
  });

  it("respects directory boundaries and rejects ambiguity only at the closest root", () => {
    const root = { id: "root", workspaceDirectory: "/repo" };
    const nested = { id: "nested", workspaceDirectory: "/repo/apps/web" };
    expect(matchComposeWorkspace([root], "/repo-other/apps/web")).toBeNull();
    expect(matchComposeWorkspace([nested], "/repo/apps/web-other/src")).toBeNull();
    expect(matchComposeWorkspace([root, root, nested], "/repo/apps/web/src")).toEqual(nested);
    expect(matchComposeWorkspace([root, nested, nested], "/repo/apps/web/src")).toBeNull();
  });

  it("handles filesystem roots and Windows separators", () => {
    const filesystem = { id: "filesystem", workspaceDirectory: "/" };
    const windows = { id: "windows", workspaceDirectory: "C:\\repo\\" };
    expect(matchComposeWorkspace([filesystem], "/apps/web")).toEqual(filesystem);
    expect(matchComposeWorkspace([windows], "C:\\repo\\apps\\web")).toEqual(windows);
    expect(matchComposeWorkspace([windows], "C:\\repo-other\\apps\\web")).toBeNull();
  });

  it.each([
    "/worktrees/subtle-otter/apps/web/src/app/[locale]/(web)/Hero.tsx",
    "src/app/[locale]/(web)/Hero.tsx",
  ])("formats a nested app file relative to the matched worktree: %s", (file) => {
    expect(
      formatComposeReference(
        {
          kind: "compose",
          serverId: null,
          cwd: "/worktrees/subtle-otter/apps/web",
          file,
          line: 13,
          column: 13,
        },
        "/worktrees/subtle-otter",
      ),
    ).toBe("apps/web/src/app/[locale]/(web)/Hero.tsx:13:13");
  });

  it("formats absolute locations relative to the checkout", () => {
    expect(
      formatComposeReference(
        {
          kind: "compose",
          serverId: null,
          cwd: "/repo/",
          file: "/repo/src/Button.tsx",
          line: 42,
          column: 7,
        },
        "/repo",
      ),
    ).toBe("src/Button.tsx:42:7");
    expect(
      formatComposeReference(
        {
          kind: "compose",
          serverId: null,
          cwd: "/repo",
          file: "src/Button.tsx",
          line: null,
          column: null,
        },
        "/repo",
      ),
    ).toBe("src/Button.tsx");
    expect(
      formatComposeReference(
        {
          kind: "compose",
          serverId: null,
          cwd: "C:\\repo",
          file: "C:\\repo\\src\\Button.tsx",
          line: 42,
          column: null,
        },
        "C:\\repo",
      ),
    ).toBe("src/Button.tsx:42");
  });
});
