import type { AnyWorkspaceSnooze } from "@getpaseo/protocol/workspace-status-snooze";

export type SnoozedSendDecision = "unsnooze" | "keep" | "cancel";
interface SendWorkspace {
  name: string;
  snooze?: AnyWorkspaceSnooze | null;
}
interface ConfirmSendOptions {
  read: () => SendWorkspace | undefined;
  ask: (name: string, snooze: AnyWorkspaceSnooze) => Promise<SnoozedSendDecision>;
  unsnooze: (expectedId: string) => Promise<void>;
}

/** Resolves before a composer clears its draft or enqueues a message. */
export async function confirmSnoozedSend(
  options: ConfirmSendOptions,
): Promise<"send" | "unsnoozed" | "cancel"> {
  for (;;) {
    const workspace = options.read();
    const snooze = workspace?.snooze;
    if (!snooze) return "send";
    const decision = await options.ask(workspace.name, snooze);
    if (decision === "cancel") return "cancel";
    const latest = options.read()?.snooze;
    if (!latest) return "send";
    if (latest.id !== snooze.id) continue;
    if (decision === "keep") return "send";
    try {
      await options.unsnooze(snooze.id);
      return "unsnoozed";
    } catch (error) {
      const current = options.read()?.snooze;
      if (current && current.id !== snooze.id) continue;
      throw error;
    }
  }
}
