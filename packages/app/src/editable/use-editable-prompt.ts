import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  EditableElementSnapshot,
  EditableLocatorContext,
  EditableScreenshotAttachment,
} from "./types";
import { useWorkshop, type UseWorkshopOptions } from "./use-workshop";
import { DEFAULT_WORKSHOP_CWD } from "./workshop-client";

export interface UseEditablePromptOptions extends UseWorkshopOptions {
  loadedChannel?: string;
}

export function useEditablePrompt(options: UseEditablePromptOptions = {}) {
  const { t } = useTranslation();
  const workshop = useWorkshop(options);
  const loadedWipSlug = options.loadedChannel?.startsWith("wip-")
    ? options.loadedChannel.slice(4)
    : null;
  const [draft, setDraft] = useState("");
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState("");
  const [choosingHost, setChoosingHost] = useState(false);
  const [targetNewBranch, setTargetNewBranch] = useState(false);

  function reset() {
    setDraft("");
    setCwd(workshop.config?.workshopCwd ?? "");
    setError("");
    setChoosingHost(false);
    setTargetNewBranch(false);
  }

  async function chooseHost(serverId: string) {
    setError("");
    try {
      await workshop.chooseHost(serverId);
      if (serverId !== workshop.host?.serverId) setCwd("");
      setChoosingHost(false);
    } catch {
      setError(t("editable.saveFailed"));
    }
  }

  const canSend =
    (workshop.managedWorkshop || !!workshop.host) &&
    !workshop.saving &&
    !workshop.sending &&
    !workshop.startingWorkshop &&
    !!draft.trim();

  async function sendDraft(
    context: EditableLocatorContext,
    extras?: {
      snapshot?: EditableElementSnapshot | null;
      images?: EditableScreenshotAttachment[];
    },
  ): Promise<{ agentId: string; slug: string } | null> {
    if (!canSend) return null;
    setError("");
    try {
      const followUp = Boolean(loadedWipSlug && !targetNewBranch);
      const branchTarget = {
        ...(followUp ? { slug: loadedWipSlug, isFollowUp: true } : { isFollowUp: false }),
        ...(extras?.snapshot ? { snapshot: extras.snapshot } : {}),
        ...(extras?.images && extras.images.length > 0 ? { images: extras.images } : {}),
      };
      const result = await workshop.send(context, draft, cwd, branchTarget);
      if (result.kind === "sent") {
        reset();
        return { agentId: result.agentId, slug: result.slug };
      }
      const errors = {
        "choose-host": "editable.selectHost",
        offline: "editable.offline",
        "no-provider": "editable.noProvider",
        busy: "editable.busy",
      } as const;
      setError(t(errors[result.kind]));
    } catch (err) {
      const detail = err instanceof Error ? err.message.trim() : "";
      setError(detail ? `${t("editable.sendFailed")} (${detail})` : t("editable.sendFailed"));
    }
    return null;
  }

  async function submit(context: EditableLocatorContext, close: () => void, reopen: () => void) {
    if (!canSend) return;
    close();
    const sent = await sendDraft(context);
    if (!sent) reopen();
  }

  return {
    ...workshop,
    draft,
    setDraft,
    cwd,
    setCwd,
    defaultCwd: workshop.workshopDaemon?.repoDir ?? DEFAULT_WORKSHOP_CWD,
    error,
    loadedWipSlug,
    targetNewBranch,
    setTargetNewBranch,
    choosingHost: !workshop.managedWorkshop && (choosingHost || !workshop.host),
    setChoosingHost,
    chooseHost,
    canSend,
    reset,
    submit,
    submitInPlace: sendDraft,
  };
}
