export interface EditableHealthDigest {
  recentErrors: number;
  latestError: string | null;
  recentWarnings: number;
  recentFailedRequests: number;
  recentLongTasks: number;
  maxLongTaskMs: number | null;
}

export interface EditableElementSnapshot {
  react: Array<{
    name: string;
    source: string | null;
    props: Record<string, unknown>;
    hooks: unknown[];
  }>;
  dom: {
    tag: string;
    role: string | null;
    rect: { x: number; y: number; width: number; height: number };
    overflow: {
      horizontal: boolean;
      vertical: boolean;
      scrollWidth: number;
      clientWidth: number;
      scrollHeight: number;
      clientHeight: number;
    };
    styles: Record<string, string>;
    text: string | null;
    ancestors: Array<{
      tag: string;
      comp: string | null;
      src: string | null;
      rect: { x: number; y: number; width: number; height: number };
      styles: Record<string, string>;
    }>;
    children: unknown[];
  };
  viewport: {
    width: number;
    height: number;
    dpr: number;
    scrollX: number;
    scrollY: number;
  };
  theme: string | null;
  density: string | null;
  health?: EditableHealthDigest;
}

export interface EditableScreenshotAttachment {
  data: string;
  mimeType: "image/png";
}

export interface EditableReferencedElement {
  id: string;
  label: string;
  locator: EditableLocatorContext;
  snapshot: EditableElementSnapshot | null;
  screenshot: EditableScreenshotAttachment | null;
}

export interface EditableScreenshotResult {
  ok: boolean;
  dataBase64?: string;
  mimeType?: "image/png";
  width?: number;
  height?: number;
  error?: string;
}

export interface EditableLocatorContext {
  file: string;
  line: number | null;
  column: number | null;
  componentName: string | null;
  route: string;
  releaseDigest: string | null;
  platform: "electron" | "web" | "ios" | "android";
}

export interface EditableWorkshopDaemonStatus {
  status: "running" | "starting" | "stopped" | "errored";
  serverId: string | null;
  listen: string;
  pid: number | null;
  home: string;
  repoDir: string;
  worktrees: string[];
  error: string | null;
}

export type EditableService = "ui" | "daemon" | "desktop" | "ios";

export interface EditableBranchEntry {
  slug: string;
  channel: string;
  branch: string;
  isMain: boolean;
  status: "ready" | "working" | "draft" | "idle" | "shipping" | "failed";
  summary: string | null;
  releaseDigest: string | null;
  daemonReleaseDigest?: string | null;
  services?: EditableService[];
  generation: number | null;
  sourceSha: string | null;
  hasChanges?: boolean;
  behindMain: boolean;
  canFastForward: boolean;
  requiresDaemon: boolean;
  hasUpdate: boolean;
  hasUiUpdate?: boolean;
  hasDaemonUpdate?: boolean;
  requiresDaemonRestartOnLoad?: boolean;
  loaded: boolean;
  remoteOnly: boolean;
  agentId: string | null;
  error: string | null;
  updatedAt: string | null;
}

export interface EditableBranchesSnapshot {
  loadedChannel: string;
  loadedDigest: string | null;
  loadedDaemonDigest?: string | null;
  daemonRunning?: boolean;
  daemonListen?: string | null;
  mainDaemonGeneration?: number | null;
  safeRenderer: boolean;
  main: EditableBranchEntry;
  branches: EditableBranchEntry[];
}

export interface EditableCreateBranchResult {
  ok: boolean;
  slug?: string;
  branch?: string;
  worktreePath?: string;
  error?: string;
}

export interface EditableShipBranchResult {
  ok: boolean;
  fastForwarded?: boolean;
  autoLoaded?: boolean;
  releaseDigest?: string | null;
  daemonReleaseDigest?: string | null;
  generation?: number;
  error?: string;
}

export interface EditableDesktopStatus {
  runtimeVersion: string;
  daemonRuntimeVersion?: string;
  activeDigest: string | null;
  activeDaemonDigest?: string | null;
  releaseDigest: string | null;
  availableDigest: string | null;
  availableDaemonDigest?: string | null;
  lastKnownGoodDigest: string | null;
  quarantinedDigests: string[];
  previewUrl: string | null;
  activeGeneration: number;
  safeRenderer: boolean;
  releaseSummary?: string | null;
  activeChannel?: string;
  availableSummary?: string | null;
}

export interface EditableDesktopBridge {
  getStatus(): Promise<EditableDesktopStatus>;
  switchRelease(digest: string | null): Promise<{ ok: boolean; error?: string }>;
  useRecoveryRenderer(): Promise<void>;
  setPreviewUrl(url: string | null): Promise<void>;
  openPreviewWindow(url: string): Promise<void>;
  reportHealthy(releaseDigest: string): Promise<void>;
  syncFromCloudShelf?: () => Promise<{ ok: boolean; updated?: boolean; error?: string }>;
  syncNow?: () => Promise<{ ok: boolean; updated?: boolean; error?: string }>;
  getBranches?: () => Promise<EditableBranchesSnapshot | null>;
  loadBranch?: (
    channel: string,
  ) => Promise<{ ok: boolean; uiChanged?: boolean; daemonSwapped?: boolean; error?: string }>;
  shipBranch?: (slug: string) => Promise<EditableShipBranchResult>;
  createBranch?: (input: {
    slug: string;
    summary?: string;
    agentId?: string;
  }) => Promise<EditableCreateBranchResult>;
  attachBranchAgent?: (slug: string, agentId: string) => Promise<{ ok: boolean; error?: string }>;
  captureScreenshot?: (input?: {
    rect?: { x: number; y: number; width: number; height: number } | null;
    full?: boolean;
    padding?: number;
  }) => Promise<EditableScreenshotResult>;
  discardBranch?: (slug: string) => Promise<{ ok: boolean; error?: string }>;
  getWorkshopStatus?: () => Promise<EditableWorkshopDaemonStatus | null>;
  startWorkshopDaemon?: () => Promise<EditableWorkshopDaemonStatus>;
}

declare module "@/desktop/host" {
  interface DesktopHostBridge {
    editable?: EditableDesktopBridge;
  }
}

export interface EditableBranchAgentRecord {
  slug: string;
  agentId: string;
  request: string;
  createdAt: string;
}

export interface EditableWorkshopConfig {
  workshopHostId: string | null;
  workshopCwd: string | null;
  workshopAgentId: string | null;
  lastRequest?: string | null;
  branchAgents?: Record<string, EditableBranchAgentRecord>;
  enabled: boolean;
}

export type EditableRouteContext = Pick<
  EditableLocatorContext,
  "route" | "releaseDigest" | "platform"
>;

export function routeLocatorContext({
  route,
  releaseDigest,
  platform,
}: EditableRouteContext): EditableLocatorContext {
  return {
    file: "",
    line: null,
    column: null,
    componentName: null,
    route: route.split(/[?#]/, 1)[0],
    releaseDigest: /^[a-f0-9]{64}$/.test(releaseDigest ?? "") ? releaseDigest : null,
    platform,
  };
}
