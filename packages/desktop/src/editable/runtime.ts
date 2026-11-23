import {
  BrowserWindow,
  ipcMain,
  net,
  powerMonitor,
  protocol,
  session,
  type IpcMainInvokeEvent,
} from "electron";
import { EDITABLE_APP_SCHEME } from "./constants.js";
import { validatePreviewUrl } from "./preview.js";
import {
  createEditableProtocolHandler,
  isEditableAppUrl,
  isPinnedNavigation,
  pinDocumentRequests,
  rendererNavigationUrl,
  rendererRoute,
} from "./protocol.js";
import { EditableReleaseStore, type RendererRelease } from "./release-store.js";
import { watchRendererHealth } from "./renderer-health.js";
import { loadRendererDocument } from "./renderer-navigation.js";

interface LoadAttempt {
  release: RendererRelease;
  route: string;
  ready: boolean;
  loaded: Promise<void>;
  controller: AbortController;
  recovery?: Promise<void>;
}

export class EditableDesktopRuntime {
  private readonly store: EditableReleaseStore;
  private readonly windows = new Map<number, BrowserWindow>();
  private readonly previews = new Set<BrowserWindow>();
  private readonly attempts = new WeakMap<BrowserWindow, LoadAttempt>();
  private readonly updateHealthWatch = new WeakMap<BrowserWindow, () => void>();
  private useExportedRenderer: boolean;

  constructor(
    private readonly options: {
      builtInDistDir: string;
      isPackaged: boolean;
      devServerUrl: string;
      openNewWindow: () => Promise<void>;
      warn: (error: unknown) => void;
    },
  ) {
    this.store = new EditableReleaseStore(options);
    this.useExportedRenderer =
      options.isPackaged || this.store.safe || this.store.activeRelease.releaseDigest !== null;
  }

  register(): void {
    protocol.handle(
      EDITABLE_APP_SCHEME,
      createEditableProtocolHandler(this.store, (url) =>
        net.fetch(url, { bypassCustomProtocolHandlers: true }),
      ),
    );
    pinDocumentRequests(
      session.defaultSession.webRequest,
      this.store,
      (id) => this.windows.get(id)?.id,
    );

    ipcMain.handle("paseo:editable:getStatus", (event) => {
      const win = this.requireWindow(event);
      const status = this.store.getStatus(win.id);
      if (!this.attempts.get(win)?.ready) status.releaseDigest = null;
      return status;
    });
    ipcMain.handle("paseo:editable:switchRelease", (event, digest: unknown) => {
      const win = this.requireWindow(event);
      try {
        const release = this.store.switchRelease(digest);
        // Let the invoking document receive its IPC response before replacing it.
        setImmediate(() => void this.navigate(win, release).catch(this.options.warn));
        return { ok: true };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle("paseo:editable:useRecoveryRenderer", (event) => {
      const win = this.requireWindow(event);
      setImmediate(
        () => void this.navigate(win, this.store.useRecoveryRenderer()).catch(this.options.warn),
      );
    });
    ipcMain.handle("paseo:editable:setPreviewUrl", (event, url: unknown) => {
      this.requireWindow(event);
      if (url === null) return this.exitPreviewMode();
      return this.store.setPreviewUrl(url);
    });
    ipcMain.handle("paseo:editable:openPreviewWindow", (event, url: unknown) => {
      this.requireWindow(event);
      return this.openPreviewWindow(url);
    });
    ipcMain.handle("paseo:editable:reportHealthy", (event, digest: unknown) => {
      const win = this.requireWindow(event);
      if (this.attempts.get(win)?.ready && isEditableAppUrl(new URL(event.senderFrame!.url))) {
        if (this.store.reportHealthy(win.id, digest)) this.updateHealthWatch.get(win)?.();
      }
    });
  }

  private requireWindow(event: IpcMainInvokeEvent): BrowserWindow {
    const win = this.windows.get(event.sender.id);
    const frame = event.senderFrame;
    if (win && frame && frame === event.sender.mainFrame) {
      const url = new URL(frame.url);
      if (
        isEditableAppUrl(url) ||
        (!this.options.isPackaged && url.origin === new URL(this.options.devServerUrl).origin)
      ) {
        return win;
      }
    }
    throw new Error("Editable renderer operations require the Paseo desktop main frame");
  }

  registerWindow(win: BrowserWindow): void {
    const webContentsId = win.webContents.id;
    const windowId = win.id;
    this.windows.set(webContentsId, win);
    win.once("closed", () => {
      this.attempts.get(win)?.controller.abort();
      this.windows.delete(webContentsId);
      this.store.unpin(windowId);
    });
    win.webContents.on("did-finish-load", () => {
      const attempt = this.attempts.get(win);
      if (
        attempt &&
        !attempt.recovery &&
        isPinnedNavigation(win.webContents.getURL(), attempt.release)
      ) {
        attempt.ready = true;
      }
    });
    this.updateHealthWatch.set(
      win,
      watchRendererHealth(win, {
        pending: () => this.isPending(win),
        matchesNavigation: (url) => {
          const attempt = this.attempts.get(win);
          return !!attempt && isPinnedNavigation(url, attempt.release);
        },
        fail: () => void this.recover(win).catch(this.options.warn),
        monitor: powerMonitor,
      }),
    );
  }

  isPending(win: BrowserWindow): boolean {
    return (
      !win.isDestroyed() &&
      this.store.isPending(win.id, this.attempts.get(win)?.release.releaseDigest)
    );
  }

  isPreview(win: BrowserWindow): boolean {
    return this.previews.has(win);
  }

  private async openPreviewWindow(input: unknown): Promise<void> {
    const url = validatePreviewUrl(input);
    this.store.setPreviewUrl(url);
    // Metro is an unsigned preview. Keep it in a temporary session with no
    // privileged desktop preload, and keep all top-level navigation on its origin.
    const origin = new URL(url).origin;
    const win = new BrowserWindow({
      title: "Paseo Editable Preview",
      width: 1200,
      height: 800,
      webPreferences: {
        partition: "editable-preview",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    this.previews.add(win);
    win.once("closed", () => this.previews.delete(win));
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-frame-navigate", (event) => {
      if (new URL(event.url).origin !== origin) event.preventDefault();
    });
    win.webContents.on("will-redirect", (event) => {
      if (new URL(event.url).origin !== origin) event.preventDefault();
    });
    try {
      await win.loadURL(url);
    } catch (error) {
      if (!win.isDestroyed()) win.destroy();
      throw error;
    }
  }

  async exitPreviewMode(): Promise<void> {
    try {
      if (!this.store.safe) this.store.setPreviewUrl(null);
    } finally {
      for (const win of this.previews) win.destroy();
    }
  }

  useRecoveryRenderer(): Promise<void> {
    return this.navigateFromMenu(this.store.useRecoveryRenderer());
  }

  async reloadLatestRenderer(): Promise<void> {
    await this.navigateFromMenu(this.store.reloadChannel({ fromMenu: true }));
  }

  private async navigateFromMenu(release: RendererRelease): Promise<void> {
    const focused = BrowserWindow.getFocusedWindow();
    const win =
      focused && this.windows.has(focused.webContents.id)
        ? focused
        : this.windows.values().next().value;
    this.useExportedRenderer = true;
    if (win) await this.navigate(win, release);
    else await this.options.openNewWindow();
  }

  loadInitial(win: BrowserWindow, route: string): Promise<void> | null {
    return this.useExportedRenderer ? this.navigate(win, this.store.activeRelease, route) : null;
  }

  private currentRoute(win: BrowserWindow): string {
    const current = win.webContents.getURL();
    if (!current) return this.attempts.get(win)?.route ?? "/";
    return rendererRoute(new URL(current));
  }

  private navigate(win: BrowserWindow, release: RendererRelease, route?: string): Promise<void> {
    if (win.isDestroyed()) return Promise.resolve();
    this.useExportedRenderer = true;
    const nextRoute = route ?? this.currentRoute(win);
    const url = rendererNavigationUrl(nextRoute, release);
    const attempt: LoadAttempt = {
      release,
      route: nextRoute,
      ready: false,
      loaded: Promise.resolve(),
      controller: new AbortController(),
    };
    this.attempts.get(win)?.controller.abort();
    this.store.pin(win.id, release);
    this.attempts.set(win, attempt);
    attempt.loaded = loadRendererDocument(win, url, release, attempt.controller.signal)
      .then(() => {
        if (attempt.recovery) return attempt.recovery;
        if (!attempt.controller.signal.aborted) attempt.ready = true;
        return undefined;
      })
      .catch(async (error: Error & { code?: string }) => {
        if (win.isDestroyed()) return;
        const current = this.attempts.get(win);
        if (current !== attempt) return current?.loaded;
        if (error.code === "ERR_ABORTED") return;
        if (this.isPending(win)) return this.recover(win);
        throw error;
      });
    this.updateHealthWatch.get(win)?.();
    return attempt.loaded;
  }

  private recover(win: BrowserWindow): Promise<void> {
    const attempt = this.attempts.get(win);
    if (!attempt || !this.isPending(win)) return Promise.resolve();
    if (!attempt.recovery) {
      attempt.ready = false;
      // Let Electron finish the failed navigation before starting the rollback.
      attempt.recovery = new Promise<void>((resolve) => setImmediate(resolve)).then(() =>
        this.rollback(win, attempt),
      );
    }
    return attempt.recovery;
  }

  private async rollback(win: BrowserWindow, failed: LoadAttempt): Promise<void> {
    const digest = failed.release.releaseDigest;
    if (!digest || this.attempts.get(win) !== failed || !this.isPending(win)) return;

    const affected = [...this.windows.values()].filter(
      (other) =>
        this.isPending(other) && this.attempts.get(other)?.release.releaseDigest === digest,
    );
    const fallback = this.store.quarantine(digest);
    await Promise.all(
      affected.map((other) =>
        this.navigate(other, fallback, other === win ? failed.route : undefined),
      ),
    );
  }
}
