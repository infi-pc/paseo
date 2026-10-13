import { z } from "zod";
import { TranscriptSourceSchema, type CopiedTranscript } from "@getpaseo/protocol/transcript";

// Clipboard context belongs to one persisted composer draft; fork/picker context remains workspace-owned.
export const TranscriptAttachmentSchema = z.strictObject({
  kind: z.literal("transcript"),
  id: z.string(),
  attachment: z.strictObject({
    type: z.literal("text"),
    mimeType: z.literal("text/plain"),
    contextKind: z.literal("chat_history"),
    title: z.string(),
    text: z.string(),
  }),
  source: TranscriptSourceSchema,
});

export type TranscriptAttachment = z.infer<typeof TranscriptAttachmentSchema>;

export function createTranscriptAttachment(input: {
  transcript: CopiedTranscript;
  id: string;
  title: string;
}): TranscriptAttachment {
  const { metadata, body } = input.transcript;
  return {
    kind: "transcript",
    id: input.id,
    source: metadata.source,
    attachment: {
      type: "text",
      mimeType: "text/plain",
      contextKind: "chat_history",
      title: input.title,
      text: `<chat-history-summary>\nChat history from a previous Paseo agent.\nSource agent: ${metadata.title}\nSource directory: ${metadata.cwd}\n\n${body}\n</chat-history-summary>`,
    },
  };
}
