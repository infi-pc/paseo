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

const { isReady, send } = vi.hoisted(() => ({
  isReady: vi.fn(() => true),
  send: vi.fn().mockResolvedValue({ kind: "sent", agentId: "agent-1" }),
}));
vi.mock("expo-router", () => {
  const navigation = { isReady };
  return { usePathname: () => "/workspaces", useNavigationContainerRef: () => navigation };
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
  useWorkshop: () => ({
    config: { enabled: true },
    hosts: [{ serverId: "workshop", label: "Workshop" }],
    host: { serverId: "workshop", label: "Workshop" },
    saving: false,
    sending: false,
    editing: false,
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
  send.mockClear();
  vi.useRealTimers();
});

describe("Editable overlay", () => {
  it("uses a unique chord and toggles pick mode without desktop preload", () => {
    expect(
      DEFAULT_BINDINGS.filter(({ combo }) => combo === "Alt+Shift+F8").map(({ action }) => action),
    ).toEqual(["editable.pick"]);
    const { shortcut } = setup();
    shortcut();
    expect(screen.getByRole("status").textContent).toBe(
      "Click a component to edit it. Esc to cancel.",
    );
    shortcut();
    expect(screen.queryByRole("status")).toBeNull();
    shortcut();
    fireEvent.keyDown(window, { key: "Escape", code: "Escape" });
    expect(screen.queryByRole("status")).toBeNull();
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
    const label = "Edit this component…";
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
    );
  });

  it("preserves the prompt and reopens it when the Workshop host is offline", async () => {
    send.mockResolvedValueOnce({ kind: "offline" });
    const { target, shortcut } = setup();
    shortcut();
    fireEvent.click(target);
    fireEvent.change(screen.getByRole("textbox", { name: "Edit this component…" }), {
      target: { value: "Keep this draft." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe(
      "The Workshop host is offline. Reconnect it or choose another host.",
    );
    expect(
      (screen.getByRole("textbox", { name: "Edit this component…" }) as HTMLInputElement).value,
    ).toBe("Keep this draft.");
  });

  it("includes the underlying error detail when sending throws", async () => {
    send.mockRejectedValueOnce(
      new Error("Workshop directory not found on host: ~/.editable-paseo/repo"),
    );
    const { target, shortcut } = setup();
    shortcut();
    fireEvent.click(target);
    fireEvent.change(screen.getByRole("textbox", { name: "Edit this component…" }), {
      target: { value: "Keep this draft too." },
    });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    const error = await screen.findByRole("alert");
    expect(error.textContent).toBe(
      "Could not send the edit. Check the Workshop host and repository path, then try again. (Workshop directory not found on host: ~/.editable-paseo/repo)",
    );
    expect(
      (screen.getByRole("textbox", { name: "Edit this component…" }) as HTMLInputElement).value,
    ).toBe("Keep this draft too.");
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
