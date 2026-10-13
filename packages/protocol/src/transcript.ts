import { z } from "zod";

// FORK(transcript-clipboard): reject oversized snapshots rather than silently losing history.
export const MAX_TRANSCRIPT_CHARS = 2_000_000;
export const TRANSCRIPT_CHUNK_CHARS = 16_384;

export const TranscriptSourceSchema = z.object({
  serverId: z.string(),
  agentId: z.string(),
  boundaryMessageId: z.string().nullable().optional(),
  boundaryCursor: z
    .object({ epoch: z.string(), seq: z.number().int().nonnegative() })
    .nullable()
    .optional(),
});

const TranscriptMetadataSchema = z.object({
  title: z.string().max(1_000),
  cwd: z.string().max(1_000),
  source: TranscriptSourceSchema,
});

export type TranscriptMetadata = z.infer<typeof TranscriptMetadataSchema>;
export interface CopiedTranscript {
  metadata: TranscriptMetadata;
  body: string;
}

const PREFIX = "# Paseo transcript\n\n<!-- paseo-transcript:v1 ";
const SEPARATOR = " -->\n\n";
const SUFFIX = "\n\n<!-- /paseo-transcript:v1 -->";

export class TranscriptTooLargeError extends Error {
  constructor() {
    super("This transcript is too large to copy. Copy up to an earlier response instead.");
    this.name = "TranscriptTooLargeError";
  }
}

export function formatCopiedTranscript(transcript: CopiedTranscript): string {
  const encoded =
    PREFIX + JSON.stringify(transcript.metadata) + SEPARATOR + transcript.body + SUFFIX;
  if (encoded.length > MAX_TRANSCRIPT_CHARS) throw new TranscriptTooLargeError();
  return encoded;
}

export function parseCopiedTranscript(text: string): CopiedTranscript | null {
  if (text.length > MAX_TRANSCRIPT_CHARS * 2) return null;
  const normalized = text.replace(/\r\n/g, "\n").trim();
  if (normalized.length > MAX_TRANSCRIPT_CHARS) return null;
  if (!normalized.startsWith(PREFIX) || !normalized.endsWith(SUFFIX)) return null;
  const separator = normalized.indexOf(SEPARATOR, PREFIX.length);
  if (separator < 0) return null;
  let metadata: unknown;
  try {
    metadata = JSON.parse(normalized.slice(PREFIX.length, separator));
  } catch {
    return null;
  }
  const parsed = TranscriptMetadataSchema.safeParse(metadata);
  if (!parsed.success) return null;
  const body = normalized.slice(separator + SEPARATOR.length, -SUFFIX.length);
  return { metadata: parsed.data, body };
}
