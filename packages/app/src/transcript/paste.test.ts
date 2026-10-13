import { describe, expect, it } from "vitest";
import { formatCopiedTranscript, parseCopiedTranscript } from "@getpaseo/protocol/transcript";
import { createTranscriptAttachment } from "./attachment";
import { findTranscriptInsertion } from "./paste";
import { createTranscriptClipboardContent } from "./clipboard";
import { CanonicalDraftInputSchema } from "@/stores/draft-store/state";
import { splitComposerAttachmentsForSubmit } from "@/composer/attachments/submit";

const transcript = {
  metadata: {
    title: "Source chat",
    cwd: "/source",
    source: { serverId: "other-host", agentId: "source-agent" },
  },
  body: "## User\n\nOriginal prompt\n\n## Assistant\n\n**Answer**\n\n```ts\nconst x = 1;\n```",
};
const copied = formatCopiedTranscript(transcript);

describe("pasted transcript", () => {
  it("persists a self-contained draft attachment and submits it as fork context", () => {
    const attachment = createTranscriptAttachment({
      transcript,
      id: "copied-1",
      title: "Transcript · Source chat",
    });
    const draft = CanonicalDraftInputSchema.parse(
      JSON.parse(JSON.stringify({ text: "Use this context", attachments: [attachment] })),
    );
    expect(draft).toEqual({ text: "Use this context", attachments: [attachment] });
    expect(splitComposerAttachmentsForSubmit(draft.attachments)).toEqual({
      images: [],
      attachments: [attachment.attachment],
    });
    expect(attachment.attachment.text).toContain(transcript.body);
  });

  it("recognizes native insertion or replacement without changing the surrounding draft", () => {
    expect(findTranscriptInsertion("Before After", "Before " + copied + "After")).toEqual({
      text: copied,
      start: 7,
      end: 7,
    });
    expect(findTranscriptInsertion("Before selected After", "Before " + copied + " After")).toEqual(
      { text: copied, start: 7, end: 15 },
    );
    expect(findTranscriptInsertion("Draft", "Draft plus ordinary text")).toBeNull();
    expect(parseCopiedTranscript("# Paseo transcript\n\nOrdinary text")).toBeNull();
  });

  it("pastes readable formatted HTML elsewhere without transport metadata", () => {
    const content = createTranscriptClipboardContent(copied);
    expect(content.plainText).toBe(copied);
    expect(content.html).toContain("Source chat");
    expect(content.html).toContain("<strong>Answer</strong>");
    expect(content.html).toContain('class="language-ts"');
    expect(content.html).not.toContain("paseo-transcript:v1");
    expect(content.html).not.toContain("source-agent");
  });
});
