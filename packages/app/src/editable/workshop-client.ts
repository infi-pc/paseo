import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  routeLocatorContext,
  type EditableElementSnapshot,
  type EditableLocatorContext,
  type EditableReferencedElement,
  type EditableScreenshotAttachment,
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
> &
  Partial<Pick<DaemonClient, "getProvidersSnapshot">>;

const PREFERRED_AUTO_REVIEW_MODES = ["auto-review", "auto"] as const;

function fallbackAutoReviewModeId(providerId: string): string | undefined {
  if (providerId === "codex") return "auto-review";
  if (providerId === "claude" || providerId === "antigravity") return "auto";
  return undefined;
}

async function resolveWorkshopModeId(
  client: WorkshopClient,
  providerId: string,
  cwd: string,
): Promise<string | undefined> {
  if (!client.getProvidersSnapshot) return fallbackAutoReviewModeId(providerId);
  try {
    const snapshot = await client.getProvidersSnapshot({ cwd });
    const entry = snapshot.entries.find((item) => item.provider === providerId);
    const modes = entry?.modes ?? [];
    const matched = PREFERRED_AUTO_REVIEW_MODES.find((preferred) =>
      modes.some((mode) => mode.id === preferred),
    );
    if (matched) return matched;
    if (entry?.defaultModeId) return entry.defaultModeId;
  } catch {
    // Fall back to provider-known auto-review mode below.
  }
  return fallbackAutoReviewModeId(providerId);
}
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

function buildIntentGuidelines(slugPlaceholder: string, summaryHint: string): string[] {
  return [
    "Respond based on what the user is actually asking:",
    '- If the user is asking a question, brainstorming, seeking your opinion, or exploring (for example "what do you think?", "why does…?", "how does…?", "could we…?"): ONLY inspect the code and answer concisely. Do NOT modify files, commit, or run `paseo-ed stage` until the user explicitly asks to implement a change.',
    "- Only when the user asks you to make or change something (now or in a later turn of this chat):",
    `  1. Make the edit inside that worktree.`,
    `  2. Run \`paseo-ed verify ${slugPlaceholder}\` to check typecheck and lint.`,
    `  3. Run \`paseo-ed stage ${slugPlaceholder} --summary "${summaryHint}" --upload\` to commit on the WIP branch, build the signed UI and/or Daemon release(s), and publish to Cloud Shelf so the user can hot-swap them live in Paseo Dev.app. Do NOT merge to main or run \`paseo-ed ship\` — the user will click Ship when ready.`,
    "- To live-inspect the running Paseo Dev.app (screenshots, DOM, React props/hooks, matched CSS, console logs, network, perf/APM, or stores), run `paseo-ed app --help`.",
  ];
}

function buildPromptInstructions(
  slug: string | undefined,
  isFollowUp: boolean | undefined,
  summaryHint: string,
  worktreePath: string | undefined,
): string[] {
  if (slug && worktreePath) {
    return [
      `You are the Editable Paseo Workshop assistant, working inside isolated WIP worktree \`${slug}\` (\`${worktreePath}\`, branch \`ed/wip/${slug}\`).`,
      "Use the `paseo-ed` CLI (`~/.local/bin/paseo-ed` if not on PATH) if and when you stage code changes.",
      ...buildIntentGuidelines(slug, summaryHint),
    ];
  }
  if (!slug) {
    return [
      "You are the Editable Paseo Workshop assistant in the dedicated Editable Paseo repository.",
      "Use the `paseo-ed` CLI (`~/.local/bin/paseo-ed` if not on PATH). If you need to make code changes, first run `paseo-ed wip create <slug>` and edit inside that worktree.",
      ...buildIntentGuidelines("<slug>", "<short summary>"),
    ];
  }
  if (isFollowUp) {
    return [
      `You are the Editable Paseo Workshop assistant, continuing in WIP worktree \`~/.editable-paseo/worktrees/${slug}\` (branch \`ed/wip/${slug}\`).`,
      "Use the `paseo-ed` CLI (`~/.local/bin/paseo-ed` if not on PATH).",
      ...buildIntentGuidelines(slug, summaryHint),
    ];
  }
  return [
    `You are the Editable Paseo Workshop assistant for isolated WIP branch \`${slug}\` (\`~/.editable-paseo/worktrees/${slug}\`, branch \`ed/wip/${slug}\`).`,
    `Use the \`paseo-ed\` CLI (\`~/.local/bin/paseo-ed\` if not on PATH). If \`~/.editable-paseo/worktrees/${slug}\` does not exist yet, first run \`paseo-ed wip create ${slug} --summary "${summaryHint}"\`.`,
    ...buildIntentGuidelines(slug, summaryHint),
  ];
}

function serializeLocatorContext(locator: EditableLocatorContext): string {
  const { file, line, column, componentName } = locator;
  const { route, releaseDigest, platform } = routeLocatorContext(locator);
  return JSON.stringify(
    { file, line, column, componentName, route, releaseDigest, platform },
    null,
    2,
  );
}

function appendReferenceSections(
  sections: string[],
  references: ReadonlyArray<{
    locator: EditableLocatorContext;
    snapshot?: EditableElementSnapshot | null;
  }>,
) {
  for (const ref of references) {
    sections.push("", "Locator context:", serializeLocatorContext(ref.locator));
    if (ref.snapshot) {
      sections.push("", "Element snapshot:", JSON.stringify(ref.snapshot));
    }
  }
}

export function buildWorkshopFollowUpPrompt(
  request: string,
  references: ReadonlyArray<{
    locator: EditableLocatorContext;
    snapshot?: EditableElementSnapshot | null;
  }>,
): string {
  const trimmed = request.trim();
  if (references.length === 0) return trimmed;
  const sections: string[] = [
    references.length === 1
      ? "Follow-up referencing a new UI element in the running app:"
      : `Follow-up referencing ${references.length} UI elements in the running app:`,
  ];
  appendReferenceSections(sections, references);
  sections.push("", "User message:", trimmed);
  return sections.join("\n");
}

export function buildWorkshopPrompt(
  locator: EditableLocatorContext,
  request: string,
  options: {
    slug?: string;
    isFollowUp?: boolean;
    worktreePath?: string;
    snapshot?: EditableElementSnapshot | null;
    extraReferences?: ReadonlyArray<Pick<EditableReferencedElement, "locator" | "snapshot">>;
  } = {},
): string {
  const summaryHint = request.trim().replace(/"/g, "'").slice(0, 72);
  const instructions = buildPromptInstructions(
    options.slug,
    options.isFollowUp,
    summaryHint,
    options.worktreePath,
  );

  const sections = [...instructions];
  const allRefs: Array<{
    locator: EditableLocatorContext;
    snapshot?: EditableElementSnapshot | null;
  }> = [{ locator, snapshot: options.snapshot }, ...(options.extraReferences ?? [])];
  appendReferenceSections(sections, allRefs);
  sections.push("", "User message:", request.trim());
  return sections.join("\n");
}

async function ensureWorkshopAgent(input: {
  client: WorkshopClient;
  target: WorkshopTarget;
  slug: string;
  hasExplicitSlug: boolean;
  isFollowUp?: boolean;
  worktreePath?: string;
  rememberAgent: (agentId: string, slug: string) => Promise<void>;
}): Promise<{ kind: "ready"; agentId: string; reused: boolean } | { kind: "no-provider" }> {
  let agentId = input.isFollowUp !== false ? input.target.workshopAgentId : null;
  if (agentId) {
    const existing = await input.client.fetchAgent(agentId);
    if (!existing || existing.agent.status === "closed" || existing.agent.archivedAt) {
      agentId = null;
    }
  }
  if (agentId) return { kind: "ready", agentId, reused: true };

  const { providers, error } = await input.client.listAvailableProviders();
  if (error) throw new Error(error);
  const available = providers.filter((provider) => provider.available);
  const provider = available.find((entry) => entry.provider === "codex") ?? available[0];
  if (!provider) return { kind: "no-provider" };

  const cwd =
    input.worktreePath ??
    (await resolveWorkshopCwd(input.client, input.target.workshopCwd ?? DEFAULT_WORKSHOP_CWD));
  const modeId = await resolveWorkshopModeId(input.client, provider.provider, cwd);
  const agent = await input.client.createAgent({
    title: input.hasExplicitSlug ? `Editable: ${input.slug}` : "Editable Paseo Workshop",
    provider: provider.provider,
    cwd,
    ...(modeId ? { modeId } : {}),
  });
  await input.rememberAgent(agent.id, input.slug);
  return { kind: "ready", agentId: agent.id, reused: false };
}

export async function sendWorkshopEdit(input: {
  target: WorkshopTarget;
  locator: EditableLocatorContext;
  request: string;
  slug?: string;
  isFollowUp?: boolean;
  worktreePath?: string | null;
  snapshot?: EditableElementSnapshot | null;
  extraReferences?: ReadonlyArray<Pick<EditableReferencedElement, "locator" | "snapshot">>;
  images?: EditableScreenshotAttachment[];
  getClient: (serverId: string) => WorkshopClient | null;
  rememberAgent: (agentId: string, slug: string) => Promise<void>;
}): Promise<WorkshopResult> {
  const { workshopHostId } = input.target;
  if (!workshopHostId) return { kind: "choose-host" };
  const client = input.getClient(workshopHostId);
  if (!client) return { kind: "offline" };

  const slug = input.slug ?? slugifyEditRequest(input.request);
  const worktreePath = input.worktreePath?.trim() || undefined;
  const resolved = await ensureWorkshopAgent({
    client,
    target: input.target,
    slug,
    hasExplicitSlug: Boolean(input.slug),
    isFollowUp: input.isFollowUp,
    worktreePath,
    rememberAgent: input.rememberAgent,
  });
  if (resolved.kind !== "ready") return resolved;

  const useCompactFollowUp = Boolean(input.isFollowUp && resolved.reused);
  const promptText = useCompactFollowUp
    ? buildWorkshopFollowUpPrompt(input.request, [
        { locator: input.locator, snapshot: input.snapshot },
        ...(input.extraReferences ?? []),
      ])
    : buildWorkshopPrompt(input.locator, input.request, {
        slug: input.slug,
        isFollowUp: input.isFollowUp,
        worktreePath,
        snapshot: input.snapshot,
        extraReferences: input.extraReferences,
      });
  if (input.images && input.images.length > 0) {
    await client.sendAgentMessage(resolved.agentId, promptText, { images: input.images });
  } else {
    await client.sendAgentMessage(resolved.agentId, promptText);
  }
  return { kind: "sent", agentId: resolved.agentId, slug };
}
