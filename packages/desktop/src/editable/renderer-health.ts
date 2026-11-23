const VISIBLE_HEALTH_TIMEOUT_MS = 60_000;
const ERR_ABORTED = -3;

export function watchRendererHealth(
  win: Electron.BrowserWindow,
  options: {
    pending: () => boolean;
    matchesNavigation: (url: string) => boolean;
    fail: () => void;
    monitor: Pick<Electron.PowerMonitor, "on" | "removeListener">;
    timeoutMs?: number;
  },
): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let suspended = false;
  const stop = () => clearTimeout(timer);
  const arm = () => {
    stop();
    if (
      suspended ||
      win.isDestroyed() ||
      !win.isVisible() ||
      win.isMinimized() ||
      !win.isFocused() ||
      !options.pending()
    ) {
      return;
    }
    timer = setTimeout(() => {
      if (
        !suspended &&
        !win.isDestroyed() &&
        win.isVisible() &&
        !win.isMinimized() &&
        win.isFocused() &&
        options.pending()
      ) {
        options.fail();
      }
    }, options.timeoutMs ?? VISIBLE_HEALTH_TIMEOUT_MS);
  };
  const suspend = () => {
    suspended = true;
    stop();
  };
  const resume = () => {
    suspended = false;
    arm();
  };

  win.webContents.on("did-fail-load", (_event, code, _description, url, isMainFrame) => {
    if (
      isMainFrame &&
      code !== ERR_ABORTED &&
      options.matchesNavigation(url) &&
      options.pending()
    ) {
      options.fail();
    }
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    if (details.reason !== "clean-exit" && options.pending()) options.fail();
  });
  win.webContents.on("did-finish-load", arm);
  win.on("focus", arm);
  win.on("show", arm);
  win.on("restore", arm);
  win.on("blur", stop);
  win.on("hide", stop);
  win.on("minimize", stop);
  options.monitor.on("suspend", suspend);
  options.monitor.on("resume", resume);
  win.once("closed", () => {
    stop();
    options.monitor.removeListener("suspend", suspend);
    options.monitor.removeListener("resume", resume);
  });
  return arm;
}
