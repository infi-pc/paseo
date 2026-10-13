import { parseCopiedTranscript } from "@getpaseo/protocol/transcript";
import {
  createMarkdownClipboardContent,
  type MarkdownClipboardContent,
} from "@/utils/rich-clipboard";

export function createTranscriptClipboardContent(text: string): MarkdownClipboardContent {
  const transcript = parseCopiedTranscript(text);
  if (!transcript) throw new Error("Invalid transcript export");
  const { title, cwd } = transcript.metadata;
  const readable = `# Paseo transcript\n\nChat: ${title}\n\nSource directory: ${cwd}\n\n${transcript.body}`;
  return { plainText: text, html: createMarkdownClipboardContent(readable).html };
}
