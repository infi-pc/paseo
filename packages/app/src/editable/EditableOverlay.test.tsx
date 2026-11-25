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
import type { EditableDesktopBridge, EditableDesktopStatus } from "./types";

const { isReady, push, send, startWorkshop } = vi.hoisted(() => ({
  isReady: vi.fn(() => true),
  push: vi.fn(),
  send: vi.fn().mockResolvedValue({ kind: "sent", agentId: "agent-1" }),
  startWorkshop: vi.fn().mockResolvedValue({ serverId: "workshop", repoDir: "/repo" }),
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
    useTranslation: () => ({
      t: (key: string) => en.editable[key.split(".")[1] as keyof typeof en.editable],
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

  it("intercepts a component click, closes on Escape and submits an edit from Enter", async () => {
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
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
      { isFollowUp: false },
    );
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
    expect(popover.textContent).toContain("+ daemon");
    expect(popover.textContent).toContain("behind main");
    expect(popover.textContent).toContain("Fallback UI");

    // Only the 2 branches with changes offer Load / Ship / Update to main; question-only only offers Chat + discard
    expect(screen.getAllByRole("button", { name: "Load" })).toHaveLength(2);
    expect(screen.getAllByRole("button", { name: "Chat" })).toHaveLength(3);

    // Fast-forward branch has "Ship"; behind-main branch has "Update to main"
    fireEvent.click(screen.getByRole("button", { name: "Ship" }));
    await waitFor(() => expect(shipBranch).toHaveBeenCalledWith("fast-branch"));
    fireEvent.click(screen.getByRole("button", { name: "Update to main" }));
    await waitFor(() => expect(shipBranch).toHaveBeenCalledWith("behind-branch"));

    fireEvent.click(screen.getAllByRole("button", { name: "Load" })[0]!);
    await waitFor(() => expect(loadBranch).toHaveBeenCalledWith("wip-fast-branch"));

    fireEvent.click(screen.getAllByRole("button", { name: "Chat" })[0]!);
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
    expect(send.mock.calls[0]?.[3]).toEqual({ isFollowUp: false });
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
});
