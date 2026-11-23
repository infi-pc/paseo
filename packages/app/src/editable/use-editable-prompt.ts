import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { EditableLocatorContext } from "./types";
import { useWorkshop } from "./use-workshop";
import { DEFAULT_WORKSHOP_CWD } from "./workshop-client";

export function useEditablePrompt() {
  const { t } = useTranslation();
  const workshop = useWorkshop();
  const [draft, setDraft] = useState("");
  const [cwd, setCwd] = useState("");
  const [error, setError] = useState("");
  const [choosingHost, setChoosingHost] = useState(false);

  function reset() {
    setDraft("");
    setCwd(workshop.config?.workshopCwd ?? "");
    setError("");
    setChoosingHost(false);
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

  const canSend = !!workshop.host && !workshop.saving && !workshop.sending && !!draft.trim();

  async function submit(context: EditableLocatorContext, close: () => void, reopen: () => void) {
    if (!canSend) return;
    close();
    setError("");
    try {
      const result = await workshop.send(context, draft, cwd);
      if (result.kind === "sent") {
        reset();
        return;
      }
      const errors = {
        "choose-host": "editable.selectHost",
        offline: "editable.offline",
        "no-provider": "editable.noProvider",
        busy: "editable.busy",
      } as const;
      setError(t(errors[result.kind]));
    } catch {
      setError(t("editable.sendFailed"));
    }
    reopen();
  }

  return {
    ...workshop,
    draft,
    setDraft,
    cwd,
    setCwd,
    defaultCwd: DEFAULT_WORKSHOP_CWD,
    error,
    choosingHost: choosingHost || !workshop.host,
    setChoosingHost,
    chooseHost,
    canSend,
    reset,
    submit,
  };
}
