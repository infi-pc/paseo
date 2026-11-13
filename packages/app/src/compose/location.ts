import type { ComposeDeepLinkTarget } from "@getpaseo/protocol/compose-deep-link";
import type { AgentSnapshotPayload } from "@getpaseo/protocol/messages";

interface ComposeAgentInput {
  agent: Pick<AgentSnapshotPayload, "workspaceId" | "archivedAt"> | null;
  workspaceId: string;
  isArchiving: boolean;
}

export function canComposeIntoAgent({
  agent,
  workspaceId,
  isArchiving,
}: ComposeAgentInput): boolean {
  return agent?.workspaceId === workspaceId && !agent.archivedAt && !isArchiving;
}

export function normalizeComposeDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

export function formatComposeReference(
  target: ComposeDeepLinkTarget,
  workspaceDirectory: string,
): string {
  const cwd = normalizeComposeDirectory(target.cwd);
  const workspaceRoot = normalizeComposeDirectory(workspaceDirectory);
  const file = target.file.replace(/\\/g, "/");
  const isAbsolute = file.startsWith("/") || /^[A-Za-z]:\//.test(file);
  const sourcePrefix = cwd === "/" ? "/" : `${cwd}/`;
  const sourcePath = isAbsolute ? file : `${sourcePrefix}${file}`;
  const workspacePrefix = workspaceRoot === "/" ? "/" : `${workspaceRoot}/`;
  let reference = sourcePath.startsWith(workspacePrefix)
    ? sourcePath.slice(workspacePrefix.length)
    : sourcePath;
  if (target.line !== null) reference += `:${target.line}`;
  if (target.column !== null) reference += `:${target.column}`;
  return reference;
}

export function matchComposeWorkspace<T extends { workspaceDirectory: string }>(
  workspaces: Iterable<T>,
  cwd: string,
): T | null {
  const directory = normalizeComposeDirectory(cwd);
  let closest: T | null = null;
  let closestLength = -1;
  let ambiguous = false;
  for (const workspace of workspaces) {
    const root = normalizeComposeDirectory(workspace.workspaceDirectory);
    const prefix = root === "/" ? "/" : `${root}/`;
    const containsDirectory = directory === root || directory.startsWith(prefix);
    if (!containsDirectory || root.length < closestLength) continue;
    if (root.length === closestLength) {
      ambiguous = true;
      continue;
    }
    closest = workspace;
    closestLength = root.length;
    ambiguous = false;
  }
  return ambiguous ? null : closest;
}
