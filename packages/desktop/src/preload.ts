import { contextBridge, ipcRenderer, webUtils } from "electron";
// FORK(locator-compose): source links target the remembered worktree composer.
import type { DesktopNavigationTarget } from "@getpaseo/protocol/compose-deep-link";
import type { BrowserKeyboardPolicy } from "./features/browser-keyboard/index.js";
import type { DesktopWindowChromeMode } from "./window/chrome.js";
// FORK(editable): status typing is erased from the sandboxed preload.
import type {
  CreateBranchResult,
  EditableBranchesSnapshot,
  ShipBranchResult,
} from "./editable/branches.js";
import type { EditableDesktopStatus } from "./editable/release-store.js";
import type { EditableWorkshopDaemonStatus } from "./editable/workshop-daemon.js";

// This preload runs in Electron's sandbox and is tsc-compiled (not bundled), so it MUST
// NOT emit any runtime module load other than "electron" — a require() of a local or
// third-party module throws and aborts the preload before exposeInMainWorld runs, leaving
// window.paseoDesktop undefined (the 0.1.108 regression, #2103). Keep this literal in sync
// with PASEO_BROWSER_PROFILE_PARTITION in features/browser-profile.ts; preload-sandbox.test.ts
// guards both the no-local-import rule and this drift. Type-only imports are fine (erased at emit).
const PASEO_BROWSER_PROFILE_PARTITION = "persist:paseo-browser";

type EventHandler = (payload: unknown) => void;

function readArgValue(prefix: string): string | undefined {
  return process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function readWindowChromeMode(): DesktopWindowChromeMode {
  const prefix = "--paseo-window-chrome-mode=";
  const value = process.argv.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
  if (value === "native-mac" || value === "custom-windows" || value === "custom-linux") {
    return value;
  }
  // COMPAT(windowChromeMode): added in v0.5.3; remove after 2026-11-25.
  if (process.platform === "darwin") return "native-mac";
  return process.platform === "linux" ? "custom-linux" : "custom-windows";
}

interface AttachedBrowserRegistration {
  browserId: string;
  workspaceId: string;
  webContentsId: number;
}

contextBridge.exposeInMainWorld("paseoDesktop", {
  platform: process.platform,
  windowChromeMode: readWindowChromeMode(),
  browserHostLabel: readArgValue("--paseo-browser-host-label="),
  browserHostInstanceId: readArgValue("--paseo-browser-host-instance-id="),
  invoke: (command: string, args?: Record<string, unknown>) =>
    ipcRenderer.invoke("paseo:invoke", command, args),
  getPendingOpenProject: () =>
    ipcRenderer.invoke("paseo:get-pending-open-project") as Promise<string | null>,
  agentNavigation: {
    ready: () =>
      ipcRenderer.invoke("paseo:agent-navigation:ready") as Promise<DesktopNavigationTarget | null>,
  },
  // FORK(editable): keep the sandbox bridge limited to explicit invokes.
  editable: {
    getStatus: (): Promise<EditableDesktopStatus> => ipcRenderer.invoke("paseo:editable:getStatus"),
    switchRelease: (digest: string | null): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("paseo:editable:switchRelease", digest),
    useRecoveryRenderer: (): Promise<void> =>
      ipcRenderer.invoke("paseo:editable:useRecoveryRenderer"),
    setPreviewUrl: (url: string | null): Promise<void> =>
      ipcRenderer.invoke("paseo:editable:setPreviewUrl", url),
    openPreviewWindow: (url: string): Promise<void> =>
      ipcRenderer.invoke("paseo:editable:openPreviewWindow", url),
    reportHealthy: (digest: string): Promise<void> =>
      ipcRenderer.invoke("paseo:editable:reportHealthy", digest),
    syncFromCloudShelf: (): Promise<{ ok: boolean; updated?: boolean; error?: string }> =>
      ipcRenderer.invoke("paseo:editable:syncFromCloudShelf"),
    syncNow: (): Promise<{ ok: boolean; updated?: boolean; error?: string }> =>
      ipcRenderer.invoke("paseo:editable:syncNow"),
    getBranches: (): Promise<EditableBranchesSnapshot | null> =>
      ipcRenderer.invoke("paseo:editable:getBranches"),
    loadBranch: (channel: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("paseo:editable:loadBranch", channel),
    shipBranch: (slug: string): Promise<ShipBranchResult & { autoLoaded?: boolean }> =>
      ipcRenderer.invoke("paseo:editable:shipBranch", slug),
    createBranch: (input: {
      slug: string;
      summary?: string;
      agentId?: string;
    }): Promise<CreateBranchResult> => ipcRenderer.invoke("paseo:editable:createBranch", input),
    attachBranchAgent: (slug: string, agentId: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("paseo:editable:attachBranchAgent", slug, agentId),
    discardBranch: (slug: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke("paseo:editable:discardBranch", slug),
    getWorkshopStatus: (): Promise<EditableWorkshopDaemonStatus | null> =>
      ipcRenderer.invoke("paseo:editable:getWorkshopStatus"),
    startWorkshopDaemon: (): Promise<EditableWorkshopDaemonStatus> =>
      ipcRenderer.invoke("paseo:editable:startWorkshopDaemon"),
  },
  events: {
    on: (event: string, handler: EventHandler): Promise<() => void> => {
      const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
        handler(payload);
      };
      ipcRenderer.on(`paseo:event:${event}`, listener);
      return Promise.resolve(() => {
        ipcRenderer.removeListener(`paseo:event:${event}`, listener);
      });
    },
  },
  window: {
    openNew: (options?: { pendingOpenProjectPath?: string | null }) =>
      ipcRenderer.invoke("paseo:window:openNew", options),
    getCurrentWindow: () => ({
      minimize: () => ipcRenderer.invoke("paseo:window:minimize"),
      close: () => ipcRenderer.invoke("paseo:window:close"),
      toggleMaximize: () => ipcRenderer.invoke("paseo:window:toggleMaximize"),
      isMaximized: () => ipcRenderer.invoke("paseo:window:isMaximized"),
      setFullscreen: (fullscreen: boolean) =>
        ipcRenderer.invoke("paseo:window:setFullscreen", fullscreen),
      isFullscreen: () => ipcRenderer.invoke("paseo:window:isFullscreen"),
      updateChrome: (update: { backgroundColor?: string; trafficLightOffsetY?: number }) =>
        ipcRenderer.invoke("paseo:window:updateChrome", update),
      onResized: (handler: EventHandler): (() => void) => {
        const listener = (_ipcEvent: Electron.IpcRendererEvent, payload: unknown) => {
          handler(payload);
        };
        ipcRenderer.on("paseo:window:resized", listener);
        return () => {
          ipcRenderer.removeListener("paseo:window:resized", listener);
        };
      },
      setBadgeCount: (count?: number) => ipcRenderer.invoke("paseo:window:setBadgeCount", count),
    }),
  },
  dialog: {
    ask: (message: string, options?: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:dialog:ask", message, options),
    askWithCheckbox: (message: string, options: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:dialog:askWithCheckbox", message, options),
    open: (options?: Record<string, unknown>) => ipcRenderer.invoke("paseo:dialog:open", options),
  },
  notification: {
    isSupported: () => ipcRenderer.invoke("paseo:notification:isSupported"),
    sendNotification: (payload: { title: string; body?: string; data?: Record<string, unknown> }) =>
      ipcRenderer.invoke("paseo:notification:send", payload),
  },
  opener: {
    openUrl: (url: string) => ipcRenderer.invoke("paseo:opener:openUrl", url),
  },
  editor: {
    listTargets: (input?: { workspacePath?: string }) =>
      ipcRenderer.invoke("paseo:editor:listTargets", input),
    openTarget: (input: {
      editorId: string;
      workspacePath: string;
      filePath?: string;
      line?: number;
      column?: number;
    }) => ipcRenderer.invoke("paseo:editor:openTarget", input),
  },
  webUtils: {
    getPathForFile: (file: File) => webUtils.getPathForFile(file),
  },
  menu: {
    showContextMenu: (input?: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:menu:showContextMenu", input),
    setCapturingShortcut: (capturing: boolean) =>
      ipcRenderer.invoke("paseo:menu:set-capturing-shortcut", capturing),
  },
  browser: {
    setShortcutPolicy: (input: BrowserKeyboardPolicy) =>
      ipcRenderer.invoke("paseo:browser:set-shortcut-policy", input),
    profilePartition: PASEO_BROWSER_PROFILE_PARTITION,
    registerAttachedBrowser: (input: AttachedBrowserRegistration) =>
      ipcRenderer.invoke("paseo:browser:register-attached", input),
    unregisterWorkspaceBrowser: (browserId: string) =>
      ipcRenderer.invoke("paseo:browser:unregister-workspace-browser", browserId),
    setWorkspaceActiveBrowser: (input: { workspaceId: string; browserId: string | null }) =>
      ipcRenderer.invoke("paseo:browser:set-workspace-active-browser", input),
    focus: (browserId: string) => ipcRenderer.invoke("paseo:browser:focus", browserId),
    openDevTools: (browserId: string) =>
      ipcRenderer.invoke("paseo:browser:open-devtools", browserId),
    clearProfile: (legacyBrowserIds: string[]) =>
      ipcRenderer.invoke("paseo:browser:clear-profile", legacyBrowserIds),
    executeAutomationCommand: (request: Record<string, unknown>) =>
      ipcRenderer.invoke("paseo:browser:execute-automation-command", request),
    captureElement: (
      browserId: string,
      rect: { x: number; y: number; width: number; height: number },
    ) => ipcRenderer.invoke("paseo:browser:capture-element", browserId, rect),
    copyElement: (payload: { text?: string; imageDataUrl?: string }) =>
      ipcRenderer.invoke("paseo:browser:copy-element", payload),
  },
});
