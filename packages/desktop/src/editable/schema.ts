import { z } from "zod";

export const digestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSha = z.string().regex(/^[a-f0-9]{40}$/);
const timestamp = z.iso.datetime({ offset: true });
const summary = z.string().max(200);
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
  channel: z.string(),
  generation: z.number().int().positive(),
  updatedAt: timestamp,
  surfaces: z.object({
    "electron-web": channelPointer.optional(),
    "ios-ota": channelPointer.optional(),
  }),
});

export const deviceStateSchema = z.object({
  schemaVersion: z.literal(1),
  activeDigest: digestSchema.nullable(),
  lastKnownGoodDigest: digestSchema.nullable(),
  quarantinedDigests: z.array(digestSchema),
  previewUrl: z.string().nullable(),
  activeGeneration: z.number().int().nonnegative(),
});

export type DeviceState = z.infer<typeof deviceStateSchema>;
