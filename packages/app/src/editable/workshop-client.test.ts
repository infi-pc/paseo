import { expect, it, vi } from "vitest";
import {
  buildWorkshopFollowUpPrompt,
  buildWorkshopPrompt,
  DEFAULT_WORKSHOP_CWD,
  sendWorkshopEdit,
} from "./workshop-client";
import type { EditableLocatorContext } from "./types";

const locator: EditableLocatorContext = {
  file: "packages/app/src/Header.tsx",
  line: 42,
  column: 5,
  componentName: "WorkspaceHeader",
  route: "/workspaces?token=secret",
  releaseDigest: "a".repeat(64),
  platform: "web",
};
const request = "  Use a smaller label.  ";

function fixture() {
  const client = {
    addProject: vi.fn().mockResolvedValue({
      project: { projectId: "workshop-project", projectDisplayName: "repo" },
    }),
    createAgent: vi.fn().mockResolvedValue({ id: "workshop-agent" }),
    createWorkspace: vi.fn().mockResolvedValue({ workspace: { id: "branch-workspace" } }),
    fetchAgent: vi.fn(),
    fetchWorkspaces: vi.fn().mockResolvedValue({ entries: [], pageInfo: { nextCursor: null } }),
    getDirectorySuggestions: vi.fn().mockResolvedValue({
      directories: ["/Users/tester/.editable-paseo/repo"],
      entries: [{ path: "/Users/tester/.editable-paseo/repo", kind: "directory" }],
      error: null,
      requestId: "req-1",
    }),
    listAvailableProviders: vi.fn().mockResolvedValue({
      providers: [
        { provider: "claude", available: true },
        { provider: "codex", available: true },
      ],
    }),
    renameProject: vi.fn(),
    sendAgentMessage: vi.fn(),
    updateAgent: vi.fn().mockResolvedValue(undefined),
  };
  return {
    client,
    input: {
      target: { workshopHostId: "workshop", workshopCwd: null, workshopAgentId: null },
      locator,
      request,
      getClient: vi.fn().mockReturnValue(client),
      rememberAgent: vi.fn(),
    },
  };
}

it("builds the Workshop prompt with intent-first instructions and no query or extra metadata", () => {
  const locatorWithExtra = { ...locator, innerText: "private conversation", password: "secret" };
  expect(buildWorkshopPrompt(locatorWithExtra, request)).toBe(
    [
      "You are the Editable Paseo Workshop assistant in the dedicated Editable Paseo repository.",
      "Use the `paseo-ed` CLI (`~/.local/bin/paseo-ed` if not on PATH). If you need to make code changes, first run `paseo-ed wip create <slug>` and edit inside that worktree.",
      "Respond based on what the user is actually asking:",
      '- If the user is asking a question, brainstorming, seeking your opinion, or exploring (for example "what do you think?", "why does…?", "how does…?", "could we…?"): ONLY inspect the code and answer concisely. Do NOT modify files, commit, or run `paseo-ed stage` until the user explicitly asks to implement a change.',
      "- Only when the user asks you to make or change something (now or in a later turn of this chat):",
      "  1. Make the edit inside that worktree.",
      "  2. Run `paseo-ed verify <slug>` to check typecheck and lint.",
      '  3. Run `paseo-ed stage <slug> --summary "<short 1-sentence feature summary>" --upload` to commit on the WIP branch, build the signed UI and/or Daemon release(s), and publish to Cloud Shelf so the user can hot-swap them live in Paseo Dev.app. Write --summary as a clear 1-sentence description of what this feature/change does as a whole (not a verbatim copy of the user\'s raw prompt, and distinct from your turn-by-turn <paseo-meta message="..." /> update). Do NOT merge to main or run `paseo-ed ship` — the user will click Ship when ready.',
      "- To live-inspect the running Paseo Dev.app (screenshots, DOM, React props/hooks, matched CSS, console logs, network, perf/APM, or stores), run `paseo-ed app --help`.",
      "",
      "Locator context:",
      JSON.stringify({ ...locator, route: "/workspaces" }, null, 2),
      "",
      "User message:",
      "Use a smaller label.",
    ].join("\n"),
  );
});

it("asks for a paired Workshop host before looking for a client", async () => {
  const { input } = fixture();
  expect(
    await sendWorkshopEdit({ ...input, target: { ...input.target, workshopHostId: null } }),
  ).toEqual({ kind: "choose-host" });
  expect(input.getClient).not.toHaveBeenCalled();
});

it("expands the default tilde repo path on the configured host before creating the agent", async () => {
  const { client, input } = fixture();
  expect(await sendWorkshopEdit(input)).toEqual({
    kind: "sent",
    agentId: "workshop-agent",
    slug: "use-a-smaller-label",
  });
  expect(input.getClient).toHaveBeenCalledExactlyOnceWith("workshop");
  expect(client.getDirectorySuggestions).toHaveBeenCalledExactlyOnceWith({
    query: DEFAULT_WORKSHOP_CWD,
    includeDirectories: true,
    includeFiles: false,
    limit: 1,
  });
  expect(client.createAgent).toHaveBeenCalledExactlyOnceWith({
    cwd: "/Users/tester/.editable-paseo/repo",
    modeId: "auto-review",
    provider: "codex",
    title: "Use a smaller label.",
  });
  expect(client.updateAgent).toHaveBeenCalledExactlyOnceWith("workshop-agent", {
    namingMode: "automatic",
  });
  expect(input.rememberAgent).toHaveBeenCalledExactlyOnceWith(
    "workshop-agent",
    "use-a-smaller-label",
  );
  expect(client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith(
    "workshop-agent",
    buildWorkshopPrompt(locator, request),
  );
});

it("passes absolute Workshop paths directly without directory lookup", async () => {
  const { client, input } = fixture();
  const target = { ...input.target, workshopCwd: "/srv/paseo-editable/repo" };
  expect(await sendWorkshopEdit({ ...input, target })).toEqual({
    kind: "sent",
    agentId: "workshop-agent",
    slug: "use-a-smaller-label",
  });
  expect(client.getDirectorySuggestions).not.toHaveBeenCalled();
  expect(client.createAgent).toHaveBeenCalledExactlyOnceWith({
    cwd: "/srv/paseo-editable/repo",
    modeId: "auto-review",
    provider: "codex",
    title: "Use a smaller label.",
  });
});

it("rejects when a tilde Workshop directory does not exist on the host", async () => {
  const { client, input } = fixture();
  client.getDirectorySuggestions.mockResolvedValueOnce({
    directories: ["/Users/tester/unrelated/repo"],
    entries: [{ path: "/Users/tester/unrelated/repo", kind: "directory" }],
    error: null,
    requestId: "req-2",
  });
  await expect(sendWorkshopEdit(input)).rejects.toThrow(
    `Workshop directory not found on host: ${DEFAULT_WORKSHOP_CWD}`,
  );
  expect(client.createAgent).not.toHaveBeenCalled();
});

it("reuses the configured agent on its own host and reports disconnection", async () => {
  const { client, input } = fixture();
  client.fetchAgent.mockResolvedValue({ agent: { id: "saved-agent", status: "idle" } });
  const target = { ...input.target, workshopAgentId: "saved-agent" };
  expect(await sendWorkshopEdit({ ...input, target })).toEqual({
    kind: "sent",
    agentId: "saved-agent",
    slug: "use-a-smaller-label",
  });
  expect(client.createAgent).not.toHaveBeenCalled();
  expect(client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith(
    "saved-agent",
    buildWorkshopPrompt(locator, request),
  );
  input.getClient.mockReturnValue(null);
  expect(await sendWorkshopEdit({ ...input, target })).toEqual({ kind: "offline" });
});

it("spawns a parallel agent when isFollowUp is false even if an earlier agent exists", async () => {
  const { client, input } = fixture();
  const target = { ...input.target, workshopAgentId: "existing-agent" };
  expect(
    await sendWorkshopEdit({ ...input, target, slug: "compact-sidebar", isFollowUp: false }),
  ).toEqual({
    kind: "sent",
    agentId: "workshop-agent",
    slug: "compact-sidebar",
  });
  expect(client.createAgent).toHaveBeenCalledExactlyOnceWith({
    cwd: "/Users/tester/.editable-paseo/repo",
    modeId: "auto-review",
    provider: "codex",
    title: "Use a smaller label.",
  });
  expect(client.updateAgent).toHaveBeenCalledExactlyOnceWith("workshop-agent", {
    namingMode: "automatic",
  });
});

it("falls back to auto mode from provider snapshot when auto-review is unavailable", async () => {
  const { client, input } = fixture();
  const getProvidersSnapshot = vi.fn().mockResolvedValue({
    entries: [
      {
        provider: "codex",
        status: "ready",
        defaultModeId: "auto",
        modes: [
          { id: "auto", label: "Default Permissions" },
          { id: "full-access", label: "Full Access" },
        ],
      },
    ],
  });
  input.getClient.mockReturnValue({ ...client, getProvidersSnapshot });
  await sendWorkshopEdit(input);
  expect(client.createAgent).toHaveBeenCalledExactlyOnceWith({
    cwd: "/Users/tester/.editable-paseo/repo",
    modeId: "auto",
    provider: "codex",
    title: "Use a smaller label.",
  });
});

it("places separate branch worktrees under the same Workshop project", async () => {
  const { client, input } = fixture();
  const worktreePath = "/Users/tester/.editable-paseo/worktrees/inbox-headers";
  const secondPath = "/Users/tester/.editable-paseo/worktrees/sidebar-layout";
  expect(
    await sendWorkshopEdit({
      ...input,
      slug: "inbox-headers",
      isFollowUp: false,
      worktreePath,
    }),
  ).toEqual({
    kind: "sent",
    agentId: "workshop-agent",
    slug: "inbox-headers",
  });
  expect(client.addProject).toHaveBeenCalledExactlyOnceWith("/Users/tester/.editable-paseo/repo");
  expect(client.renameProject).toHaveBeenCalledExactlyOnceWith(
    "workshop-project",
    "Editable Workshop",
  );
  expect(client.createWorkspace).toHaveBeenCalledExactlyOnceWith({
    source: { kind: "directory", path: worktreePath, projectId: "workshop-project" },
  });
  expect(client.createAgent).toHaveBeenCalledExactlyOnceWith({
    cwd: worktreePath,
    modeId: "auto-review",
    provider: "codex",
    title: "Use a smaller label.",
    workspaceId: "branch-workspace",
  });
  expect(client.sendAgentMessage.mock.calls[0]?.[1]).toContain(
    "working inside isolated WIP worktree `inbox-headers`",
  );
  expect(client.sendAgentMessage.mock.calls[0]?.[1]).toContain("Do NOT modify files");

  client.addProject.mockResolvedValueOnce({
    project: {
      projectId: "workshop-project",
      projectDisplayName: "My Workshop",
      projectCustomName: "My Workshop",
    },
  });
  client.fetchWorkspaces.mockResolvedValueOnce({
    entries: [{ id: "branch-workspace", workspaceDirectory: worktreePath }],
    pageInfo: { nextCursor: null },
  });
  client.createWorkspace.mockResolvedValueOnce({ workspace: { id: "second-workspace" } });
  await sendWorkshopEdit({ ...input, slug: "sidebar-layout", worktreePath: secondPath });
  expect(client.addProject).toHaveBeenNthCalledWith(2, "/Users/tester/.editable-paseo/repo");
  expect(client.renameProject).toHaveBeenCalledTimes(1);
  expect(client.createWorkspace).toHaveBeenNthCalledWith(2, {
    source: { kind: "directory", path: secondPath, projectId: "workshop-project" },
  });
  expect(client.createAgent).toHaveBeenLastCalledWith(
    expect.objectContaining({ cwd: secondPath, workspaceId: "second-workspace" }),
  );
});

it("reuses a registered branch workspace when an agent needs to be recreated", async () => {
  const { client, input } = fixture();
  const worktreePath = "/Users/tester/.editable-paseo/worktrees/inbox-headers";
  client.fetchWorkspaces.mockResolvedValueOnce({
    entries: [{ id: "existing-workspace", workspaceDirectory: worktreePath }],
    pageInfo: { nextCursor: null },
  });

  await sendWorkshopEdit({ ...input, slug: "inbox-headers", worktreePath });

  expect(client.createWorkspace).not.toHaveBeenCalled();
  expect(client.createAgent).toHaveBeenCalledWith(
    expect.objectContaining({ cwd: worktreePath, workspaceId: "existing-workspace" }),
  );
});

it("attaches element snapshot JSON and screenshot images when provided", async () => {
  const { client, input } = fixture();
  const snapshot = {
    react: [{ name: "InboxHeader", source: null, props: { collapsible: true }, hooks: [true] }],
    dom: {
      tag: "button",
      role: "button",
      rect: { x: 10, y: 20, width: 120, height: 32 },
      overflow: {
        horizontal: false,
        vertical: false,
        scrollWidth: 120,
        clientWidth: 120,
        scrollHeight: 32,
        clientHeight: 32,
      },
      styles: { display: "flex" },
      text: "Inbox",
      ancestors: [],
      children: [],
    },
    viewport: { width: 1280, height: 800, dpr: 2, scrollX: 0, scrollY: 0 },
    theme: "dark",
    density: "comfortable",
  };
  const images = [{ data: "iVBORw0KGgo=", mimeType: "image/png" as const }];
  await sendWorkshopEdit({ ...input, snapshot, images });
  expect(client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith(
    "workshop-agent",
    expect.stringContaining("Element snapshot:"),
    { images },
  );
  expect(client.sendAgentMessage.mock.calls[0]?.[1]).toContain('"collapsible":true');
});

it("uses auto mode when falling back to Claude", async () => {
  const { client, input } = fixture();
  client.listAvailableProviders.mockResolvedValueOnce({
    providers: [{ provider: "claude", available: true }],
  });
  await sendWorkshopEdit(input);
  expect(client.createAgent).toHaveBeenCalledExactlyOnceWith({
    cwd: "/Users/tester/.editable-paseo/repo",
    modeId: "auto",
    provider: "claude",
    title: "Use a smaller label.",
  });
});

it("formats compact follow-up prompts with one or more referenced elements", () => {
  const secondLocator: EditableLocatorContext = {
    file: "packages/app/src/agent-stream/recommended-prompts.tsx",
    line: 95,
    column: 7,
    componentName: "PressHighlight",
    route: "/h/local/agent/123?secret=1",
    releaseDigest: null,
    platform: "electron",
  };
  const prompt = buildWorkshopFollowUpPrompt("Look at both of these.", [
    { locator },
    { locator: secondLocator },
  ]);
  expect(prompt).toContain("Follow-up referencing 2 UI elements in the running app:");
  expect(prompt).toContain('"componentName": "WorkspaceHeader"');
  expect(prompt).toContain('"componentName": "PressHighlight"');
  expect(prompt).not.toContain("secret=1");
  expect(prompt).not.toContain("You are the Editable Paseo Workshop assistant");
  expect(prompt.endsWith("User message:\nLook at both of these.")).toBe(true);
});

it("sends a compact follow-up prompt when continuing an existing branch discussion", async () => {
  const { client, input } = fixture();
  client.fetchAgent.mockResolvedValue({ agent: { id: "saved-agent", status: "idle" } });
  const target = { ...input.target, workshopAgentId: "saved-agent" };
  const images = [{ data: "iVBORw0KGgo=", mimeType: "image/png" as const }];
  expect(
    await sendWorkshopEdit({
      ...input,
      target,
      slug: "existing-discussion",
      isFollowUp: true,
      images,
    }),
  ).toEqual({
    kind: "sent",
    agentId: "saved-agent",
    slug: "existing-discussion",
  });
  expect(client.createAgent).not.toHaveBeenCalled();
  const sentPrompt = client.sendAgentMessage.mock.calls[0]?.[1] as string;
  expect(sentPrompt).toContain("Follow-up referencing a new UI element in the running app:");
  expect(sentPrompt).not.toContain("You are the Editable Paseo Workshop assistant");
  expect(client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith("saved-agent", sentPrompt, {
    images,
  });
});
