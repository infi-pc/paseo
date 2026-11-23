import { isPinnedNavigation } from "./protocol.js";
import type { RendererRelease } from "./release-store.js";

export function loadRendererDocument(
  win: Electron.BrowserWindow,
  url: string,
  release: RendererRelease,
  signal: AbortSignal,
): Promise<void> {
  const contents = win.webContents;
  return new Promise<void>((resolve, reject) => {
    let committed = false;
    function cleanup() {
      contents.removeListener("did-navigate", didNavigate);
      contents.removeListener("did-finish-load", didFinish);
      signal.removeEventListener("abort", cancel);
    }
    function cancel() {
      cleanup();
      resolve();
    }
    function didNavigate(_event: Electron.Event, target: string) {
      committed = isPinnedNavigation(target, release);
    }
    function didFinish() {
      // After did-fail-load, Chromium may finish the error page while the
      // fallback is loading. Electron's loadURL promise can resolve on that event.
      if (committed) cancel();
    }

    contents.on("did-navigate", didNavigate);
    contents.on("did-finish-load", didFinish);
    signal.addEventListener("abort", cancel, { once: true });
    void win.loadURL(url).catch((error: unknown) => {
      cleanup();
      reject(error);
    });
  });
}
