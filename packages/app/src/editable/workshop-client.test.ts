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

it("builds the Workshop prompt with the location and no query or extra metadata", () => {
  const locatorWithExtra = { ...locator, innerText: "private conversation", password: "secret" };
  expect(buildWorkshopPrompt(locatorWithExtra, request)).toBe(
    [
      "Edit Paseo in the dedicated Editable Paseo repository.",
      "Use the `paseo-ed` CLI (`~/.local/bin/paseo-ed` if not on PATH):",
      "1. Run `paseo-ed wip create <slug>` and edit inside that worktree.",
      "2. Run `paseo-ed verify <slug>` to check typecheck and lint.",
      '3. For UI-only edits, run `paseo-ed ship <slug> --summary "<short summary>" --upload` to land locally, build the signed Electron renderer, and publish to Cloud Shelf (pass `--push` only if explicitly requested).',
      "4. Tell the user when the signed update is ready so they can run Editable -> Sync from Cloud Shelf.",
      "",
      "Locator context:",
      JSON.stringify({ ...locator, route: "/workspaces" }, null, 2),
      "",
      "Edit request:",
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
  expect(await sendWorkshopEdit(input)).toEqual({ kind: "sent", agentId: "workshop-agent" });
  expect(input.getClient).toHaveBeenCalledExactlyOnceWith("workshop");
  expect(client.getDirectorySuggestions).toHaveBeenCalledExactlyOnceWith({
    query: DEFAULT_WORKSHOP_CWD,
    includeDirectories: true,
    includeFiles: false,
    limit: 1,
  });
  expect(client.createAgent).toHaveBeenCalledExactlyOnceWith({
    cwd: "/Users/tester/.editable-paseo/repo",
    provider: "codex",
    title: "Editable Paseo Workshop",
  });
  expect(input.rememberAgent).toHaveBeenCalledExactlyOnceWith("workshop-agent");
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
  });
  expect(client.getDirectorySuggestions).not.toHaveBeenCalled();
  expect(client.createAgent).toHaveBeenCalledExactlyOnceWith({
    cwd: "/srv/paseo-editable/repo",
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
  });
  expect(client.createAgent).not.toHaveBeenCalled();
  expect(client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith(
    "saved-agent",
    buildWorkshopPrompt(locator, request),
  );
  input.getClient.mockReturnValue(null);
  expect(await sendWorkshopEdit({ ...input, target })).toEqual({ kind: "offline" });
});
