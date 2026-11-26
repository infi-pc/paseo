import {
  app,
  BrowserWindow,
  ipcMain,
  net,
  powerMonitor,
  protocol,
  session,
  type IpcMainInvokeEvent,
} from "electron";
import { EditableBranchManager } from "./branches.js";
import { syncFromCloudShelf } from "./cloud-sync.js";
import { EDITABLE_APP_SCHEME, resolveEditableHome } from "./constants.js";
import { EditableDaemonController } from "./daemon-swap.js";
import {
  EditableInspectorServer,
  asInspectorWindow,
  captureWindowScreenshot,
  type ScreenshotRectInput,
} from "./inspector-server.js";
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
import type { EditableWorkshopDaemonManager } from "./workshop-daemon.js";

const AUTO_SYNC_INTERVAL_MS = 12_000;

interface LoadAttempt {
  release: RendererRelease;
  channel: string;
  route: string;
  ready: boolean;
  loaded: Promise<void>;
  controller: AbortController;
  recovery?: Promise<void>;
}

export class EditableDesktopRuntime {
  private readonly home = resolveEditableHome();
  private cloudSync: Promise<boolean> | undefined;
  private readonly store: EditableReleaseStore;
  private readonly daemonController: EditableDaemonController | null;
  private readonly branchManager: EditableBranchManager | null;
  private readonly inspectorServer: EditableInspectorServer | null;
  private autoSyncTimer: ReturnType<typeof setInterval> | null = null;
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
      cloudShelfHome?: string;
      workshopDaemon?: EditableWorkshopDaemonManager;
      openNewWindow: () => Promise<void>;
      warn: (error: unknown) => void;
    },
  ) {
    this.store = new EditableReleaseStore({
      ...options,
      home: this.home,
      publicKeyHome: options.cloudShelfHome,
    });
    this.daemonController = options.cloudShelfHome
      ? new EditableDaemonController({
          store: this.store,
          warn: options.warn,
        })
      : null;
    this.branchManager = options.cloudShelfHome
      ? new EditableBranchManager({
          home: this.home,
          configHome: options.cloudShelfHome,
          store: this.store,
          daemonController: this.daemonController ?? undefined,
        })
      : null;
    this.inspectorServer = options.cloudShelfHome
      ? new EditableInspectorServer({
          home: this.home,
          configHome: options.cloudShelfHome,
          getActiveWindow: () => {
            const win = this.resolveActiveWindow();
            return win ? asInspectorWindow(win) : null;
          },
          getDesktopStatus: () => {
            const win = this.resolveActiveWindow();
            return win ? this.store.getStatus(win.id) : null;
          },
          getProcessMetrics: () =>
            app.getAppMetrics().map((m) => ({
              type: m.type,
              pid: m.pid,
              cpuPercent: Math.round(m.cpu.percentCPUUsage * 10) / 10,
              memoryMb: Math.round((m.memory.workingSetSize / 1024) * 10) / 10,
            })),
          warn: options.warn,
        })
      : null;
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
    ipcMain.handle("paseo:editable:useRecoveryRenderer", async (event) => {
      const win = this.requireWindow(event);
      if (this.daemonController) {
        await this.daemonController.resetToBuiltIn().catch(this.options.warn);
      }
      setImmediate(
        () =>
          void this.navigate(win, this.store.useRecoveryRenderer(), undefined, "builtin").catch(
            this.options.warn,
          ),
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
    ipcMain.handle("paseo:editable:syncFromCloudShelf", async (event) => {
      this.requireWindow(event);
      try {
        const updated = await this.syncFromCloudShelf();
        return { ok: true, updated };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle("paseo:editable:getWorkshopStatus", async (event) => {
      this.requireWindow(event);
      if (!this.options.workshopDaemon) return null;
      return this.options.workshopDaemon.getStatus();
    });
    ipcMain.handle("paseo:editable:startWorkshopDaemon", async (event) => {
      this.requireWindow(event);
      if (!this.options.workshopDaemon) {
        throw new Error("Workshop daemon management is not enabled in this build");
      }
      return this.options.workshopDaemon.start();
    });
    ipcMain.handle("paseo:editable:getBranches", async (event) => {
      const win = this.requireWindow(event);
      if (!this.branchManager) return null;
      return this.branchManager.getSnapshot({
        loadedChannel: this.store.getWindowChannel(win.id),
        loadedDigest: this.store.getWindowRelease(win.id)?.releaseDigest ?? null,
        safeRenderer: this.store.safe,
      });
    });
    ipcMain.handle("paseo:editable:syncNow", async (event) => {
      const win = this.requireWindow(event);
      if (!this.branchManager) return { ok: false, error: "Branch sync unavailable" };
      try {
        const res = await this.branchManager.syncAll({
          loadedChannel: this.store.getWindowChannel(win.id),
        });
        return { ok: true, updated: res.updated };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle("paseo:editable:loadBranch", async (event, channel: unknown) => {
      const win = this.requireWindow(event);
      if (!this.branchManager || typeof channel !== "string") {
        return { ok: false, error: "Invalid branch channel" };
      }
      try {
        const currentDigest = this.store.getWindowRelease(win.id)?.releaseDigest ?? null;
        const {
          release,
          channel: resolvedChannel,
          uiChanged,
          daemonSwapped,
        } = await this.branchManager.loadBranch(channel, { currentLoadedDigest: currentDigest });
        if (uiChanged) {
          setImmediate(
            () =>
              void this.navigate(win, release, undefined, resolvedChannel).catch(this.options.warn),
          );
        } else {
          this.store.pin(win.id, release, resolvedChannel);
        }
        return { ok: true, uiChanged, daemonSwapped };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle("paseo:editable:shipBranch", async (event, slug: unknown) => {
      const win = this.requireWindow(event);
      if (!this.branchManager || typeof slug !== "string") {
        return { ok: false, error: "Invalid branch slug" };
      }
      const loadedChannel = this.store.getWindowChannel(win.id);
      const result = await this.branchManager.shipBranch(slug, { loadedChannel });
      if (!result.ok) return result;
      if (result.shouldAutoLoad) {
        try {
          const currentDigest = this.store.getWindowRelease(win.id)?.releaseDigest ?? null;
          const { release, uiChanged } = await this.branchManager.loadBranch("prod", {
            currentLoadedDigest: currentDigest,
          });
          if (uiChanged) {
            setImmediate(
              () => void this.navigate(win, release, undefined, "prod").catch(this.options.warn),
            );
          } else {
            this.store.pin(win.id, release, "prod");
          }
          return { ...result, autoLoaded: true };
        } catch (error) {
          return {
            ...result,
            autoLoaded: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }
      return { ...result, autoLoaded: false };
    });
    ipcMain.handle("paseo:editable:createBranch", async (event, input: unknown) => {
      this.requireWindow(event);
      if (!this.branchManager || !input || typeof input !== "object") {
        return { ok: false, error: "Invalid branch request" };
      }
      const record = input as { slug?: unknown; summary?: unknown; agentId?: unknown };
      if (typeof record.slug !== "string") {
        return { ok: false, error: "Invalid branch slug" };
      }
      return this.branchManager.createBranch({
        slug: record.slug,
        summary: typeof record.summary === "string" ? record.summary : undefined,
        agentId: typeof record.agentId === "string" ? record.agentId : undefined,
      });
    });
    ipcMain.handle(
      "paseo:editable:attachBranchAgent",
      async (event, slug: unknown, agentId: unknown) => {
        this.requireWindow(event);
        if (!this.branchManager || typeof slug !== "string" || typeof agentId !== "string") {
          return { ok: false, error: "Invalid branch agent attachment" };
        }
        return this.branchManager.attachBranchAgent(slug, agentId);
      },
    );
    ipcMain.handle("paseo:editable:captureScreenshot", async (event, input: unknown) => {
      const win = this.requireWindow(event);
      try {
        const opts = (input && typeof input === "object" ? input : {}) as {
          rect?: ScreenshotRectInput | null;
          full?: boolean;
          padding?: number;
        };
        const shot = await captureWindowScreenshot(asInspectorWindow(win), {
          rect: opts.rect ?? null,
          full: Boolean(opts.full),
          padding: typeof opts.padding === "number" ? opts.padding : undefined,
        });
        return {
          ok: true,
          dataBase64: shot.png.toString("base64"),
          mimeType: "image/png" as const,
          width: shot.width,
          height: shot.height,
        };
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    });
    ipcMain.handle("paseo:editable:discardBranch", async (event, slug: unknown) => {
      const win = this.requireWindow(event);
      if (!this.branchManager || typeof slug !== "string") {
        return { ok: false, error: "Invalid branch slug" };
      }
      const loadedChannel = this.store.getWindowChannel(win.id);
      const result = await this.branchManager.discardBranch(slug);
      if (result.ok && loadedChannel === `wip-${slug}`) {
        try {
          const currentDigest = this.store.getWindowRelease(win.id)?.releaseDigest ?? null;
          const { release, uiChanged } = await this.branchManager.loadBranch("prod", {
            currentLoadedDigest: currentDigest,
          });
          if (uiChanged) {
            setImmediate(
              () => void this.navigate(win, release, undefined, "prod").catch(this.options.warn),
            );
          } else {
            this.store.pin(win.id, release, "prod");
          }
        } catch (error) {
          this.options.warn(error);
        }
      }
      return result;
    });

    this.startAutoSync();
    if (this.inspectorServer) {
      void this.inspectorServer.start().catch(this.options.warn);
      app.once("will-quit", () => this.inspectorServer?.close());
    }
  }

  private resolveActiveWindow(): BrowserWindow | null {
    const focused = BrowserWindow.getFocusedWindow();
    if (focused && this.windows.has(focused.webContents.id) && !focused.isDestroyed()) {
      return focused;
    }
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) return win;
    }
    return null;
  }

  private startAutoSync(): void {
    if (!this.branchManager || this.store.safe || this.autoSyncTimer) return;
    const tick = () => {
      if (!this.branchManager || this.windows.size === 0) return;
      const activeWin = BrowserWindow.getFocusedWindow() ?? this.windows.values().next().value;
      const loadedChannel = activeWin
        ? this.store.getWindowChannel(activeWin.id)
        : this.store.activeChannel;
      void this.branchManager.syncAll({ loadedChannel }).catch(this.options.warn);
    };
    // Run an initial silent sync shortly after boot, then poll every 12s without auto-reloading.
    setTimeout(tick, 3_000).unref();
    this.autoSyncTimer = setInterval(tick, AUTO_SYNC_INTERVAL_MS);
    this.autoSyncTimer.unref();
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
    if (this.inspectorServer) {
      const inspector = this.inspectorServer;
      win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
        inspector.recordConsoleMessage(level, message, line, sourceId);
      });
    }
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

  daemonLaunchHooks() {
    const controller = this.daemonController;
    if (!controller) return {};
    return {
      resolveEditableDaemonLaunch: () => controller.resolveLaunchOverride(),
      onEditableDaemonStarted: (info: Parameters<EditableDaemonController["recordStarted"]>[0]) => {
        controller.recordStarted(info);
      },
    };
  }

  async useRecoveryRenderer(): Promise<void> {
    if (this.daemonController) {
      await this.daemonController.resetToBuiltIn().catch(this.options.warn);
    }
    await this.navigateFromMenu(this.store.useRecoveryRenderer(), "builtin");
  }

  async reloadLatestRenderer(): Promise<void> {
    await this.navigateFromMenu(this.store.reloadChannel({ fromMenu: true }), "prod");
  }

  async syncFromCloudShelf(): Promise<boolean> {
    if (this.store.safe) throw new Error("Editable renderer is disabled in safe renderer mode");
    this.cloudSync ??= syncFromCloudShelf({
      home: this.home,
      configHome: this.options.cloudShelfHome ?? this.home,
      publicKey: () => this.store.publicKey(),
      shouldInstall: (candidate) => this.store.shouldInstallCloudChannel(candidate),
    })
      .then(async (installed) => {
        if (installed) await this.reloadLatestRenderer();
        return installed;
      })
      .finally(() => {
        this.cloudSync = undefined;
      });
    return this.cloudSync;
  }

  private async navigateFromMenu(release: RendererRelease, channel?: string): Promise<void> {
    const focused = BrowserWindow.getFocusedWindow();
    const win =
      focused && this.windows.has(focused.webContents.id)
        ? focused
        : this.windows.values().next().value;
    this.useExportedRenderer = true;
    if (win) await this.navigate(win, release, undefined, channel);
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

  private navigate(
    win: BrowserWindow,
    release: RendererRelease,
    route?: string,
    channel?: string,
  ): Promise<void> {
    if (win.isDestroyed()) return Promise.resolve();
    this.useExportedRenderer = true;
    const nextRoute = route ?? this.currentRoute(win);
    const nextChannel = channel ?? this.store.getWindowChannel(win.id);
    const url = rendererNavigationUrl(nextRoute, release);
    const attempt: LoadAttempt = {
      release,
      channel: nextChannel,
      route: nextRoute,
      ready: false,
      loaded: Promise.resolve(),
      controller: new AbortController(),
    };
    this.attempts.get(win)?.controller.abort();
    this.store.pin(win.id, release, nextChannel);
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
