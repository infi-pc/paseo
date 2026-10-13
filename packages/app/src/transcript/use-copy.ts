import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { formatCopiedTranscript } from "@getpaseo/protocol/transcript";
import type { AgentForkContextOptions } from "@getpaseo/client/internal/daemon-client";
import { useToast } from "@/contexts/toast-context";
import { useSessionStore } from "@/stores/session-store";
import { useStableEvent } from "@/hooks/use-stable-event";
import { writeMarkdownToRichClipboard } from "@/utils/rich-clipboard";
import { getDefaultMarkdownClipboardEnvironment } from "@/utils/rich-clipboard-default-environment";
import { createTranscriptClipboardContent } from "./clipboard";

export interface TranscriptCopySource {
  serverId: string;
  agentId: string;
  boundary?: AgentForkContextOptions;
}

export function useTranscriptCopy(serverId: string, supported: boolean) {
  const { t } = useTranslation();
  const toast = useToast();
  const locked = useRef(false);
  const [pending, setPending] = useState(false);
  const copyTranscript = useStableEvent(
    async (agentId: string, boundary: AgentForkContextOptions = {}) => {
      if (locked.current) return;
      locked.current = true;
      setPending(true);
      try {
        if (!supported) throw new Error(t("message.actions.forkUnavailable"));
        const client = useSessionStore.getState().sessions[serverId]?.client;
        if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
        const copied = client
          .exportAgentTranscript(agentId, boundary)
          .then(({ title, cwd, body }) =>
            formatCopiedTranscript({
              metadata: { title, cwd, source: { serverId, agentId, ...boundary } },
              body,
            }),
          );
        const write = writeMarkdownToRichClipboard(
          copied,
          getDefaultMarkdownClipboardEnvironment(),
          createTranscriptClipboardContent,
        );
        toast.show(t("transcript.copying"), { durationMs: null, testID: "transcript-copying" });
        await write;
        toast.copied(t("transcript.label"));
      } catch (error) {
        const detail = error instanceof Error ? error.message : t("transcript.copyFailed");
        toast.show(detail, { variant: "error", durationMs: null, testID: "transcript-copy-error" });
      } finally {
        locked.current = false;
        setPending(false);
      }
    },
  );
  return { copyTranscript, pending };
}
