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
  | { kind: "sent"; agentId: string; slug: string };

export function slugifyEditRequest(request: string, existingSlugs?: Iterable<string>): string {
  const base =
    request
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 36)
      .replace(/-+$/, "") || "edit";
  const taken = new Set(existingSlugs ?? []);
  if (!taken.has(base)) return base;
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base.slice(0, 32)}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base.slice(0, 28)}-${Date.now().toString(36).slice(-4)}`;
}

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

function buildPromptInstructions(
  slug: string | undefined,
  isFollowUp: boolean | undefined,
  summaryHint: string,
): string[] {
  if (!slug) {
    return [
      "Edit Paseo in the dedicated Editable Paseo repository.",
      "Use the `paseo-ed` CLI (`~/.local/bin/paseo-ed` if not on PATH):",
      "1. Run `paseo-ed wip create <slug>` and edit inside that worktree.",
      "2. Run `paseo-ed verify <slug>` to check typecheck and lint.",
      '3. Run `paseo-ed stage <slug> --summary "<short summary>" --upload` to build the signed branch preview and publish to Cloud Shelf. Do NOT merge to main or run `paseo-ed ship` unless explicitly asked.',
    ];
  }
  if (isFollowUp) {
    return [
      `Continue editing Paseo in the existing WIP worktree \`~/.editable-paseo/worktrees/${slug}\` (branch \`ed/wip/${slug}\`).`,
      "Use the `paseo-ed` CLI (`~/.local/bin/paseo-ed` if not on PATH):",
      `1. Make the follow-up edit inside \`~/.editable-paseo/worktrees/${slug}\`.`,
      `2. Run \`paseo-ed verify ${slug}\` to check typecheck and lint.`,
      `3. Run \`paseo-ed stage ${slug} --summary "${summaryHint}" --upload\` to build and publish the updated branch preview to Cloud Shelf. Do NOT merge to main or run \`paseo-ed ship\` — the user will click Ship when ready.`,
    ];
  }
  return [
    `Edit Paseo in the dedicated Editable Paseo repository on isolated WIP branch \`${slug}\`.`,
    "Use the `paseo-ed` CLI (`~/.local/bin/paseo-ed` if not on PATH):",
    `1. Run \`paseo-ed wip create ${slug} --summary "${summaryHint}"\` and make the edit inside \`~/.editable-paseo/worktrees/${slug}\`.`,
    `2. Run \`paseo-ed verify ${slug}\` to check typecheck and lint.`,
    `3. Run \`paseo-ed stage ${slug} --summary "${summaryHint}" --upload\` to commit on the WIP branch, build the signed Electron preview, and publish to Cloud Shelf. Do NOT merge to main or run \`paseo-ed ship\` — the user will click Ship when ready.`,
  ];
}

export function buildWorkshopPrompt(
  locator: EditableLocatorContext,
  request: string,
  options: { slug?: string; isFollowUp?: boolean } = {},
): string {
  const { file, line, column, componentName } = locator;
  const { route, releaseDigest, platform } = routeLocatorContext(locator);
  const context = { file, line, column, componentName, route, releaseDigest, platform };
  const summaryHint = request.trim().replace(/"/g, "'").slice(0, 72);
  const instructions = buildPromptInstructions(options.slug, options.isFollowUp, summaryHint);

  return [
    ...instructions,
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
  slug?: string;
  isFollowUp?: boolean;
  getClient: (serverId: string) => WorkshopClient | null;
  rememberAgent: (agentId: string, slug: string) => Promise<void>;
}): Promise<WorkshopResult> {
  const { workshopHostId, workshopCwd, workshopAgentId } = input.target;
  if (!workshopHostId) return { kind: "choose-host" };
  const client = input.getClient(workshopHostId);
  if (!client) return { kind: "offline" };

  const slug = input.slug ?? slugifyEditRequest(input.request);
  let agentId = input.isFollowUp !== false ? workshopAgentId : null;
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
      title: input.slug ? `Editable: ${slug}` : "Editable Paseo Workshop",
      provider: provider.provider,
      cwd,
    });
    agentId = agent.id;
    await input.rememberAgent(agentId, slug);
  }

  await client.sendAgentMessage(
    agentId,
    buildWorkshopPrompt(input.locator, input.request, {
      slug: input.slug,
      isFollowUp: input.isFollowUp,
    }),
  );
  return { kind: "sent", agentId, slug };
}
