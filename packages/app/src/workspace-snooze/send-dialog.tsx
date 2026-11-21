import { confirmSnoozedSend, type SnoozedSendDecision } from "./confirm-send";
// FORK(inbox-workspaces): only explicit user sends prompt; background queue drains keep snooze.
import { useCallback, useRef, useMemo } from "react";
import { create } from "zustand";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { useSessionStore } from "@/stores/session-store";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import type { AnyWorkspaceSnooze } from "@getpaseo/protocol/workspace-status-snooze";

type Decision = SnoozedSendDecision;
interface SendQuestion {
  name: string;
  snooze: AnyWorkspaceSnooze;
  answer: (decision: Decision) => void;
}
const useSendQuestion = create<{ question: SendQuestion | null }>(() => ({ question: null }));

function ask(name: string, snooze: AnyWorkspaceSnooze): Promise<Decision> {
  // Another composer may still own a dialog (retained panels share this host).
  if (useSendQuestion.getState().question) return Promise.resolve("cancel");
  return new Promise((resolve) => {
    useSendQuestion.setState({
      question: {
        name,
        snooze,
        answer: (decision) => {
          useSendQuestion.setState({ question: null });
          resolve(decision);
        },
      },
    });
  });
}

export function useSnoozedSend(
  serverId: string,
  workspaceId: string | null | undefined,
  onError: (message: string) => void,
  onPendingChange?: (pending: boolean) => void,
) {
  const sending = useRef(false);
  const { t } = useTranslation();
  return useCallback(
    async (send: (unsnoozed: boolean) => void | Promise<void>) => {
      if (sending.current) return;
      sending.current = true;
      onPendingChange?.(true);
      let unsnoozed = false;
      try {
        const result = await confirmSnoozedSend({
          read: () =>
            workspaceId
              ? useSessionStore.getState().sessions[serverId]?.workspaces.get(workspaceId)
              : undefined,
          ask,
          unsnooze: async (id) => {
            if (!workspaceId) return;
            const session = useSessionStore.getState().sessions[serverId];
            if (!session?.serverInfo?.features?.workspaceSnoozeDeadlines)
              throw new Error(t("workspaceSnooze.updateHost"));
            const client = getHostRuntimeStore().getClient(serverId);
            if (!client) throw new Error(t("workspace.terminal.hostDisconnected"));
            await client.setWorkspaceSnooze(workspaceId, null, id);
          },
        });
        if (result === "cancel") return;
        unsnoozed = result === "unsnoozed";
        await send(unsnoozed);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        onError(unsnoozed ? `${t("workspaceSnooze.sendFailedAwake")} ${message}` : message);
      } finally {
        sending.current = false;
        onPendingChange?.(false);
      }
    },
    [serverId, workspaceId, onError, onPendingChange, t],
  );
}

export function SnoozedSendDialog() {
  const question = useSendQuestion((state) => state.question);
  const { t } = useTranslation();
  const cancel = useCallback(() => question?.answer("cancel"), [question]);
  const keep = useCallback(() => question?.answer("keep"), [question]);
  const unsnooze = useCallback(() => question?.answer("unsnooze"), [question]);
  const header = useMemo(() => ({ title: t("workspaceSnooze.sendTitle") }), [t]);
  const footer = useMemo(
    () => (
      <View style={styles.actions}>
        <Button variant="secondary" onPress={cancel}>
          {t("common.actions.cancel")}
        </Button>
        <Button variant="secondary" onPress={keep}>
          {t("workspaceSnooze.sendKeep")}
        </Button>
        <Button variant="default" onPress={unsnooze}>
          {t("workspaceSnooze.sendUnsnooze")}
        </Button>
      </View>
    ),
    [cancel, keep, unsnooze, t],
  );
  if (!question) return null;
  const config = question.snooze.config;
  let condition = t("workspaceSnooze.statusCondition");
  if (config.mode === "time") condition = new Date(config.wakeAt).toLocaleString();
  if (config.mode === "ai") condition = config.prompt;
  return (
    <AdaptiveModalSheet
      visible
      onClose={cancel}
      header={header}
      footer={footer}
      testID="snoozed-send-dialog"
    >
      <Text style={styles.body}>
        {t("workspaceSnooze.sendBody", { name: question.name, condition })}
      </Text>
    </AdaptiveModalSheet>
  );
}
const styles = StyleSheet.create((theme) => ({
  body: {
    padding: theme.spacing[4],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  actions: { width: "100%", padding: theme.spacing[3], gap: theme.spacing[2] },
}));
