import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  EditableElementSnapshot,
  EditableLocatorContext,
  EditableReferencedElement,
  EditableScreenshotAttachment,
} from "./types";
import { useWorkshop, type UseWorkshopOptions } from "./use-workshop";
import { DEFAULT_WORKSHOP_CWD } from "./workshop-client";

export interface UseEditablePromptOptions extends UseWorkshopOptions {
  loadedChannel?: string;
}

interface SendDraftExtras {
  snapshot?: EditableElementSnapshot | null;
  extraReferences?: ReadonlyArray<Pick<EditableReferencedElement, "locator" | "snapshot">>;
  images?: EditableScreenshotAttachment[];
  targetSlug?: string | null;
  overrideText?: string;
}

const SEND_ERRORS = {
  "choose-host": "editable.selectHost",
  offline: "editable.offline",
  "no-provider": "editable.noProvider",
  busy: "editable.busy",
} as const;

function buildSendBranchTarget(effectiveSlug: string | null, extras?: SendDraftExtras) {
  return {
    ...(effectiveSlug ? { slug: effectiveSlug, isFollowUp: true } : { isFollowUp: false }),
    ...(extras?.snapshot ? { snapshot: extras.snapshot } : {}),
    ...(extras?.extraReferences?.length ? { extraReferences: extras.extraReferences } : {}),
    ...(extras?.images?.length ? { images: extras.images } : {}),
  };
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
  // undefined = follow default (loadedWipSlug ?? null); null = explicit New branch; string = specific thread
  const [targetSlugOverride, setTargetSlugOverride] = useState<string | null | undefined>(
    undefined,
  );

  const selectedTargetSlug = targetSlugOverride === undefined ? loadedWipSlug : targetSlugOverride;
  const targetNewBranch = selectedTargetSlug === null;

  function setSelectedTargetSlug(slug: string | null) {
    setTargetSlugOverride(slug);
  }

  function setTargetNewBranch(value: boolean) {
    setTargetSlugOverride(value ? null : loadedWipSlug);
  }

  function reset() {
    setDraft("");
    setCwd(workshop.config?.workshopCwd ?? "");
    setError("");
    setChoosingHost(false);
    setTargetSlugOverride(undefined);
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

  const hostReady =
    (workshop.managedWorkshop || !!workshop.host) &&
    !workshop.saving &&
    !workshop.sending &&
    !workshop.startingWorkshop;
  const canSend = hostReady && !!draft.trim();

  async function sendDraft(
    context: EditableLocatorContext,
    extras?: SendDraftExtras,
  ): Promise<{ agentId: string; slug: string } | null> {
    const textToSend = extras?.overrideText ?? draft;
    if (!hostReady || !textToSend.trim()) return null;
    setError("");
    try {
      const effectiveSlug =
        extras?.targetSlug !== undefined ? extras.targetSlug : selectedTargetSlug;
      const branchTarget = buildSendBranchTarget(effectiveSlug, extras);
      const result = await workshop.send(context, textToSend, cwd, branchTarget);
      if (result.kind === "sent") {
        reset();
        return { agentId: result.agentId, slug: result.slug };
      }
      setError(t(SEND_ERRORS[result.kind]));
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
    selectedTargetSlug,
    setSelectedTargetSlug,
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
