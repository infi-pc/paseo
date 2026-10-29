import type { AgentDeepLinkTarget } from "./agent-deep-link.js";

// FORK(locator-compose): external source locations become unsent composer text.
export interface ComposeDeepLinkTarget {
  kind: "compose";
  serverId: string | null;
  cwd: string;
  file: string;
  line: number | null;
  column: number | null;
}

export type DesktopNavigationTarget = AgentDeepLinkTarget | ComposeDeepLinkTarget;

export function parseComposeDeepLink(input: string): ComposeDeepLinkTarget | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!isComposeUrl(url)) return null;
  const allowed = new Set(["serverId", "cwd", "file", "line", "column"]);
  for (const key of url.searchParams.keys()) {
    if (!allowed.has(key) || url.searchParams.getAll(key).length !== 1) return null;
  }
  const cwd = url.searchParams.get("cwd")?.trim() ?? "";
  const file = url.searchParams.get("file")?.trim() ?? "";
  const serverId = url.searchParams.get("serverId");
  if (!isComposeLocationValid({ cwd, file, serverId })) return null;
  const lineText = url.searchParams.get("line");
  const columnText = url.searchParams.get("column");
  for (const value of [lineText, columnText]) {
    if (!isPositionTextValid(value)) return null;
  }
  if (columnText !== null && lineText === null) return null;
  return {
    kind: "compose",
    serverId,
    cwd,
    file,
    line: lineText === null ? null : Number(lineText),
    column: columnText === null ? null : Number(columnText),
  };
}

export function buildComposeRoute(target: ComposeDeepLinkTarget, requestId: string): string {
  const params = new URLSearchParams({ cwd: target.cwd, file: target.file, requestId });
  if (target.serverId !== null) params.set("serverId", target.serverId);
  if (target.line !== null) params.set("line", String(target.line));
  if (target.column !== null) params.set("column", String(target.column));
  return `/compose?${params}`;
}

function isComposeUrl(url: URL): boolean {
  if (
    url.protocol !== "paseo:" ||
    url.hostname !== "compose" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  )
    return false;
  return true;
}

function isComposeLocationValid(
  input: Pick<ComposeDeepLinkTarget, "cwd" | "file" | "serverId">,
): boolean {
  const { cwd, file, serverId } = input;
  if (!cwd || !file || serverId?.trim() === "") return false;
  if (Array.from(cwd + file).some((char) => char.charCodeAt(0) < 32)) return false;
  return cwd.startsWith("/") || /^[A-Za-z]:[\\/]/.test(cwd);
}

function isPositionTextValid(value: string | null): boolean {
  return value === null || (/^[1-9]\d*$/.test(value) && Number.isSafeInteger(Number(value)));
}
