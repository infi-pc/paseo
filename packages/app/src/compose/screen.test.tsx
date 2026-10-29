/** @vitest-environment jsdom */
import React, { StrictMode } from "react";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { useSessionStore, type WorkspaceDescriptor } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useDraftStore } from "@/stores/draft-store";
import { ComposeScreen } from "./screen";

const integration = vi.hoisted(() => ({
  params: {
    cwd: "/repo-feature",
    file: "/repo-feature/src/Button.tsx",
    line: "42",
    column: "7",
    requestId: "click-1",
  },
  refresh: vi.fn(async () => undefined),
  fetchAgent: vi.fn(async (_input: { agentId: string }) => ({ agent: { workspaceId: "feature" } })),
  navigate: vi.fn(),
  back: vi.fn(),
  storage: new Map<string, string>(),
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: async (key: string) => integration.storage.get(key) ?? null,
    setItem: async (key: string, value: string) => {
      integration.storage.set(key, value);
    },
    removeItem: async (key: string) => {
      integration.storage.delete(key);
    },
  },
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => integration.params,
  router: { replace: integration.back },
}));
vi.mock("@/hooks/use-is-local-daemon", () => ({
  useLocalDaemonServerIdState: () => ({ status: "resolved", serverId: "host" }),
}));
vi.mock("@/hooks/use-directory-demand", () => ({ useDirectoryDemand: () => undefined }));
vi.mock("@/runtime/host-runtime", () => ({
  useHosts: () => [{ serverId: "host" }],
  useHostRuntimeSnapshot: () => ({
    connectionStatus: "online",
    client: { fetchAgent: integration.fetchAgent },
  }),
  getHostRuntimeStore: () => ({
    refreshWorkspaceDirectory: integration.refresh,
    runProbeCycleNow: async () => undefined,
  }),
}));
vi.mock("@/stores/navigation-active-workspace-store", () => ({
  navigateToWorkspace: integration.navigate,
}));
vi.mock("@/attachments/service", () => ({ garbageCollectAttachments: async () => undefined }));

function workspace(id: string, workspaceDirectory: string): WorkspaceDescriptor {
  return {
    id,
    workspaceDirectory,
    createdAt: null,
    lastUserMessageAt: null,
    projectId: "project",
    projectDisplayName: "Project",
    projectRootPath: "/repo",
    projectKind: "git",
    workspaceKind: "checkout",
    name: id,
    status: "running",
    archivingAt: null,
    statusEnteredAt: null,
    diffStat: null,
    scripts: [],
  };
}
function screenTree(queryClient: QueryClient) {
  return (
    <StrictMode>
      <I18nextProvider i18n={i18n}>
        <QueryClientProvider client={queryClient}>
          <ComposeScreen />
        </QueryClientProvider>
      </I18nextProvider>
    </StrictMode>
  );
}
function mount() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(screenTree(queryClient));
  return { rerender: () => view.rerender(screenTree(queryClient)) };
}

beforeEach(async () => {
  integration.storage.clear();
  integration.navigate.mockClear();
  integration.refresh.mockReset().mockResolvedValue(undefined);
  integration.fetchAgent.mockReset().mockResolvedValue({ agent: { workspaceId: "feature" } });
  integration.params.cwd = "/repo-feature";
  integration.params.requestId = "click-1";
  await useWorkspaceLayoutStore.persist.rehydrate();
  await useDraftStore.persist.rehydrate();
  useWorkspaceLayoutStore.setState({
    layoutByWorkspace: {},
    lastFocusedAgentByWorkspace: { "host:feature": "last-focused" },
  });
  useDraftStore.setState({ drafts: {}, attachmentFocusRequestByDraftKey: {} });
  useSessionStore.getState().initializeSession("host", null);
  useSessionStore.getState().setWorkspaces(
    "host",
    new Map([
      ["main", workspace("main", "/repo")],
      ["feature", workspace("feature", "/repo-feature")],
    ]),
  );
  useDraftStore.getState().saveDraftInput({
    draftKey: "agent:host:last-focused",
    draft: { text: "Existing prompt", attachments: [] },
  });
});
afterEach(cleanup);

describe("compose URL screen", () => {
  it("appends once in StrictMode to the last-focused agent of the exact worktree", async () => {
    mount();
    await waitFor(() =>
      expect(integration.navigate).toHaveBeenCalledWith({
        serverId: "host",
        workspaceId: "feature",
        target: { kind: "agent", agentId: "last-focused" },
        pin: true,
      }),
    );
    expect(integration.fetchAgent).toHaveBeenCalledWith({ agentId: "last-focused" });
    expect(useDraftStore.getState().getDraftInput("agent:host:last-focused")).toEqual({
      text: "Existing prompt\nsrc/Button.tsx:42:7",
      attachments: [],
    });
    expect(
      useDraftStore.getState().attachmentFocusRequestByDraftKey["agent:host:last-focused"],
    ).toBe(1);
  });
  it("treats a second click on the same source as a fresh append", async () => {
    const view = mount();
    await waitFor(() => expect(integration.navigate).toHaveBeenCalledTimes(1));
    integration.params.requestId = "click-2";
    view.rerender();
    await waitFor(() => expect(integration.navigate).toHaveBeenCalledTimes(2));
    expect(useDraftStore.getState().getDraftInput("agent:host:last-focused")?.text).toBe(
      "Existing prompt\nsrc/Button.tsx:42:7\nsrc/Button.tsx:42:7",
    );
  });

  it("starts a draft when the worktree has no remembered agent", async () => {
    useWorkspaceLayoutStore.setState({ lastFocusedAgentByWorkspace: {} });
    mount();
    await waitFor(() => expect(integration.navigate).toHaveBeenCalledTimes(1));
    expect(integration.navigate).toHaveBeenCalledWith({
      serverId: "host",
      workspaceId: "feature",
      target: { kind: "draft", draftId: expect.any(String) },
      pin: true,
    });
    expect(integration.fetchAgent).not.toHaveBeenCalled();
  });

  it("shows a visible disconnect failure and lets the user retry", async () => {
    integration.refresh.mockRejectedValueOnce(new Error("Host disconnected"));
    mount();
    await screen.findByText("Could not open this source location");
    expect(
      screen.getByText(
        "Check that the host is connected and the exact worktree is registered in Paseo, then retry.",
      ),
    ).toBeTruthy();
    expect(integration.navigate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(integration.navigate).toHaveBeenCalledTimes(1));
  });
  it("keeps an unmatched directory from opening another worktree", async () => {
    integration.params.cwd = "/repo-other";
    mount();
    await screen.findByText("Could not open this source location");
    expect(integration.fetchAgent).not.toHaveBeenCalled();
    expect(integration.navigate).not.toHaveBeenCalled();
    expect(useDraftStore.getState().getDraftInput("agent:host:last-focused")?.text).toBe(
      "Existing prompt",
    );
  });
  it("opens a draft if the remembered agent moved to another workspace", async () => {
    integration.fetchAgent.mockResolvedValue({ agent: { workspaceId: "main" } });
    mount();
    await waitFor(() => expect(integration.navigate).toHaveBeenCalledTimes(1));
    expect(integration.navigate).toHaveBeenCalledWith({
      serverId: "host",
      workspaceId: "feature",
      target: { kind: "draft", draftId: expect.any(String) },
      pin: true,
    });
    expect(useDraftStore.getState().getDraftInput("agent:host:last-focused")?.text).toBe(
      "Existing prompt",
    );
    const drafts = Object.entries(useDraftStore.getState().drafts).filter(([key]) =>
      key.startsWith("draft:host:"),
    );
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.[1].input.text).toBe("src/Button.tsx:42:7");
  });
});
