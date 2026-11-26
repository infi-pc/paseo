// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KeyboardActionDispatcherProvider,
  useKeyboardActionDispatcher,
} from "@/keyboard/keyboard-action-dispatcher-context";
import { DEFAULT_BINDINGS, resolveKeyboardShortcut } from "@/keyboard/keyboard-shortcuts";
import { routeKeyboardShortcut } from "@/keyboard/route-shortcut";
import { EditableOverlay } from "./EditableOverlay.web";
import { EditableStatusPill } from "./EditableStatusPill.web";
import type { EditableDesktopBridge, EditableDesktopStatus } from "./types";

const {
  isReady,
  push,
  send,
  startWorkshop,
  fetchAgentTimeline,
  subscribeAgentTimeline,
  sendAgentMessage,
  cancelAgent,
  respondToPermission,
} = vi.hoisted(() => ({
  isReady: vi.fn(() => true),
  push: vi.fn(),
  send: vi
    .fn()
    .mockResolvedValue({ kind: "sent", agentId: "agent-1", slug: "use-a-smaller-label" }),
  startWorkshop: vi.fn().mockResolvedValue({ serverId: "workshop", repoDir: "/repo" }),
  fetchAgentTimeline: vi.fn().mockResolvedValue({
    epoch: "ep-1",
    agent: { id: "agent-1", status: "idle", pendingPermissions: [] },
    entries: [
      {
        provider: "codex",
        seqStart: 1,
        seqEnd: 1,
        timestamp: "2026-11-25T10:00:00.000Z",
        sourceSeqRanges: [],
        collapsed: [],
        item: { type: "assistant_message", text: "Looks good — want me to apply it?" },
      },
    ],
  }),
  subscribeAgentTimeline: vi.fn(() => Object.assign(() => {}, { ready: Promise.resolve() })),
  sendAgentMessage: vi.fn().mockResolvedValue(undefined),
  cancelAgent: vi.fn().mockResolvedValue(undefined),
  respondToPermission: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/runtime/host-runtime", () => ({
  getHostRuntimeStore: () => ({
    getHosts: () => [],
    getSnapshot: () => null,
    getClient: () => ({
      fetchAgentTimeline,
      subscribeAgentTimeline,
      sendAgentMessage,
      cancelAgent,
      respondToPermission,
      on: vi.fn(() => () => {}),
    }),
  }),
}));
vi.mock("expo-router", () => {
  const navigation = { isReady };
  return {
    usePathname: () => "/workspaces",
    useNavigationContainerRef: () => navigation,
    useRouter: () => ({ push }),
  };
});
vi.mock("react-i18next", async () => {
  const { en } = await import("@/i18n/resources/en");
  return {
    initReactI18next: { type: "3rdParty", init: () => {} },
    useTranslation: () => ({
      t: (key: string) => {
        let cur: unknown = en;
        for (const part of key.split(".")) {
          if (!cur || typeof cur !== "object") return key;
          cur = (cur as Record<string, unknown>)[part];
        }
        return typeof cur === "string" ? cur : key;
      },
    }),
  };
});
vi.mock("./use-workshop", () => ({
  useWorkshop: (options?: { bridge?: EditableDesktopBridge; workshopDaemon?: unknown }) => ({
    config: { enabled: true },
    hosts: [{ serverId: "workshop", label: "Workshop" }],
    host: { serverId: "workshop", label: "Workshop" },
    hostId: "workshop",
    agentId: "agent-1",
    agentStatus: "idle",
    lastRequest: "Make header red",
    isConnected: true,
    managedWorkshop: Boolean(options?.bridge?.startWorkshopDaemon),
    workshopDaemon: options?.workshopDaemon ?? null,
    startingWorkshop: false,
    workshopError: null,
    saving: false,
    sending: false,
    editing: false,
    startWorkshop,
    send,
  }),
}));

const digest = "a".repeat(64);
const optimisticWorkshop = {
  editing: true,
  sending: true,
  hostId: "workshop",
  pendingBranches: {
    "optimistic-question": {
      slug: "optimistic-question",
      request: "Check whether the model returned a title",
      createdAt: "2026-11-25T19:15:00.000Z",
    },
  },
  branchAgents: {
    "unsampled-agent": {
      slug: "unsampled-agent",
      agentId: "agent-2",
      request: "Fresh agent before first status poll",
      createdAt: "2026-11-25T19:15:01.000Z",
    },
  },
  agentStatuses: {},
};
const emptyLineStat = { additions: 0, deletions: 0 };
const titleDiffBranchesFixture = {
  loadedChannel: "wip-we-have-tnik",
  loadedDigest: digest,
  safeRenderer: false,
  main: {
    slug: "main",
    channel: "prod",
    branch: "feat/editable-paseo-desktop",
    isMain: true,
    status: "ready" as const,
    summary: "Enable Antigravity response metadata",
    releaseDigest: digest,
    generation: 21,
    sourceSha: "1".repeat(40),
    behindMain: false,
    canFastForward: false,
    requiresDaemon: false,
    hasUpdate: false,
    loaded: false,
    remoteOnly: false,
    agentId: null,
    error: null,
    updatedAt: "2026-11-26T17:04:32.000Z",
  },
  branches: [
    {
      slug: "we-have-tnik",
      channel: "wip-we-have-tnik",
      branch: "ed/wip/we-have-tnik",
      isMain: false,
      title: "PR Link Icons",
      icon: "🔗",
      status: "ready" as const,
      summary: "Render PR links with status icons in markdown tables.",
      diffStat: {
        additions: 48,
        deletions: 7,
        breakdown: {
          code: { additions: 12, deletions: 3 },
          components: { additions: 6, deletions: 1 },
          styles: emptyLineStat,
          ci: emptyLineStat,
          config: emptyLineStat,
          tooling: emptyLineStat,
          otherCode: emptyLineStat,
          comments: emptyLineStat,
          docs: { additions: 10, deletions: 0 },
          tests: { additions: 20, deletions: 3 },
          generated: emptyLineStat,
          formatting: emptyLineStat,
          blank: emptyLineStat,
          other: emptyLineStat,
          commentsIncluded: emptyLineStat,
        },
      },
      releaseDigest: digest,
      services: ["ui" as const],
      generation: 1,
      sourceSha: "2".repeat(40),
      hasChanges: true,
      behindMain: false,
      canFastForward: true,
      requiresDaemon: false,
      hasUpdate: false,
      loaded: true,
      remoteOnly: false,
      agentId: "agent-1",
      error: null,
      updatedAt: "2026-11-26T18:20:00.000Z",
    },
  ],
};
const titleDiffWorkshopFixture = {
  editing: false,
  hostId: "workshop",
  agentReplies: {
    "we-have-tnik": "Aligned the PR icon vertically and restaged the UI.",
  },
  unreadReplySlugs: ["we-have-tnik"],
};

const noopPick = () => {};
const status: EditableDesktopStatus = {
  runtimeVersion: "desktop-1",
  activeDigest: digest,
  releaseDigest: digest,
  availableDigest: null,
  previewUrl: null,
  activeGeneration: 1,
  lastKnownGoodDigest: null,
  quarantinedDigests: [],
  safeRenderer: false,
};

function setup() {
  function Fixture() {
    const dispatcher = useKeyboardActionDispatcher();
    const onKeyDown = useCallback(
      (event: ReactKeyboardEvent<HTMLButtonElement>) => {
        const { match } = resolveKeyboardShortcut({
          event: event.nativeEvent,
          context: {
            isMac: false,
            usesDesktopBindings: false,
            focusScope: "other",
            commandCenterOpen: false,
          },
          chordState: { candidateIndices: [], step: 0, timeoutId: null },
          onChordReset: () => {},
        });
        if (!match) return;
        const routed = routeKeyboardShortcut(match, {
          pathname: "/workspaces",
          isMobile: false,
          commandCenterOpen: false,
          shortcutsDialogOpen: false,
          sidebarShortcutTargets: [],
          navigationActiveWorkspace: null,
        });
        if (routed.kind === "dispatch") dispatcher.dispatch(routed.action);
      },
      [dispatcher],
    );
    return (
      <>
        <button
          type="button"
          data-ed-src="packages/app/src/Header.tsx:42:5"
          data-ed-comp="WorkspaceHeader"
          onClick={pageClick}
          onKeyDown={onKeyDown}
        >
          Page action
        </button>
        <EditableOverlay />
      </>
    );
  }
  const pageClick = vi.fn();
  render(
    <KeyboardActionDispatcherProvider>
      <Fixture />
    </KeyboardActionDispatcherProvider>,
  );
  const target = screen.getByRole("button", { name: "Page action" });
  const shortcut = () =>
    fireEvent.keyDown(target, {
      key: "F8",
      code: "F8",
      altKey: true,
      shiftKey: true,
    });
  return { target, shortcut, pageClick };
}

afterEach(() => {
  cleanup();
  delete window.paseoDesktop;
  isReady.mockReturnValue(true);
  push.mockClear();
  send.mockClear();
  startWorkshop.mockClear();
  vi.useRealTimers();
});

describe("Editable overlay", () => {
  it("uses a unique chord and toggles pick mode without desktop preload", () => {
    expect(
      DEFAULT_BINDINGS.filter(({ combo }) => combo === "Alt+Shift+F8").map(({ action }) => action),
    ).toEqual(["editable.pick"]);
    const { shortcut } = setup();
    shortcut();
    expect(screen.getByText("Click a component to ask or edit. Esc to cancel.")).toBeTruthy();
    shortcut();
    expect(screen.queryByText("Click a component to ask or edit. Esc to cancel.")).toBeNull();
    shortcut();
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(screen.queryByText("Click a component to ask or edit. Esc to cancel.")).toBeNull();
  });

  it("reveals boundaries while holding Option/Alt and opens the prompt on Option+Click", () => {
    const { target, pageClick } = setup();
    fireEvent.keyDown(window, { key: "Alt", code: "AltLeft", altKey: true });
    fireEvent.pointerMove(target);
    expect(screen.getByText("WorkspaceHeader · Header.tsx:42")).toBeTruthy();

    fireEvent.keyUp(window, { key: "Alt", code: "AltLeft", altKey: false });
    expect(screen.queryByText("WorkspaceHeader · Header.tsx:42")).toBeNull();

    fireEvent.keyDown(window, { key: "Alt", code: "AltLeft", altKey: true });
    fireEvent.click(target, { altKey: true });
    expect(pageClick).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Ask or edit this component…" })).toBeTruthy();
  });

  it("intercepts a component click, closes on Escape and stays open in live chat on Enter", async () => {
    const { target, shortcut, pageClick } = setup();
    shortcut();
    fireEvent.pointerMove(target);
    expect(screen.getByText("WorkspaceHeader · Header.tsx:42").textContent).toBe(
      "WorkspaceHeader · Header.tsx:42",
    );
    fireEvent.click(target);
    expect(pageClick).not.toHaveBeenCalled();
    const label = "Ask or edit this component…";
    expect(screen.getByRole("dialog").getAttribute("aria-label")).toBe(label);
    fireEvent.keyDown(screen.getByRole("textbox", { name: label }), {
      key: "Escape",
      code: "Escape",
    });
    expect(screen.queryByRole("dialog")).toBeNull();

    shortcut();
    fireEvent.click(target);
    const input = screen.getByRole("textbox", { name: label });
    fireEvent.change(input, { target: { value: "Use a smaller label." } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });
    await waitFor(() =>
      expect(screen.getByRole("dialog", { name: "use-a-smaller-label" })).toBeTruthy(),
    );
    expect(await screen.findByText("Looks good — want me to apply it?")).toBeTruthy();
    expect(send).toHaveBeenCalledExactlyOnceWith(
      {
        file: "packages/app/src/Header.tsx",
        line: 42,
        column: 5,
        componentName: "WorkspaceHeader",
        route: "/workspaces",
        releaseDigest: null,
        platform: "web",
      },
      "Use a smaller label.",
      "",
      expect.objectContaining({
        isFollowUp: false,
        snapshot: expect.objectContaining({
          dom: expect.objectContaining({ tag: "button", text: "Page action" }),
        }),
      }),
    );

    // Follow-up reply stays in the same popover and Escape docks it cleanly
    const replyInput = screen.getByRole("textbox", { name: "Reply in this thread…" });
    fireEvent.change(replyInput, { target: { value: "Yes, go ahead." } });
    fireEvent.keyDown(replyInput, { key: "Enter", code: "Enter" });
    await waitFor(() =>
      expect(sendAgentMessage).toHaveBeenCalledWith(
        "agent-1",
        "Yes, go ahead.",
        expect.objectContaining({ messageId: expect.any(String) }),
      ),
    );
    fireEvent.keyDown(replyInput, { key: "Escape", code: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("preserves the prompt and reopens it when the Workshop host is offline", async () => {
    send.mockResolvedValueOnce({ kind: "offline" });
    const { target, shortcut } = setup();
    shortcut();
    fireEvent.click(target);
    fireEvent.change(screen.getByRole("textbox", { name: "Ask or edit this component…" }), {
      target: { value: "Keep this draft." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe(
      "The Workshop host is offline. Reconnect it or choose another host.",
    );
    expect(
      (screen.getByRole("textbox", { name: "Ask or edit this component…" }) as HTMLInputElement)
        .value,
    ).toBe("Keep this draft.");
  });

  it("includes the underlying error detail when sending throws", async () => {
    send.mockRejectedValueOnce(
      new Error("Workshop directory not found on host: ~/.editable-paseo/repo"),
    );
    const { target, shortcut } = setup();
    shortcut();
    fireEvent.click(target);
    fireEvent.change(screen.getByRole("textbox", { name: "Ask or edit this component…" }), {
      target: { value: "Keep this draft too." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe(
      "Could not send the edit. Check the Workshop host and repository path, then try again. (Workshop directory not found on host: ~/.editable-paseo/repo)",
    );
    expect(
      (screen.getByRole("textbox", { name: "Ask or edit this component…" }) as HTMLInputElement)
        .value,
    ).toBe("Keep this draft too.");
  });

  it("opens the bottom-right status popover with branch switcher, Ship vs Update to main, and blinking Reload pill", async () => {
    const syncNow = vi.fn().mockResolvedValue({ ok: true, updated: false });
    const loadBranch = vi.fn().mockResolvedValue({ ok: true });
    const shipBranch = vi
      .fn()
      .mockResolvedValue({ ok: true, fastForwarded: true, autoLoaded: true });
    const discardBranch = vi.fn().mockResolvedValue({ ok: true });
    const getWorkshopStatus = vi.fn().mockResolvedValue({
      status: "running",
      serverId: "workshop",
      listen: "127.0.0.1:6769",
      pid: 1234,
      home: "/Users/tester/.paseo-workshop",
      repoDir: "/Users/tester/.editable-paseo/repo",
      worktrees: ["fast-branch", "behind-branch"],
      error: null,
    });
    const getBranches = vi.fn().mockResolvedValue({
      loadedChannel: "prod",
      loadedDigest: digest,
      safeRenderer: false,
      main: {
        slug: "main",
        channel: "prod",
        branch: "feat/editable-paseo-desktop",
        isMain: true,
        status: "ready",
        summary: "Current main release",
        releaseDigest: "c".repeat(64),
        generation: 8,
        sourceSha: "1".repeat(40),
        behindMain: false,
        canFastForward: false,
        requiresDaemon: false,
        hasUpdate: true,
        loaded: true,
        remoteOnly: false,
        agentId: null,
        error: null,
        updatedAt: "2026-11-25T10:00:00.000Z",
      },
      branches: [
        {
          slug: "fast-branch",
          channel: "wip-fast-branch",
          branch: "ed/wip/fast-branch",
          isMain: false,
          status: "ready",
          summary: "Fast WIP change",
          releaseDigest: "d".repeat(64),
          generation: 1,
          sourceSha: "2".repeat(40),
          behindMain: false,
          canFastForward: true,
          requiresDaemon: false,
          hasUpdate: false,
          loaded: false,
          remoteOnly: false,
          agentId: "agent-1",
          error: null,
          updatedAt: "2026-11-25T10:01:00.000Z",
        },
        {
          slug: "behind-branch",
          channel: "wip-behind-branch",
          branch: "ed/wip/behind-branch",
          isMain: false,
          status: "ready",
          summary: "Older parallel branch",
          releaseDigest: "e".repeat(64),
          generation: 1,
          sourceSha: "3".repeat(40),
          hasChanges: true,
          behindMain: true,
          canFastForward: false,
          requiresDaemon: true,
          hasUpdate: false,
          loaded: false,
          remoteOnly: false,
          agentId: "agent-2",
          error: null,
          updatedAt: "2026-11-25T10:00:00.000Z",
        },
        {
          slug: "question-only",
          channel: "wip-question-only",
          branch: "ed/wip/question-only",
          isMain: false,
          status: "idle",
          summary: "What do you think about these headers?",
          releaseDigest: null,
          generation: null,
          sourceSha: "1".repeat(40),
          hasChanges: false,
          behindMain: false,
          canFastForward: false,
          requiresDaemon: false,
          hasUpdate: false,
          loaded: false,
          remoteOnly: false,
          agentId: "agent-3",
          error: null,
          updatedAt: "2026-11-25T09:59:00.000Z",
        },
      ],
    });
    const bridge = {
      getStatus: vi.fn().mockResolvedValue({ ...status, releaseSummary: "Current main release" }),
      reportHealthy: vi.fn().mockResolvedValue(undefined),
      syncNow,
      getBranches,
      loadBranch,
      shipBranch,
      discardBranch,
      getWorkshopStatus,
      startWorkshopDaemon: vi.fn(),
    } satisfies Partial<EditableDesktopBridge>;
    window.paseoDesktop = { editable: bridge as unknown as EditableDesktopBridge };
    setup();

    // Collapsed pill shows blinking dot + 1-click Reload button when loaded branch has update
    expect(await screen.findByRole("button", { name: "Reload" })).toBeTruthy();
    expect(document.querySelector('[data-ed-blink="true"]')).not.toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Editable Paseo status" }));
    const popover = await screen.findByRole("dialog", { name: "Editable Paseo" });
    expect(popover.textContent).toContain("main");
    expect(popover.textContent).toContain("v8");
    expect(popover.textContent).toContain("fast-branch");
    expect(popover.textContent).toContain("behind-branch");
    expect(popover.textContent).toContain("question-only");
    expect(popover.textContent).toContain("No changes");
    expect(popover.textContent).toContain("UI");
    expect(popover.textContent).toContain("Daemon");
    expect(popover.textContent).toContain("behind main");
    expect(popover.textContent).toContain("Fallback");

    // Only the 2 branches with changes offer Load / Ship / Update to main; question-only only offers Chat + discard
    expect(screen.getAllByRole("button", { name: "Load" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Chat" })).toHaveLength(3);

    // Both ready branches say "Ship"; the behind-main one adds the update icon + explanatory tooltip
    const shipButtons = screen.getAllByRole("button", { name: "Ship" });
    expect(shipButtons).toHaveLength(2);
    expect(document.querySelectorAll('[data-ed-ship-update="true"]')).toHaveLength(1);
    fireEvent.mouseEnter(shipButtons[1]!.parentElement!);
    expect(screen.getByRole("tooltip").textContent).toContain("Updates with latest main");
    fireEvent.mouseLeave(shipButtons[1]!.parentElement!);

    fireEvent.click(shipButtons[0]!);
    await waitFor(() => expect(shipBranch).toHaveBeenCalledWith("fast-branch"));
    fireEvent.click(shipButtons[1]!);
    await waitFor(() => expect(shipBranch).toHaveBeenCalledWith("behind-branch"));

    fireEvent.click(screen.getAllByRole("button", { name: "Load" })[0]!);
    await waitFor(() => expect(loadBranch).toHaveBeenCalledWith("wip-fast-branch"));

    // Clicking Chat opens the embedded chat right inside the bottom-right popover
    fireEvent.click(screen.getAllByRole("button", { name: "Chat" })[0]!);
    expect(await screen.findByRole("dialog", { name: "fast-branch" })).toBeTruthy();
    expect(await screen.findByText("Looks good — want me to apply it?")).toBeTruthy();
    expect(push).not.toHaveBeenCalled();

    // Back returns to the branch switcher list
    fireEvent.click(screen.getByRole("button", { name: "Back to branches" }));
    expect(await screen.findByRole("dialog", { name: "Editable Paseo" })).toBeTruthy();

    // Open chat again and use the pop-out icon to open the full Paseo tab
    fireEvent.click(screen.getAllByRole("button", { name: "Chat" })[0]!);
    fireEvent.click(await screen.findByRole("button", { name: "Open in full tab" }));
    expect(push).toHaveBeenCalledWith("/h/workshop/agent/agent-1");
  });

  it("shows the current branch vs New branch toggle when a WIP branch is loaded", async () => {
    const bridge = {
      getStatus: vi.fn().mockResolvedValue({ ...status, activeChannel: "wip-compact-sidebar" }),
      reportHealthy: vi.fn().mockResolvedValue(undefined),
    } satisfies Partial<EditableDesktopBridge>;
    window.paseoDesktop = { editable: bridge as unknown as EditableDesktopBridge };
    const { target, shortcut } = setup();
    await act(async () => {});
    shortcut();
    fireEvent.click(target);
    expect(await screen.findByRole("button", { name: "compact-sidebar" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New branch" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Ask or edit this component…" }), {
      target: { value: "Different idea" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[3]).toMatchObject({ isFollowUp: false });
  });

  it("acknowledges a signed renderer only after the navigation container is ready", async () => {
    vi.useFakeTimers();
    isReady.mockReturnValue(false);
    const bridge = {
      getStatus: vi.fn().mockResolvedValue(status),
      reportHealthy: vi.fn().mockResolvedValue(undefined),
    } satisfies Partial<EditableDesktopBridge>;
    window.paseoDesktop = { editable: bridge as unknown as EditableDesktopBridge };
    setup();
    await act(async () => {});
    expect(bridge.reportHealthy).not.toHaveBeenCalled();
    isReady.mockReturnValue(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(bridge.reportHealthy).toHaveBeenCalledExactlyOnceWith(digest);
  });

  it("applies the newer digest advertised by the desktop bridge", async () => {
    const availableDigest = "b".repeat(64);
    const bridge = {
      getStatus: vi.fn().mockResolvedValue({ ...status, availableDigest }),
      reportHealthy: vi.fn().mockResolvedValue(undefined),
      switchRelease: vi.fn().mockResolvedValue({ ok: true }),
    } satisfies Partial<EditableDesktopBridge>;
    window.paseoDesktop = { editable: bridge as unknown as EditableDesktopBridge };
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Apply" }));
    expect(bridge.switchRelease).toHaveBeenCalledExactlyOnceWith(availableDigest);
  });

  it("exits preview through the desktop bridge and never acknowledges another window's release", async () => {
    const bridge = {
      getStatus: vi.fn().mockResolvedValue({
        ...status,
        releaseDigest: null,
        previewUrl: "http://localhost:8081",
      }),
      reportHealthy: vi.fn().mockResolvedValue(undefined),
      setPreviewUrl: vi.fn().mockResolvedValue(undefined),
    } satisfies Partial<EditableDesktopBridge>;
    window.paseoDesktop = { editable: bridge as unknown as EditableDesktopBridge };
    setup();
    fireEvent.click(await screen.findByRole("button", { name: "Exit" }));
    expect(bridge.setPreviewUrl).toHaveBeenCalledExactlyOnceWith(null);
    expect(bridge.reportHealthy).not.toHaveBeenCalled();
  });

  it("shows optimistic pending branches and unsampled clientAgents immediately as Working", () => {
    render(
      <EditableStatusPill
        bridge={undefined}
        status={status}
        workshopDaemon={null}
        branches={null}
        workshop={optimisticWorkshop}
        onPick={noopPick}
        layer={100}
      />,
    );

    expect(screen.getByText("2 working")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Editable Paseo status" }));
    expect(screen.getByText("optimistic-question")).toBeTruthy();
    expect(screen.getByText("unsampled-agent")).toBeTruthy();
    expect(screen.getAllByText("Working…")).toHaveLength(2);
  });

  it("strips <paseo-meta> and renders clickable recommended prompts with send and edit actions", async () => {
    sendAgentMessage.mockClear();
    fetchAgentTimeline.mockResolvedValueOnce({
      epoch: "ep-meta",
      agent: { id: "agent-1", status: "idle", pendingPermissions: [] },
      entries: [
        {
          provider: "codex",
          seqStart: 1,
          seqEnd: 1,
          timestamp: "2026-11-25T10:00:00.000Z",
          sourceSeqRanges: [],
          collapsed: [],
          turnId: "turn-1",
          item: {
            type: "assistant_message",
            text: 'Confirmed the reply omitted prompts.\n<paseo-meta message="Confirmed." title="Response metadata" icon="🔎" prompt1="Make Paseo require a prompt" prompt2="Inspect turn footer" />',
          },
        },
      ],
    });
    const { target, shortcut } = setup();
    shortcut();
    fireEvent.click(target);
    const input = screen.getByRole("textbox", { name: "Ask or edit this component…" });
    fireEvent.change(input, { target: { value: "Check metadata" } });
    fireEvent.keyDown(input, { key: "Enter", code: "Enter" });

    expect(await screen.findByText("Confirmed the reply omitted prompts.")).toBeTruthy();
    expect(screen.queryByText(/<paseo-meta/)).toBeNull();
    expect(screen.getByText(/🔎\s*use-a-smaller-label/)).toBeTruthy();

    // Edit button puts the recommended prompt into the composer for editing
    fireEvent.click(screen.getByRole("button", { name: "Use edited: Inspect turn footer" }));
    const replyInput = screen.getByRole("textbox", {
      name: "Reply in this thread…",
    }) as HTMLTextAreaElement;
    expect(replyInput.value).toBe("Inspect turn footer");

    // Clicking the recommended prompt row sends it directly
    fireEvent.click(
      screen.getByRole("button", { name: "Send prompt: Make Paseo require a prompt" }),
    );
    await waitFor(() =>
      expect(sendAgentMessage).toHaveBeenCalledWith(
        "agent-1",
        "Make Paseo require a prompt",
        expect.objectContaining({ messageId: expect.any(String) }),
      ),
    );
  });

  it("keeps the bottom-right chat open on Option+Click to reference a new element and lets you choose discussion vs New branch", async () => {
    sendAgentMessage.mockClear();
    const getBranches = vi.fn().mockResolvedValue({
      loadedChannel: "prod",
      loadedDigest: digest,
      safeRenderer: false,
      main: {
        slug: "main",
        channel: "prod",
        branch: "feat/editable-paseo-desktop",
        isMain: true,
        status: "ready",
        summary: "Main",
        releaseDigest: digest,
        generation: 13,
        sourceSha: "1".repeat(40),
        behindMain: false,
        canFastForward: false,
        requiresDaemon: false,
        hasUpdate: false,
        loaded: true,
        remoteOnly: false,
        agentId: null,
        error: null,
        updatedAt: "2026-11-25T10:00:00.000Z",
      },
      branches: [
        {
          slug: "prompt-discussion",
          channel: "wip-prompt-discussion",
          branch: "ed/wip/prompt-discussion",
          isMain: false,
          status: "idle",
          summary: "Check response metadata",
          releaseDigest: null,
          generation: null,
          sourceSha: "1".repeat(40),
          hasChanges: false,
          behindMain: false,
          canFastForward: false,
          requiresDaemon: false,
          hasUpdate: false,
          loaded: false,
          remoteOnly: false,
          agentId: "agent-1",
          error: null,
          updatedAt: "2026-11-25T10:01:00.000Z",
        },
      ],
    });
    const bridge = {
      getStatus: vi.fn().mockResolvedValue(status),
      reportHealthy: vi.fn().mockResolvedValue(undefined),
      getBranches,
      loadBranch: vi.fn().mockResolvedValue({ ok: true }),
    } satisfies Partial<EditableDesktopBridge>;
    window.paseoDesktop = { editable: bridge as unknown as EditableDesktopBridge };
    const { target } = setup();

    // Open the bottom-right chat for prompt-discussion
    fireEvent.click(screen.getByRole("button", { name: "Editable Paseo status" }));
    fireEvent.click(await screen.findByRole("button", { name: "Chat" }));
    expect(await screen.findByRole("dialog", { name: "prompt-discussion" })).toBeTruthy();

    // Option+Click an element while staying in the chat: chat stays open and attaches the element chip
    fireEvent.keyDown(window, { key: "Alt", code: "AltLeft", altKey: true });
    fireEvent.pointerDown(target, { button: 0, altKey: true });
    fireEvent.click(target, { altKey: true });

    expect(screen.getByRole("dialog", { name: "prompt-discussion" })).toBeTruthy();
    expect(await screen.findByText("WorkspaceHeader · Header.tsx:42")).toBeTruthy();
    expect(screen.getByRole("button", { name: "prompt-discussion" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New branch" })).toBeTruthy();

    // Default target continues the open discussion with the referenced element context
    const replyInput = screen.getByRole("textbox", { name: "Reply in this thread…" });
    fireEvent.change(replyInput, { target: { value: "Look at this rendered element." } });
    fireEvent.keyDown(replyInput, { key: "Enter", code: "Enter" });
    await waitFor(() => expect(sendAgentMessage).toHaveBeenCalledTimes(1));
    const sentText = sendAgentMessage.mock.calls[0]?.[1] as string;
    expect(sentText).toContain("Follow-up referencing a new UI element in the running app:");
    expect(sentText).toContain('"componentName": "WorkspaceHeader"');
    expect(sentText).toContain("Look at this rendered element.");

    // Referencing again and choosing "New branch" routes via workshop.send as a new branch
    fireEvent.keyDown(window, { key: "Alt", code: "AltLeft", altKey: true });
    fireEvent.click(target, { altKey: true });
    expect(
      await screen.findByRole("button", {
        name: "Remove referenced element: WorkspaceHeader · Header.tsx:42",
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "New branch" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Reply in this thread…" }), {
      target: { value: "Start separate branch for this" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[1]).toBe("Start separate branch for this");
    expect(send.mock.calls[0]?.[3]).toMatchObject({ isFollowUp: false });
  });

  it("offers existing discussions in the element popover target picker even while on main", async () => {
    const getBranches = vi.fn().mockResolvedValue({
      loadedChannel: "prod",
      loadedDigest: digest,
      safeRenderer: false,
      main: {
        slug: "main",
        channel: "prod",
        branch: "feat/editable-paseo-desktop",
        isMain: true,
        status: "ready",
        summary: "Main",
        releaseDigest: digest,
        generation: 13,
        sourceSha: "1".repeat(40),
        behindMain: false,
        canFastForward: false,
        requiresDaemon: false,
        hasUpdate: false,
        loaded: true,
        remoteOnly: false,
        agentId: null,
        error: null,
        updatedAt: "2026-11-25T10:00:00.000Z",
      },
      branches: [
        {
          slug: "prompt-discussion",
          channel: "wip-prompt-discussion",
          branch: "ed/wip/prompt-discussion",
          isMain: false,
          status: "idle",
          summary: "Check response metadata",
          releaseDigest: null,
          generation: null,
          sourceSha: "1".repeat(40),
          hasChanges: false,
          behindMain: false,
          canFastForward: false,
          requiresDaemon: false,
          hasUpdate: false,
          loaded: false,
          remoteOnly: false,
          agentId: "agent-1",
          error: null,
          updatedAt: "2026-11-25T10:01:00.000Z",
        },
      ],
    });
    const bridge = {
      getStatus: vi.fn().mockResolvedValue(status),
      reportHealthy: vi.fn().mockResolvedValue(undefined),
      getBranches,
    } satisfies Partial<EditableDesktopBridge>;
    window.paseoDesktop = { editable: bridge as unknown as EditableDesktopBridge };
    const { target, shortcut } = setup();
    await waitFor(() => expect(getBranches).toHaveBeenCalled());

    shortcut();
    fireEvent.click(target);
    fireEvent.click(await screen.findByRole("button", { name: "prompt-discussion" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Ask or edit this component…" }), {
      target: { value: "Continue here with this element" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    expect(send.mock.calls[0]?.[3]).toMatchObject({
      slug: "prompt-discussion",
      isFollowUp: true,
    });
  });

  it("shows service badges with tooltips, enables Load with running-daemon warning on staged daemon branches, and handles unstaged daemon branches", async () => {
    const loadBranch = vi
      .fn()
      .mockResolvedValue({ ok: true, uiChanged: false, daemonSwapped: true });
    const shipBranch = vi
      .fn()
      .mockResolvedValue({ ok: true, fastForwarded: false, autoLoaded: false });
    const daemonDigest = "d".repeat(64);
    const getBranches = vi.fn().mockResolvedValue({
      loadedChannel: "prod",
      loadedDigest: digest,
      loadedDaemonDigest: null,
      daemonRunning: true,
      daemonListen: "127.0.0.1:6770",
      mainDaemonGeneration: null,
      safeRenderer: false,
      main: {
        slug: "main",
        channel: "prod",
        branch: "feat/editable-paseo-desktop",
        isMain: true,
        status: "ready",
        summary: "Main",
        releaseDigest: digest,
        daemonReleaseDigest: null,
        services: ["ui"],
        generation: 15,
        sourceSha: "1".repeat(40),
        behindMain: false,
        canFastForward: false,
        requiresDaemon: false,
        hasUpdate: false,
        hasUiUpdate: false,
        hasDaemonUpdate: false,
        requiresDaemonRestartOnLoad: false,
        loaded: true,
        remoteOnly: false,
        agentId: null,
        error: null,
        updatedAt: "2026-11-26T10:00:00.000Z",
      },
      branches: [
        {
          slug: "daemon-staged-ready",
          channel: "wip-daemon-staged-ready",
          branch: "ed/wip/daemon-staged-ready",
          isMain: false,
          status: "ready",
          summary: "Enable Antigravity response metadata",
          releaseDigest: null,
          daemonReleaseDigest: daemonDigest,
          services: ["daemon"],
          generation: 1,
          sourceSha: "2".repeat(40),
          hasChanges: true,
          behindMain: true,
          canFastForward: false,
          requiresDaemon: true,
          hasUpdate: false,
          hasUiUpdate: false,
          hasDaemonUpdate: false,
          requiresDaemonRestartOnLoad: true,
          loaded: false,
          remoteOnly: false,
          agentId: "agent-1",
          error: null,
          updatedAt: "2026-11-26T10:01:00.000Z",
        },
        {
          slug: "unstaged-draft",
          channel: "wip-unstaged-draft",
          branch: "ed/wip/unstaged-draft",
          isMain: false,
          status: "draft",
          summary: "Work in progress",
          releaseDigest: null,
          daemonReleaseDigest: null,
          services: ["ui"],
          generation: null,
          sourceSha: "3".repeat(40),
          hasChanges: true,
          behindMain: false,
          canFastForward: false,
          requiresDaemon: false,
          hasUpdate: false,
          hasUiUpdate: false,
          hasDaemonUpdate: false,
          requiresDaemonRestartOnLoad: false,
          loaded: false,
          remoteOnly: false,
          agentId: "agent-2",
          error: null,
          updatedAt: "2026-11-26T10:02:00.000Z",
        },
      ],
    });
    const bridge = {
      getStatus: vi.fn().mockResolvedValue(status),
      reportHealthy: vi.fn().mockResolvedValue(undefined),
      getBranches,
      loadBranch,
      shipBranch,
    } satisfies Partial<EditableDesktopBridge>;
    window.paseoDesktop = { editable: bridge as unknown as EditableDesktopBridge };
    setup();

    fireEvent.click(screen.getByRole("button", { name: "Editable Paseo status" }));
    expect(await screen.findByText("daemon-staged-ready")).toBeTruthy();

    // Staged daemon-only branch shows Load WITH amber warning icon + tooltip because :6770 is running
    const loadBtn = screen.getByRole("button", { name: "Load" });
    expect(document.querySelectorAll('[data-ed-daemon-restart-warn="true"]')).toHaveLength(1);
    fireEvent.mouseEnter(loadBtn.parentElement!);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Will restart the running dev daemon (:6770)",
    );
    fireEvent.mouseLeave(loadBtn.parentElement!);
    fireEvent.click(loadBtn);
    await waitFor(() => expect(loadBranch).toHaveBeenCalledWith("wip-daemon-staged-ready"));

    // Ship button shows update icon + tooltip for behind-main daemon branch
    expect(document.querySelectorAll('[data-ed-ship-update="true"]')).toHaveLength(1);
    const daemonShipBtn = screen.getByRole("button", { name: "Ship" });
    fireEvent.mouseEnter(daemonShipBtn.parentElement!);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "Updates with latest main, rebuilds the daemon in the background",
    );
    fireEvent.mouseLeave(daemonShipBtn.parentElement!);
    fireEvent.click(daemonShipBtn);
    await waitFor(() => expect(shipBranch).toHaveBeenCalledWith("daemon-staged-ready"));

    // Hovering Daemon service badge & Draft badge shows explanatory tooltips
    const daemonBadge = screen.getByText("Daemon");
    fireEvent.mouseEnter(daemonBadge);
    expect(screen.getByRole("tooltip").textContent).toContain(
      "hot-swaps the local dev daemon (:6770)",
    );
    fireEvent.mouseLeave(daemonBadge);

    const draftBadge = screen.getByText("Draft");
    fireEvent.mouseEnter(draftBadge);
    expect(screen.getByRole("tooltip").textContent).toContain("uncommitted or unstaged edits");
  });

  it("displays chat title, feature summary + latest turn separately, and production-only diff stat with hover drilldown", async () => {
    render(
      <EditableStatusPill
        bridge={undefined}
        status={status}
        workshopDaemon={null}
        branches={titleDiffBranchesFixture}
        workshop={titleDiffWorkshopFixture}
        onPick={noopPick}
        layer={100}
      />,
    );

    // Bottom-right pill shows the chat title instead of raw slug
    expect(screen.getByRole("status").textContent).toBe("PR Link Icons");

    fireEvent.click(screen.getByRole("button", { name: "Editable Paseo status" }));
    expect(screen.getByText("🔗 PR Link Icons")).toBeTruthy();
    expect(screen.getByText("Render PR links with status icons in markdown tables.")).toBeTruthy();
    expect(screen.getByText("Aligned the PR icon vertically and restaged the UI.")).toBeTruthy();

    // Inline diff badge shows ONLY production changes (+18 -4), NOT total (+48 -7)
    const diffBadge = document.querySelector('[data-ed-diff-stat="true"]') as HTMLElement;
    expect(diffBadge).toBeTruthy();
    expect(diffBadge.textContent).toBe("+18-4");

    // Hovering opens the Paseo category drilldown showing Total, Production, and subcategories
    fireEvent.mouseEnter(diffBadge);
    const drilldown = document.querySelector('[data-ed-diff-drilldown="true"]') as HTMLElement;
    expect(drilldown).toBeTruthy();
    expect(drilldown.textContent).toContain("Total");
    expect(drilldown.textContent).toContain("+48-7");
    expect(drilldown.textContent).toContain("Production");
    expect(drilldown.textContent).toContain("+18-4");
    expect(drilldown.textContent).toContain("Code · JS/TS");
    expect(drilldown.textContent).toContain("Components · JSX/TSX");
    expect(drilldown.textContent).toContain("Tests");
    expect(drilldown.textContent).toContain("Docs");
    fireEvent.mouseLeave(diffBadge);
    expect(document.querySelector('[data-ed-diff-drilldown="true"]')).toBeNull();
  });
});
