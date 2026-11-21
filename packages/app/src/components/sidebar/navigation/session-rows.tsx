import { ChevronDown, ChevronRight } from "lucide-react-native";
import { DensityIcon } from "@/components/ui/density-icon";
import { useIsCompactFormFactor } from "@/constants/layout";
import { isNative, isWeb } from "@/constants/platform";
import { densityIconBox } from "@/styles/density";
import { getStatusDotColor } from "@/utils/status-dot-color";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { PressHighlight } from "@/components/ui/press-highlight";
// FORK(inbox-workspaces): shared host-session shortcuts for Inbox and project panels.
import { createContext, useContext, useCallback, useMemo, type ReactNode } from "react";
import {
  View,
  Text,
  type GestureResponderEvent,
  type PressableStateCallbackType,
} from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import type { SidebarWorkspaceEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { useActiveWorkspaceSelection } from "@/stores/navigation-active-workspace-store";
import type { InboxSection, SidebarSession } from "./model";
import type { useSidebarNavigation } from "./use-navigation";

const LEADING_SLOT_HEIGHT = 20;

export const SidebarSessionsContext = createContext<
  Pick<ReturnType<typeof useSidebarNavigation>, "sessions" | "sections">
>({ sessions: new Map(), sections: [] });

export function useWorkspaceSessionDisclosure(workspaceKey: string, section?: InboxSection) {
  const { sessions } = useContext(SidebarSessionsContext);
  const preferenceKey = `sessions:${section ?? "project"}:${workspaceKey}`;
  const preference = useSidebarCollapsedSectionsStore((state) =>
    state.collapsedProjectKeys.has(preferenceKey),
  );
  const togglePreference = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );
  const expanded = section === undefined ? preference : !preference;
  const toggle = useCallback(
    () => togglePreference(preferenceKey),
    [togglePreference, preferenceKey],
  );
  const rows = useMemo(
    () =>
      (sessions.get(workspaceKey) ?? []).filter(
        (session) =>
          !section ||
          section === "snoozed" ||
          (section === "running" ? session.running : !session.running),
      ),
    [sessions, workspaceKey, section],
  );
  return { rows, hasSessions: rows.length > 0, expanded, toggle };
}

export function WorkspaceLeadingSessionToggle({
  workspaceKey,
  section,
  isHovered,
  disabled = false,
  children,
}: {
  workspaceKey: string;
  section?: InboxSection;
  isHovered: boolean;
  disabled?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const isCompact = useIsCompactFormFactor();
  const { hasSessions, expanded, toggle } = useWorkspaceSessionDisclosure(workspaceKey, section);
  const showChevron = isHovered || isNative || isCompact;
  const expansionState = useMemo(() => ({ expanded }), [expanded]);
  const handlePressIn = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);
  const handlePressOut = useCallback((event: GestureResponderEvent) => {
    event.stopPropagation();
  }, []);
  const handlePress = useCallback(
    (event: GestureResponderEvent) => {
      event.stopPropagation();
      toggle();
    },
    [toggle],
  );
  const buttonStyle = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) => [
      styles.leadingToggle,
      showChevron && (hovered || pressed) && styles.leadingToggleHovered,
    ],
    [showChevron],
  );
  const renderContent = useCallback(
    ({ hovered = false, pressed }: PressableStateCallbackType & { hovered?: boolean }) =>
      showChevron ? (
        <DensityIcon
          icon={expanded ? ChevronDown : ChevronRight}
          size="sm"
          color={hovered || pressed ? "foreground" : "foregroundMuted"}
        />
      ) : (
        children
      ),
    [showChevron, expanded, children],
  );

  if (!hasSessions) return children;

  return (
    <PressHighlight
      highlightStyle={styles.leadingToggleHovered}
      onPressIn={handlePressIn}
      onPressOut={handlePressOut}
      onPress={handlePress}
      disabled={disabled}
      hitSlop={4}
      accessibilityRole={isWeb ? undefined : "button"}
      accessibilityState={expansionState}
      aria-expanded={expanded}
      accessibilityLabel={t("inboxSections.sessions")}
      style={buttonStyle}
      testID={`sidebar-sessions-toggle-${workspaceKey}-${section ?? "project"}`}
    >
      {renderContent}
    </PressHighlight>
  );
}

export function WorkspaceSessionRows({
  workspace,
  section,
  onPress,
}: {
  workspace: SidebarWorkspaceEntry;
  section?: InboxSection;
  onPress?: () => void;
}) {
  const { t } = useTranslation();
  const { rows, expanded } = useWorkspaceSessionDisclosure(workspace.workspaceKey, section);
  const snooze = workspace.snooze;
  const deadline =
    snooze?.config.mode === "time" ? snooze.config.wakeAt : snooze?.config.deadlineAt;
  const showSnooze = Boolean(snooze && section !== "running");
  const showSessions = expanded && rows.length > 0;
  if (!showSnooze && !showSessions) return null;
  return (
    <View style={styles.children}>
      {showSnooze ? (
        <Text style={styles.muted}>
          {t("workspaceSnooze.snoozed")}
          {deadline
            ? ` · ${t("inboxSections.reminder", { time: new Date(deadline).toLocaleString() })}`
            : ""}
        </Text>
      ) : null}
      {showSessions
        ? rows.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              workspace={workspace}
              onPress={onPress}
            />
          ))
        : null}
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
  leadingToggle: {
    width: densityIconBox("md"),
    height: LEADING_SLOT_HEIGHT,
    borderRadius: theme.borderRadius.sm,
    flexShrink: 0,
    alignItems: "center",
    justifyContent: "center",
  },
  leadingToggleHovered: {
    backgroundColor: theme.colors.surface2,
  },
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
