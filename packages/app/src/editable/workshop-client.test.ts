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
      "Use ed wip create to isolate the change, ed preview to make it available for review, and ed verify to check it. Use ed ship after the edit is approved.",
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

it("creates the first agent in the dedicated repo on the configured host", async () => {
  const { client, input } = fixture();
  expect(await sendWorkshopEdit(input)).toEqual({ kind: "sent", agentId: "workshop-agent" });
  expect(input.getClient).toHaveBeenCalledExactlyOnceWith("workshop");
  expect(client.createAgent).toHaveBeenCalledExactlyOnceWith({
    cwd: DEFAULT_WORKSHOP_CWD,
    provider: "codex",
    title: "Editable Paseo Workshop",
  });
  expect(input.rememberAgent).toHaveBeenCalledExactlyOnceWith("workshop-agent");
  expect(client.sendAgentMessage).toHaveBeenCalledExactlyOnceWith(
    "workshop-agent",
    buildWorkshopPrompt(locator, request),
  );
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
