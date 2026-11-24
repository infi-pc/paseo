import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  routeLocatorContext,
  type EditableLocatorContext,
  type EditableWorkshopConfig,
} from "./types";

export const DEFAULT_WORKSHOP_CWD = "~/.editable-paseo/repo";

type WorkshopClient = Pick<
  DaemonClient,
  | "createAgent"
  | "fetchAgent"
  | "getDirectorySuggestions"
  | "listAvailableProviders"
  | "sendAgentMessage"
>;
type WorkshopTarget = Pick<
  EditableWorkshopConfig,
  "workshopHostId" | "workshopCwd" | "workshopAgentId"
>;
export type WorkshopResult =
  | { kind: "choose-host" | "offline" | "no-provider" }
  | { kind: "sent"; agentId: string };

async function resolveWorkshopCwd(client: WorkshopClient, rawCwd: string): Promise<string> {
  const trimmed = rawCwd.trim();
  if (trimmed === "~") {
    throw new Error("Workshop repository path must be a subdirectory, not ~");
  }
  if (!trimmed.startsWith("~/")) return trimmed;

  const relative = trimmed.slice(2).replace(/^\/+/, "").replace(/\/+$/, "");
  if (!relative) {
    throw new Error("Workshop repository path must be a subdirectory, not ~/");
  }

  const result = await client.getDirectorySuggestions({
    query: `~/${relative}`,
    includeDirectories: true,
    includeFiles: false,
    limit: 1,
  });
  if (result.error) throw new Error(result.error);

  const suffix = `/${relative}`;
  const match = result.directories.find((dir) =>
    dir.replace(/\\/g, "/").replace(/\/+$/, "").endsWith(suffix),
  );
  if (!match) {
    throw new Error(`Workshop directory not found on host: ${trimmed}`);
  }
  return match;
}

export function buildWorkshopPrompt(locator: EditableLocatorContext, request: string): string {
  const { file, line, column, componentName } = locator;
  const { route, releaseDigest, platform } = routeLocatorContext(locator);
  const context = { file, line, column, componentName, route, releaseDigest, platform };
  return [
    "Edit Paseo in the dedicated Editable Paseo repository.",
    "Use the `paseo-ed` CLI (`~/.local/bin/paseo-ed` if not on PATH):",
    "1. Run `paseo-ed wip create <slug>` and edit inside that worktree.",
    "2. Run `paseo-ed verify <slug>` to check typecheck and lint.",
    '3. For UI-only edits, run `paseo-ed ship <slug> --summary "<short summary>" --upload` to land locally, build the signed Electron renderer, and publish to Cloud Shelf (pass `--push` only if explicitly requested).',
    "4. Tell the user when the signed update is ready so they can run Editable -> Sync from Cloud Shelf.",
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
    const cwd = await resolveWorkshopCwd(client, workshopCwd ?? DEFAULT_WORKSHOP_CWD);
    const agent = await client.createAgent({
      title: "Editable Paseo Workshop",
      provider: provider.provider,
      cwd,
    });
    agentId = agent.id;
    await input.rememberAgent(agentId);
  }

  await client.sendAgentMessage(agentId, buildWorkshopPrompt(input.locator, input.request));
  return { kind: "sent", agentId };
}
