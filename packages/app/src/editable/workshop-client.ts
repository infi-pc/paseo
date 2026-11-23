import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  routeLocatorContext,
  type EditableLocatorContext,
  type EditableWorkshopConfig,
} from "./types";

export const DEFAULT_WORKSHOP_CWD = "~/.editable-paseo/repo";

type WorkshopClient = Pick<
  DaemonClient,
  "createAgent" | "fetchAgent" | "listAvailableProviders" | "sendAgentMessage"
>;
type WorkshopTarget = Pick<
  EditableWorkshopConfig,
  "workshopHostId" | "workshopCwd" | "workshopAgentId"
>;
export type WorkshopResult =
  | { kind: "choose-host" | "offline" | "no-provider" }
  | { kind: "sent"; agentId: string };

export function buildWorkshopPrompt(locator: EditableLocatorContext, request: string): string {
  const { file, line, column, componentName } = locator;
  const { route, releaseDigest, platform } = routeLocatorContext(locator);
  const context = { file, line, column, componentName, route, releaseDigest, platform };
  return [
    "Edit Paseo in the dedicated Editable Paseo repository.",
    "Use ed wip create to isolate the change, ed preview to make it available for review, and ed verify to check it. Use ed ship after the edit is approved.",
    "",
    "Locator context:",
    JSON.stringify(context, null, 2),
    "",
    "Edit request:",
    request.trim(),
  ].join("\n");
}

export async function sendWorkshopEdit(input: {
  target: WorkshopTarget;
  locator: EditableLocatorContext;
  request: string;
  getClient: (serverId: string) => WorkshopClient | null;
  rememberAgent: (agentId: string) => Promise<void>;
}): Promise<WorkshopResult> {
  const { workshopHostId, workshopCwd, workshopAgentId } = input.target;
  if (!workshopHostId) return { kind: "choose-host" };
  const client = input.getClient(workshopHostId);
  if (!client) return { kind: "offline" };

  let agentId = workshopAgentId;
  if (agentId) {
    const existing = await client.fetchAgent(agentId);
    if (!existing || existing.agent.status === "closed" || existing.agent.archivedAt)
      agentId = null;
  }
  if (!agentId) {
    const { providers, error } = await client.listAvailableProviders();
    if (error) throw new Error(error);
    const available = providers.filter((provider) => provider.available);
    const provider = available.find((entry) => entry.provider === "codex") ?? available[0];
    if (!provider) return { kind: "no-provider" };
    const agent = await client.createAgent({
      title: "Editable Paseo Workshop",
      provider: provider.provider,
      cwd: workshopCwd ?? DEFAULT_WORKSHOP_CWD,
    });
    agentId = agent.id;
    await input.rememberAgent(agentId);
  }

  await client.sendAgentMessage(agentId, buildWorkshopPrompt(input.locator, input.request));
  return { kind: "sent", agentId };
}
