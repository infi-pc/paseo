/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act } from "@testing-library/react";
import { createRoot, type Root } from "react-dom/client";
import { Pressable, View } from "react-native";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import type { InboxSection, SidebarSession } from "./model";
import {
  SidebarSessionsContext,
  WorkspaceLeadingSessionToggle,
  WorkspaceSessionRows,
} from "./session-rows";

const compactState = vi.hoisted(() => ({ value: false }));

vi.mock(import("@/constants/layout"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    useIsCompactFormFactor: () => compactState.value,
    isCompactBreakpoint: () => compactState.value,
  };
});

vi.mock("@/utils/navigate-to-agent", () => ({
  navigateToAgent: vi.fn(),
}));

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

function makeWorkspace(id = "ws-1"): SidebarWorkspaceEntry {
  return {
    workspaceKey: `srv:${id}`,
    serverId: "srv",
    workspaceId: id,
    projectViewKey: "proj",
    projectName: "Project",
    projectKind: "git",
    workspaceKind: "worktree",
    name: "Editable - Neon",
    workspaceDirectory: "/repo",
    workspaceDirectoryLabel: "repo",
    title: null,
    currentBranch: "main",
    statusBucket: "done",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    prHint: null,
    archiveHasUncommittedChanges: null,
    archiveUnpushedCommitCount: null,
    scripts: [],
    hasRunningScripts: false,
    labels: [],
  };
}

function makeSession(overrides: Partial<SidebarSession> = {}): SidebarSession {
  return {
    id: "sess-1",
    serverId: "srv",
    title: "Affected e2e tests",
    running: false,
    blocked: false,
    unread: false,
    lastActivityAt: Date.now(),
    ...overrides,
  };
}

function makeSessionsContextValue(workspaceKey: string, sessions: SidebarSession[]) {
  return { sessions: new Map([[workspaceKey, sessions]]), sections: [] };
}

function renderHarness({
  workspace,
  sessions,
  section,
  isHovered,
  onRowPress,
}: {
  workspace: SidebarWorkspaceEntry;
  sessions: SidebarSession[];
  section?: InboxSection;
  isHovered: boolean;
  onRowPress?: () => void;
}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const contextValue = makeSessionsContextValue(workspace.workspaceKey, sessions);

  const renderTree = (hovered: boolean) => {
    act(() => {
      root.render(
        <SidebarSessionsContext.Provider value={contextValue}>
          <Pressable onPress={onRowPress} testID="outer-row">
            <WorkspaceLeadingSessionToggle
              workspaceKey={workspace.workspaceKey}
              section={section}
              isHovered={hovered}
            >
              <View testID="leading-icon" />
            </WorkspaceLeadingSessionToggle>
          </Pressable>
          <WorkspaceSessionRows workspace={workspace} section={section} />
        </SidebarSessionsContext.Provider>,
      );
    });
  };

  renderTree(isHovered);
  mounted.push({ root, container });
  return { container, rerenderHover: renderTree };
}

beforeEach(() => {
  vi.stubGlobal("React", React);
  compactState.value = false;
  useSidebarCollapsedSectionsStore.setState({ collapsedProjectKeys: new Set() });
});

afterEach(() => {
  for (const entry of mounted.splice(0)) {
    act(() => entry.root.unmount());
    entry.container.remove();
  }
});

describe("WorkspaceSessionRows and WorkspaceLeadingSessionToggle", () => {
  it("shows session shortcuts without repeating a timed snooze reminder", () => {
    const wakeAt = "2026-11-26T08:00:00.000Z";
    const workspace: SidebarWorkspaceEntry = {
      ...makeWorkspace(),
      snooze: {
        id: "snooze-1",
        createdAt: "2026-11-23T08:00:00.000Z",
        config: { mode: "time", wakeAt, timezone: "Europe/Prague" },
        nextCheckAt: wakeAt,
        lastCheck: null,
      },
    };
    const { container } = renderHarness({
      workspace,
      sessions: [makeSession()],
      section: "snoozed",
      isHovered: false,
    });

    expect(container.textContent).toBe("Affected e2e tests");
  });

  it("omits the Sessions header line and folds Inbox sessions from the leading icon slot without triggering row press", () => {
    const workspace = makeWorkspace();
    const onRowPress = vi.fn();
    const { container, rerenderHover } = renderHarness({
      workspace,
      sessions: [makeSession({ running: true })],
      section: "inbox",
      isHovered: false,
      onRowPress,
    });

    // No separate "Sessions" label line.
    expect(container.textContent).not.toContain("Sessions");
    // Unfolded by default in Inbox.
    expect(container.querySelector('[data-testid="sidebar-session-srv-sess-1"]')).not.toBeNull();
    // Unhovered on desktop: renders the icon inside the leading toggle slot.
    const toggle = container.querySelector(
      '[data-testid="sidebar-sessions-toggle-srv:ws-1-inbox"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="leading-icon"]')).not.toBeNull();

    // Hovered on desktop: swaps the leading icon for the chevron.
    rerenderHover(true);
    expect(container.querySelector('[data-testid="leading-icon"]')).toBeNull();

    // Clicking the leading toggle folds the session rows without activating the workspace row.
    act(() => {
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onRowPress).not.toHaveBeenCalled();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="sidebar-session-srv-sess-1"]')).toBeNull();

    // Clicking again unfolds the session rows.
    act(() => {
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="sidebar-session-srv-sess-1"]')).not.toBeNull();
  });

  it("defaults project-view sessions to folded and unfolds from the leading icon slot", () => {
    const workspace = makeWorkspace();
    const { container } = renderHarness({
      workspace,
      sessions: [makeSession()],
      section: undefined,
      isHovered: true,
    });

    const toggle = container.querySelector(
      '[data-testid="sidebar-sessions-toggle-srv:ws-1-project"]',
    );
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector('[data-testid="sidebar-session-srv-sess-1"]')).toBeNull();

    act(() => {
      toggle?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(toggle?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector('[data-testid="sidebar-session-srv-sess-1"]')).not.toBeNull();
  });

  it("shows the chevron without hover on compact layouts", () => {
    compactState.value = true;
    const workspace = makeWorkspace();
    const { container } = renderHarness({
      workspace,
      sessions: [makeSession()],
      section: "inbox",
      isHovered: false,
    });

    expect(
      container.querySelector('[data-testid="sidebar-sessions-toggle-srv:ws-1-inbox"]'),
    ).not.toBeNull();
    expect(container.querySelector('[data-testid="leading-icon"]')).toBeNull();
  });

  it("renders only the icon with no toggle when the workspace has no sessions", () => {
    const workspace = makeWorkspace();
    const { container } = renderHarness({
      workspace,
      sessions: [],
      section: "inbox",
      isHovered: true,
    });

    expect(
      container.querySelector('[data-testid="sidebar-sessions-toggle-srv:ws-1-inbox"]'),
    ).toBeNull();
    expect(container.querySelector('[data-testid="leading-icon"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="sidebar-session-srv-sess-1"]')).toBeNull();
  });
});
