import { getStatusDotColor } from "@/utils/status-dot-color";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { PressHighlight } from "@/components/ui/press-highlight";
// FORK(inbox-workspaces): shared host-session shortcuts for Inbox and project panels.
import { createContext, useContext, useCallback, useMemo } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import type { InboxSection, SidebarSession } from "./model";
import type { useSidebarNavigation } from "./use-navigation";

export const SidebarSessionsContext = createContext<
  Pick<ReturnType<typeof useSidebarNavigation>, "sessions" | "sections">
>({ sessions: new Map(), sections: [] });

export function WorkspaceSessionRows({
  workspace,
  section,
  onPress,
}: {
  workspace: SidebarWorkspaceEntry;
  section?: InboxSection;
  onPress?: () => void;
}) {
  const { sessions } = useContext(SidebarSessionsContext);
  const { t } = useTranslation();
  const preferenceKey = `sessions:${section ?? "project"}:${workspace.workspaceKey}`;
  const preference = useSidebarCollapsedSectionsStore((state) =>
    state.collapsedProjectKeys.has(preferenceKey),
  );
  const togglePreference = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );
  const expanded = section === undefined ? preference : !preference;
  const expansionState = useMemo(() => ({ expanded }), [expanded]);
  const toggle = useCallback(
    () => togglePreference(preferenceKey),
    [togglePreference, preferenceKey],
  );
  const rows = (sessions.get(workspace.workspaceKey) ?? []).filter(
    (session) =>
      !section ||
      section === "snoozed" ||
      (section === "running" ? session.running : !session.running),
  );
  const snooze = workspace.snooze;
  const deadline =
    snooze?.config.mode === "time" ? snooze.config.wakeAt : snooze?.config.deadlineAt;
  return (
    <View style={styles.children}>
      {snooze && section !== "running" ? (
        <Text style={styles.muted}>
          {t("workspaceSnooze.snoozed")}
          {deadline
            ? ` · ${t("inboxSections.reminder", { time: new Date(deadline).toLocaleString() })}`
            : ""}
        </Text>
      ) : null}
      {rows.length > 0 ? (
        <>
          <PressHighlight
            highlightStyle={styles.selected}
            onPress={toggle}
            accessibilityRole="button"
            accessibilityState={expansionState}
            accessibilityLabel={t("inboxSections.sessions")}
            style={styles.toggle}
            testID={`sidebar-sessions-toggle-${workspace.workspaceKey}-${section ?? "project"}`}
          >
            <Text style={styles.muted}>
              {expanded ? "⌄" : "›"} {t("inboxSections.sessions")} · {rows.length}
            </Text>
          </PressHighlight>
          {expanded
            ? rows.map((session) => (
                <SessionRow
                  key={session.id}
                  session={session}
                  workspace={workspace}
                  onPress={onPress}
                />
              ))
            : null}
        </>
      ) : null}
    </View>
  );
}
function SessionRow({
  session,
  workspace,
  onPress,
}: {
  session: SidebarSession;
  workspace: SidebarWorkspaceEntry;
  onPress?: () => void;
}) {
  const { t } = useTranslation();
  const active = useActiveWorkspaceSelection();
  const focused = useWorkspaceLayoutStore(
    (state) => state.lastFocusedAgentByWorkspace[workspace.workspaceKey],
  );
  const selected =
    active?.serverId === workspace.serverId &&
    active.workspaceId === workspace.workspaceId &&
    focused === session.id;
  const open = useCallback(() => {
    navigateToAgent({ serverId: session.serverId, agentId: session.id });
    onPress?.();
  }, [session.serverId, session.id, onPress]);
  const selectionState = useMemo(() => ({ selected }), [selected]);
  return (
    <PressHighlight
      highlightStyle={styles.selected}
      onPress={open}
      accessibilityRole="button"
      accessibilityState={selectionState}
      style={[styles.row, selected && styles.selected]}
      testID={`sidebar-session-${session.serverId}-${session.id}`}
    >
      <View
        style={[
          styles.status,
          session.running && styles.working,
          session.blocked && styles.blocked,
        ]}
      />
      <Text style={styles.title} numberOfLines={1}>
        {session.title || t("inboxSections.untitled")}
      </Text>
      {session.unread ? (
        <View
          style={styles.unread}
          testID={`sidebar-session-unread-${workspace.workspaceKey}-${session.id}`}
        />
      ) : null}
    </PressHighlight>
  );
}
const styles = StyleSheet.create((theme) => ({
  children: { paddingLeft: theme.spacing[4] },
  toggle: { paddingVertical: theme.spacing[1], paddingHorizontal: theme.spacing[2] },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    minHeight: 32,
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
  },
  title: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  muted: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  selected: { backgroundColor: theme.colors.surfaceSidebarSelected },
  status: { width: 6, height: 6, borderRadius: 3, backgroundColor: theme.colors.border },
  working: { backgroundColor: getStatusDotColor({ theme, bucket: "running" }) ?? undefined },
  blocked: { backgroundColor: getStatusDotColor({ theme, bucket: "needs_input" }) ?? undefined },
  unread: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: getStatusDotColor({ theme, bucket: "attention" }) ?? undefined,
  },
}));
