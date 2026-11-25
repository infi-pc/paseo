import { z } from "zod";

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSha = z.string().regex(/^[a-f0-9]{40}$/);
const timestamp = z.iso.datetime({ offset: true });
const summary = z.string().max(200);
const channelName = z.string().regex(/^[a-z0-9][a-z0-9_-]{0,62}$/);
const slugName = z.string().regex(/^[a-z0-9][a-z0-9-_]{0,47}$/);

const channelPointer = z.object({
  releaseDigest: digestSchema,
  sourceSha,
  runtimeVersion: z.string(),
  archiveUrl: z.string(),
  manifestUrl: z.string(),
  summary,
  updatedAt: timestamp,
});

export const channelManifestSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("channel"),
  channel: channelName,
  generation: z.number().int().positive(),
  updatedAt: timestamp,
  surfaces: z.object({
    "electron-web": channelPointer.optional(),
    "ios-ota": channelPointer.optional(),
  }),
});

export const wipBranchPointerSchema = z.object({
  slug: slugName,
  branch: z.string().startsWith("ed/wip/"),
  channel: channelName,
  releaseDigest: digestSchema.nullable(),
  sourceSha,
  summary,
  requiresDaemon: z.boolean(),
  requiresNative: z.boolean(),
  updatedAt: timestamp,
});

export const wipIndexSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal("wip-index"),
  generation: z.number().int().positive(),
  updatedAt: timestamp,
  branches: z.array(wipBranchPointerSchema),
});

export const deviceStateSchema = z.object({
  schemaVersion: z.literal(1),
  activeDigest: digestSchema.nullable(),
  lastKnownGoodDigest: digestSchema.nullable(),
  quarantinedDigests: z.array(digestSchema),
  previewUrl: z.string().nullable(),
  activeGeneration: z.number().int().nonnegative(),
  activeChannel: channelName.optional(),
});

export type DeviceState = z.infer<typeof deviceStateSchema>;
export type WipBranchPointer = z.infer<typeof wipBranchPointerSchema>;
export type WipIndex = z.infer<typeof wipIndexSchema>;
