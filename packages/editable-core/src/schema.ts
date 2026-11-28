import { z } from "zod";

export const EDITABLE_STATE_SCHEMA_VERSION = 1 as const;
export const EDITABLE_READER_VERSION = 1 as const;

export type OnDiskVersionCheck =
  | { ok: true; schemaVersion: number; minReaderVersion: number }
  | {
      ok: false;
      reason: "invalid" | "reader_too_old";
      schemaVersion?: number;
      minReaderVersion?: number;
      message: string;
    };

export class IncompatibleStateError extends Error {
  readonly reason: "invalid" | "reader_too_old";
  readonly schemaVersion?: number;
  readonly minReaderVersion?: number;

  constructor(check: Extract<OnDiskVersionCheck, { ok: false }>) {
    super(check.message);
    this.name = "IncompatibleStateError";
    this.reason = check.reason;
    this.schemaVersion = check.schemaVersion;
    this.minReaderVersion = check.minReaderVersion;
  }
}

/**
 * Checks whether an on-disk JSON record can be safely read by this reader version.
 * Unknown newer `schemaVersion` or `minReaderVersion > readerVersion` returns
 * `reason: "reader_too_old"` so recovery can boot bundled without clobbering state.
 */
export function checkOnDiskVersion(
  raw: unknown,
  readerVersion: number = EDITABLE_READER_VERSION,
): OnDiskVersionCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, reason: "invalid", message: "State payload must be a JSON object" };
  }
  const obj = raw as Record<string, unknown>;
  const schemaVersion = obj.schemaVersion;
  if (typeof schemaVersion !== "number" || !Number.isInteger(schemaVersion) || schemaVersion < 1) {
    return {
      ok: false,
      reason: "invalid",
      message: `Invalid schemaVersion: ${String(schemaVersion)}`,
    };
  }
  const rawMinReader = obj.minReaderVersion;
  if (
    rawMinReader !== undefined &&
    (typeof rawMinReader !== "number" || !Number.isInteger(rawMinReader) || rawMinReader < 1)
  ) {
    return {
      ok: false,
      reason: "invalid",
      schemaVersion,
      message: `Invalid minReaderVersion: ${String(rawMinReader)}`,
    };
  }
  const minReaderVersion = rawMinReader ?? schemaVersion;
  if (minReaderVersion > readerVersion) {
    return {
      ok: false,
      reason: "reader_too_old",
      schemaVersion,
      minReaderVersion,
      message: `On-disk state requires reader version >= ${minReaderVersion} (schemaVersion=${schemaVersion}), but this reader supports up to ${readerVersion}`,
    };
  }
  return { ok: true, schemaVersion, minReaderVersion };
}

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
export const editableServiceSchema = z.enum(["ui", "daemon", "desktop", "ios"]);
export type EditableService = z.infer<typeof editableServiceSchema>;

const sourceShaSchema = z.string().regex(/^[a-f0-9]{40}$/);
const timestampSchema = z.iso.datetime({ offset: true });
const summarySchema = z.string().max(200);
const channelNameSchema = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);
const slugNameSchema = z.string().regex(/^[a-z0-9][a-z0-9-_]{0,47}$/);
const readerVersionField = z.number().int().positive().max(EDITABLE_READER_VERSION).optional();

export const releaseFileEntrySchema = z.object({
  path: z.string().min(1),
  sha256: digestSchema,
  bytes: z.number().int().nonnegative(),
});

export const releaseManifestSchema = z.object({
  schemaVersion: z.literal(EDITABLE_STATE_SCHEMA_VERSION),
  minReaderVersion: readerVersionField,
  kind: z.literal("release"),
  surface: z.enum(["electron-web", "ios-ota", "daemon"]),
  releaseDigest: digestSchema,
  sourceSha: sourceShaSchema,
  runtimeVersion: z.string().min(1),
  archiveSha256: digestSchema,
  archiveBytes: z.number().int().nonnegative(),
  files: z.array(releaseFileEntrySchema),
  summary: summarySchema,
  createdAt: timestampSchema,
});

const channelPointerSchema = z.object({
  releaseDigest: digestSchema,
  sourceSha: sourceShaSchema,
  runtimeVersion: z.string().min(1),
  archiveUrl: z.string(),
  manifestUrl: z.string(),
  summary: summarySchema,
  updatedAt: timestampSchema,
});

export const channelManifestSchema = z.object({
  schemaVersion: z.literal(EDITABLE_STATE_SCHEMA_VERSION),
  minReaderVersion: readerVersionField,
  kind: z.literal("channel"),
  channel: channelNameSchema,
  generation: z.number().int().positive(),
  updatedAt: timestampSchema,
  surfaces: z.object({
    "electron-web": channelPointerSchema.optional(),
    "ios-ota": channelPointerSchema.optional(),
    daemon: channelPointerSchema.optional(),
  }),
});

export const wipBranchPointerSchema = z.object({
  slug: slugNameSchema,
  branch: z.string().startsWith("ed/wip/"),
  channel: channelNameSchema,
  title: z.string().max(120).nullable().optional(),
  icon: z.string().max(32).nullable().optional(),
  releaseDigest: digestSchema.nullable(),
  daemonReleaseDigest: digestSchema.nullable().optional(),
  services: z.array(editableServiceSchema).optional(),
  sourceSha: sourceShaSchema,
  summary: summarySchema,
  requiresDaemon: z.boolean(),
  requiresNative: z.boolean(),
  updatedAt: timestampSchema,
});

export const wipIndexSchema = z.object({
  schemaVersion: z.literal(EDITABLE_STATE_SCHEMA_VERSION),
  minReaderVersion: readerVersionField,
  kind: z.literal("wip-index"),
  generation: z.number().int().positive(),
  updatedAt: timestampSchema,
  branches: z.array(wipBranchPointerSchema),
});

export const deviceStateSchema = z.object({
  schemaVersion: z.literal(EDITABLE_STATE_SCHEMA_VERSION),
  minReaderVersion: readerVersionField,
  activeDigest: digestSchema.nullable(),
  lastKnownGoodDigest: digestSchema.nullable(),
  quarantinedDigests: z.array(digestSchema),
  previewUrl: z.string().nullable(),
  activeGeneration: z.number().int().nonnegative(),
  activeChannel: channelNameSchema.optional(),
  activeDaemonDigest: digestSchema.nullable().optional(),
  lastKnownGoodDaemonDigest: digestSchema.nullable().optional(),
  quarantinedDaemonDigests: z.array(digestSchema).optional(),
  activeDaemonGeneration: z.number().int().nonnegative().optional(),
});

export type DeviceState = z.infer<typeof deviceStateSchema>;
export type WipBranchPointer = z.infer<typeof wipBranchPointerSchema>;
export type WipIndexPayload = z.infer<typeof wipIndexSchema>;
export type WipIndex = WipIndexPayload;
export type ChannelSurfacePointer = z.infer<typeof channelPointerSchema>;
export type ChannelManifestPayload = z.infer<typeof channelManifestSchema>;
export type ReleaseFileEntry = z.infer<typeof releaseFileEntrySchema>;
export type ReleaseManifestPayload = z.infer<typeof releaseManifestSchema>;
