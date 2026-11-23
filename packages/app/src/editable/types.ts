export interface EditableLocatorContext {
  file: string;
  line: number | null;
  column: number | null;
  componentName: string | null;
  route: string;
  releaseDigest: string | null;
  platform: "electron" | "web" | "ios" | "android";
}

export interface EditableDesktopStatus {
  runtimeVersion: string;
  activeDigest: string | null;
  releaseDigest: string | null;
  availableDigest: string | null;
  lastKnownGoodDigest: string | null;
  quarantinedDigests: string[];
  previewUrl: string | null;
  activeGeneration: number;
  safeRenderer: boolean;
}

export interface EditableDesktopBridge {
  getStatus(): Promise<EditableDesktopStatus>;
  switchRelease(digest: string | null): Promise<{ ok: boolean; error?: string }>;
  useRecoveryRenderer(): Promise<void>;
  setPreviewUrl(url: string | null): Promise<void>;
  openPreviewWindow(url: string): Promise<void>;
  reportHealthy(releaseDigest: string): Promise<void>;
}

declare module "@/desktop/host" {
  interface DesktopHostBridge {
    editable?: EditableDesktopBridge;
  }
}

export interface EditableWorkshopConfig {
  workshopHostId: string | null;
  workshopCwd: string | null;
  workshopAgentId: string | null;
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
