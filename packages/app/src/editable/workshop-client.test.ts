import { expect, it, vi } from "vitest";
import { buildWorkshopPrompt, DEFAULT_WORKSHOP_CWD, sendWorkshopEdit } from "./workshop-client";
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
    createAgent: vi.fn().mockResolvedValue({ id: "workshop-agent" }),
    fetchAgent: vi.fn(),
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
    sendAgentMessage: vi.fn(),
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
      '  3. Run `paseo-ed stage <slug> --summary "<short summary>" --upload` to commit on the WIP branch, build the signed Electron preview, and publish to Cloud Shelf. Do NOT merge to main or run `paseo-ed ship` — the user will click Ship when ready.',
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
    title: "Editable Paseo Workshop",
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
    title: "Editable Paseo Workshop",
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
    title: "Editable: compact-sidebar",
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
    title: "Editable Paseo Workshop",
  });
});

it("spawns the Workshop agent directly inside a pre-created worktree path when provided", async () => {
  const { client, input } = fixture();
  const worktreePath = "/Users/tester/.editable-paseo/worktrees/inbox-headers";
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
  expect(client.getDirectorySuggestions).not.toHaveBeenCalled();
  expect(client.createAgent).toHaveBeenCalledExactlyOnceWith({
    cwd: worktreePath,
    modeId: "auto-review",
    provider: "codex",
    title: "Editable: inbox-headers",
  });
  expect(client.sendAgentMessage.mock.calls[0]?.[1]).toContain(
    "working inside isolated WIP worktree `inbox-headers`",
  );
  expect(client.sendAgentMessage.mock.calls[0]?.[1]).toContain("Do NOT modify files");
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
    title: "Editable Paseo Workshop",
  });
});
