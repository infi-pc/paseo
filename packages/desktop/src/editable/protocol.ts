import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { EDITABLE_APP_ORIGIN, EDITABLE_APP_SCHEME } from "./constants.js";
import { isSafeRelativePath } from "./crypto.js";
import type { EditableReleaseStore, RendererFile, RendererRelease } from "./release-store.js";

const selectionParam = "__editable";

export function rendererNavigationUrl(route: string, release: RendererRelease): string {
  const url = new URL(`${EDITABLE_APP_ORIGIN}${route}`);
  url.searchParams.set(selectionParam, release.releaseDigest ?? "builtin");
  return url.href;
}

export function rendererRoute(url: URL): string {
  url.searchParams.delete(selectionParam);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function isPinnedNavigation(rawUrl: string, release: RendererRelease): boolean {
  const url = URL.parse(rawUrl);
  return (
    !!url &&
    isEditableAppUrl(url) &&
    url.searchParams.get(selectionParam) === (release.releaseDigest ?? "builtin")
  );
}

export function isEditableAppUrl(url: URL): boolean {
  return (
    url.protocol === `${EDITABLE_APP_SCHEME}:` &&
    url.host === "app" &&
    !url.username &&
    !url.password
  );
}

function parseRequest(rawUrl: string): { url: URL; file: string } | null {
  // Inspect the original path before URL normalizes dot segments.
  const rawPath = rawUrl.match(/^paseo:\/\/app(\/[^?#]*)?(?:[?#]|$)/)?.[1];
  try {
    const url = new URL(rawUrl);
    if (!isEditableAppUrl(url)) return null;
    const file = decodeURIComponent((rawPath ?? url.pathname).slice(1));
    return !file || isSafeRelativePath(file.replace(/\/$/, "")) ? { url, file } : null;
  } catch {
    return null;
  }
}

const notFound = () => new Response("Not found", { status: 404 });

export function createEditableProtocolHandler(
  store: EditableReleaseStore,
  fetchFile: (url: string) => Promise<Response>,
) {
  return async (request: Request): Promise<Response> => {
    const parsed = parseRequest(request.url);
    if (!parsed) return notFound();
    const { file, url } = parsed;

    const scoped = file.match(/^__ed\/([a-f0-9]{16})\/(.+)$/);
    if ((file === "__ed" || file.startsWith("__ed/")) && !scoped) return notFound();
    if (!scoped && url.pathname.endsWith("/index.html")) {
      url.pathname = url.pathname.slice(0, -"index.html".length);
      return Response.redirect(url.href, 307);
    }

    const selection = url.searchParams.get(selectionParam);
    const isPinnedDocument = !scoped && selection !== null && !file.startsWith("_expo/");
    // A broken pinned document must surface as did-fail-load even for hidden windows.
    const failed = isPinnedDocument ? Response.error : notFound;
    const asset = scoped ? store.resolveAsset(scoped[2], scoped[1]) : store.resolveAsset(file);
    const isRoute = !scoped && !file.startsWith("_expo/") && !path.posix.extname(file);
    const resolved =
      isPinnedDocument || (isRoute && !asset)
        ? store.resolveDocument("index.html", selection)
        : asset;

    if (!resolved) return failed();
    try {
      const result = await fetchFile(pathToFileURL(resolved.filePath).href);
      return (await verifyResponse(result, resolved, request.method)) ?? failed();
    } catch {
      return failed();
    }
  };
}

async function verifyResponse(
  response: Response,
  file: RendererFile,
  method: string,
): Promise<Response | null> {
  if (!file.integrity) return response;
  if (!response.ok) return null;
  const content = await response.arrayBuffer();
  const { bytes, sha256 } = file.integrity;
  if (
    content.byteLength !== bytes ||
    createHash("sha256").update(new Uint8Array(content)).digest("hex") !== sha256
  ) {
    return null;
  }
  return new Response(method === "HEAD" ? null : content, {
    headers: response.headers,
    status: response.status,
  });
}

export function pinDocumentRequests(
  webRequest: Electron.WebRequest,
  store: EditableReleaseStore,
  getWindowId: (webContentsId: number) => number | undefined,
): void {
  // The protocol request lacks webContentsId. Restore the pin on full-page
  // reloads even when client-side routing has removed the initial query param.
  webRequest.onBeforeRequest({ urls: [`${EDITABLE_APP_ORIGIN}/*`] }, (details, callback) => {
    const windowId =
      details.webContentsId === undefined ? undefined : getWindowId(details.webContentsId);
    const release = windowId === undefined ? undefined : store.windowReleaseRegistry.get(windowId);
    if (!release || details.resourceType !== "mainFrame") {
      callback({});
      return;
    }
    const pinned = rendererNavigationUrl(details.url.slice(EDITABLE_APP_ORIGIN.length), release);
    callback(pinned === details.url ? {} : { redirectURL: pinned });
  });
}
