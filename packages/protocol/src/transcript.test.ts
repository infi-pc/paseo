import { describe, expect, it } from "vitest";
import {
  formatCopiedTranscript,
  MAX_TRANSCRIPT_CHARS,
  parseCopiedTranscript,
  TranscriptTooLargeError,
} from "./transcript.js";

const transcript = {
  metadata: { title: "A chat 🦩", cwd: "/repo", source: { serverId: "host", agentId: "agent" } },
  body: "## User\n\nHello\n\n## Assistant\n\n```ts\nconst x = '<tag>';\n```\n",
};

describe("portable transcript", () => {
  it("round trips complete messages, code, Unicode, and trailing whitespace", () => {
    const copied = formatCopiedTranscript(transcript);
    expect(parseCopiedTranscript(copied)).toEqual(transcript);
    expect(parseCopiedTranscript(copied.replace(/\n/g, "\r\n"))).toEqual(transcript);
  });

  it("does not treat ordinary messages, partial copies, or unknown versions as transcripts", () => {
    const copied = formatCopiedTranscript(transcript);
    expect(parseCopiedTranscript(transcript.body)).toBeNull();
    expect(parseCopiedTranscript(copied.slice(0, -10))).toBeNull();
    expect(parseCopiedTranscript(copied.replaceAll("transcript:v1", "transcript:v2"))).toBeNull();
    expect(parseCopiedTranscript(copied.replace('"agentId":"agent"', '"agentId":42'))).toBeNull();
  });

  it("keeps nested transcript markers and large conversations intact", () => {
    const nested = {
      ...transcript,
      body: formatCopiedTranscript(transcript) + "x".repeat(110_000),
    };
    expect(parseCopiedTranscript(formatCopiedTranscript(nested))).toEqual(nested);
  });

  it("refuses oversized exports instead of clipping old messages", () => {
    expect(() =>
      formatCopiedTranscript({ ...transcript, body: "x".repeat(MAX_TRANSCRIPT_CHARS) }),
    ).toThrow(TranscriptTooLargeError);
  });
});
