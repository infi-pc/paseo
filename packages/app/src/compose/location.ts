import type { ComposeDeepLinkTarget } from "@getpaseo/protocol/compose-deep-link";

export function normalizeComposeDirectory(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  return normalized || "/";
}

export function formatComposeReference(target: ComposeDeepLinkTarget): string {
  const cwd = normalizeComposeDirectory(target.cwd);
  const file = target.file.replace(/\\/g, "/");
  const prefix = cwd === "/" ? "/" : `${cwd}/`;
  let reference = file.startsWith(prefix) ? file.slice(prefix.length) : file;
  if (target.line !== null) reference += `:${target.line}`;
  if (target.column !== null) reference += `:${target.column}`;
  return reference;
}

export function matchComposeWorkspace<T extends { workspaceDirectory: string }>(
  workspaces: Iterable<T>,
  cwd: string,
): T | null {
  const directory = normalizeComposeDirectory(cwd);
  const matches = Array.from(workspaces).filter(
    (workspace) => normalizeComposeDirectory(workspace.workspaceDirectory) === directory,
  );
  return matches.length === 1 ? matches[0]! : null;
}
