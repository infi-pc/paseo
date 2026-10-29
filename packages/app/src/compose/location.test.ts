import { describe, expect, it } from "vitest";
import { formatComposeReference, matchComposeWorkspace } from "./location";

describe("compose source locations", () => {
  it("matches the exact checkout, keeping sibling and nested worktrees distinct", () => {
    const workspaces = [
      { id: "main", workspaceDirectory: "/repo" },
      { id: "feature", workspaceDirectory: "/repo-feature" },
      { id: "nested", workspaceDirectory: "/repo/worktrees/feature" },
    ];
    expect(matchComposeWorkspace(workspaces, "/repo/")).toEqual(workspaces[0]);
    expect(matchComposeWorkspace(workspaces, "/repo/worktrees/feature")).toEqual(workspaces[2]);
    expect(matchComposeWorkspace(workspaces, "/repo/src")).toBeNull();
    expect(matchComposeWorkspace([...workspaces, workspaces[0]!], "/repo")).toBeNull();
  });
  it("formats absolute locations relative to the checkout", () => {
    expect(
      formatComposeReference({
        kind: "compose",
        serverId: null,
        cwd: "/repo/",
        file: "/repo/src/Button.tsx",
        line: 42,
        column: 7,
      }),
    ).toBe("src/Button.tsx:42:7");
    expect(
      formatComposeReference({
        kind: "compose",
        serverId: null,
        cwd: "/repo",
        file: "src/Button.tsx",
        line: null,
        column: null,
      }),
    ).toBe("src/Button.tsx");
    expect(
      formatComposeReference({
        kind: "compose",
        serverId: null,
        cwd: "C:\\repo",
        file: "C:\\repo\\src\\Button.tsx",
        line: 42,
        column: null,
      }),
    ).toBe("src/Button.tsx:42");
  });
});
