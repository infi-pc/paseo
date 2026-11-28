import {
  channelManifestSchema,
  checkOnDiskVersion,
  releaseManifestSchema,
  wipIndexSchema,
  type ChannelManifestPayload,
  type EditableService,
  type ReleaseManifestPayload,
  type WipIndexPayload,
} from "./schema.js";

export const DESKTOP_RUNTIME_VERSION = "desktop-1" as const;
export const DAEMON_RUNTIME_VERSION = "daemon-1" as const;
export const DAEMON_ENTRYPOINT_REL_PATH =
  "node_modules/@getpaseo/server/dist/scripts/supervisor-entrypoint.js" as const;

export type ReleaseSurface = "electron-web" | "ios-ota" | "daemon";
export type EditableReleaseSurface = "electron-web" | "daemon";

export interface SignedEnvelope<T> {
  payload: T;
  signature: string;
  keyId: string;
}

export function wipChannelName(slug: string): string {
  return `wip-${slug.trim().toLowerCase()}`;
}

export interface EditableConfig {
  schemaVersion: 1;
  minReaderVersion?: number;
  sourceRepoUrl: string;
  baseBranch: string;
  workshopHome: string;
  workshopPort: number;
  desktopRuntimeVersion: string;
  daemonRuntimeVersion?: string;
  cloudShelfUrl: string | null;
  channel: string;
  autoPush?: boolean;
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

export type ImpactSurface =
  | "electron-web"
  | "ios-ota"
  | "daemon-cli"
  | "native-desktop"
  | "native-ios"
  | "plugins"
  | "editable-cli"
  | "cloud-shelf"
  | "docs-only";

export interface ImpactPlan {
  changedFiles: string[];
  surfaces: ImpactSurface[];
  services: EditableService[];
  buildSteps: string[];
  verifySteps: string[];
  requiresNativeRebuild: boolean;
  requiresDaemonRelease: boolean;
  canPublishElectronRenderer: boolean;
  canPublishDaemon: boolean;
  canPublishIosOta: boolean;
  warnings: string[];
}

/**
 * Rejects leading/trailing slashes, backslashes, colons, control chars,
 * `.` / `..` segments, and Windows trailing dots/spaces.
 */
export function isSafeRelativePath(value: string): boolean {
  if (!value || /[\\:\p{Cc}]/u.test(value)) return false;
  return value.split("/").every((part) => part !== "" && !/[. ]$/.test(part));
}

export function parseReleaseManifest(
  payload: unknown,
  expectedSurface: EditableReleaseSurface = "electron-web",
): ReleaseManifestPayload {
  const version = checkOnDiskVersion(payload);
  if (!version.ok) {
    throw new Error(version.message);
  }
  const parsed = releaseManifestSchema.parse(payload);
  if (parsed.surface !== expectedSurface) {
    throw new Error("Unexpected release surface");
  }
  return parsed;
}

export function validateReleaseManifestPayload(
  value: unknown,
): { ok: true; value: ReleaseManifestPayload } | { ok: false; error: string } {
  const version = checkOnDiskVersion(value);
  if (!version.ok) {
    return { ok: false, error: version.message };
  }
  const parsed = releaseManifestSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid release manifest" };
  }
  const manifest = parsed.data;
  if (manifest.files.length === 0) {
    return { ok: false, error: "files must be a non-empty array" };
  }
  let prevPath: string | null = null;
  for (const entry of manifest.files) {
    if (!isSafeRelativePath(entry.path)) {
      return { ok: false, error: `Unsafe or invalid file path: ${entry.path}` };
    }
    if (prevPath !== null && entry.path <= prevPath) {
      return {
        ok: false,
        error: `files must be strictly sorted and unique (collision at ${entry.path})`,
      };
    }
    prevPath = entry.path;
  }
  return { ok: true, value: manifest };
}

export function validateChannelManifestPayload(
  value: unknown,
): { ok: true; value: ChannelManifestPayload } | { ok: false; error: string } {
  const version = checkOnDiskVersion(value);
  if (!version.ok) {
    return { ok: false, error: version.message };
  }
  const parsed = channelManifestSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid channel manifest" };
  }
  return { ok: true, value: parsed.data };
}

export function validateWipIndexPayload(
  value: unknown,
): { ok: true; value: WipIndexPayload } | { ok: false; error: string } {
  const version = checkOnDiskVersion(value);
  if (!version.ok) {
    return { ok: false, error: version.message };
  }
  const parsed = wipIndexSchema.safeParse(value);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid WIP index manifest" };
  }
  return { ok: true, value: parsed.data };
}
