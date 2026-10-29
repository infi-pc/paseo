import { SIDEBAR_NAVIGATION_RAIL_WIDTH } from "@/constants/layout";
import { useMemo, useCallback, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View, Text, ScrollView } from "react-native";
import { ChevronDown, FolderPlus, Inbox } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuRoot, MenuTrigger, MenuSurface, MenuItem } from "@/components/ui/menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { DensityIcon } from "@/components/ui/density-icon";
import { ProjectIconView } from "@/components/project-icon-view";
import { useProjectIcons } from "@/projects/icons";
import { resolveSidebarProjectIconTargets } from "@/utils/sidebar-project-row-model";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarModel } from "../sidebar-model";
import { SidebarNavRows } from "../sidebar-nav-rows";
import { useSidebarNavigationStore } from "./store";

const inboxMark = <DensityIcon icon={Inbox} size="md" color="foregroundMuted" />;

function ProjectMark({ project, icon }: { project: SidebarProjectEntry; icon: string | null }) {
  return (
    <ProjectIconView
      iconDataUri={icon}
      projectViewKey={project.viewKey}
      initial={projectIconPlaceholderLabelFromDisplayName(project.projectName)
        .charAt(0)
        .toUpperCase()}
      size={24}
      textStyle={styles.initial}
    />
  );
}

function UnreadBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{count}</Text>
    </View>
  );
}

export function SidebarProjectRail({
  onAddProject,
  footer,
}: {
  onAddProject: () => void;
  footer: ReactNode;
}) {
  const { t } = useTranslation();
  const { allProjects, navigation } = useSidebarModel();
  const selectProject = useSidebarNavigationStore((state) => state.selectProject);
  const selectInbox = useCallback(() => selectProject(null), [selectProject]);
  const targets = useMemo(() => resolveSidebarProjectIconTargets(allProjects), [allProjects]);
  const icons = useProjectIcons({ projects: targets });
  const unreadCount = [...navigation.unreadByProject.values()].reduce(
    (total, count) => total + count,
    0,
  );
  return (
    <View style={styles.rail} testID="sidebar-project-rail">
      <SidebarNavRows iconOnly itemsKind="builtin" style={styles.actions} />
      <View style={styles.separator} />
      <ToolbarButton
        label={t("sidebar.navigation.inbox")}
        selected={!navigation.selectedProject}
        onPress={selectInbox}
        testID="sidebar-inbox"
        tooltipSide="right"
        style={styles.railButton}
      >
        <DensityIcon icon={Inbox} size="md" color="foregroundMuted" />
        <UnreadBadge count={unreadCount} />
      </ToolbarButton>
      <ScrollView
        style={styles.projects}
        contentContainerStyle={styles.projectItems}
        showsVerticalScrollIndicator={false}
      >
        {allProjects.map((project) => (
          <ProjectNavigationItem
            key={project.viewKey}
            project={project}
            icon={icons.get(project.viewKey) ?? null}
            selected={navigation.selectedProject?.viewKey === project.viewKey}
            unread={navigation.unreadByProject.get(project.viewKey) ?? 0}
            presentation="rail"
          />
        ))}
        <ToolbarButton
          label={t("sidebar.actions.addProject")}
          onPress={onAddProject}
          tooltipSide="right"
          testID="sidebar-rail-add-project"
        >
          <DensityIcon icon={FolderPlus} size="md" color="foregroundMuted" />
        </ToolbarButton>
      </ScrollView>
      {footer}
    </View>
  );
}

export function SidebarProjectSelector() {
  const { t } = useTranslation();
  const { allProjects, navigation } = useSidebarModel();
  const selectProject = useSidebarNavigationStore((state) => state.selectProject);
  const selectInbox = useCallback(() => selectProject(null), [selectProject]);
  const targets = useMemo(() => resolveSidebarProjectIconTargets(allProjects), [allProjects]);
  const icons = useProjectIcons({ projects: targets });
  const selected = navigation.selectedProject;
  const title = selected?.projectName ?? t("sidebar.navigation.inbox");
  const unreadCount = [...navigation.unreadByProject.values()].reduce(
    (total, count) => total + count,
    0,
  );
  return (
    <MenuRoot compactMode="sheet">
      <MenuTrigger
        style={styles.selector}
        accessibilityLabel={t("sidebar.navigation.select")}
        testID="sidebar-project-selector"
      >
        {selected ? (
          <ProjectMark project={selected} icon={icons.get(selected.viewKey) ?? null} />
        ) : (
          <DensityIcon icon={Inbox} size="md" color="foreground" />
        )}
        <Text style={styles.title} numberOfLines={1}>
          {title}
        </Text>
        <DensityIcon icon={ChevronDown} size="sm" color="foregroundMuted" />
      </MenuTrigger>
      <MenuSurface
        sheetTitle={t("sidebar.navigation.select")}
        width={280}
        testID="sidebar-project-picker"
      >
        <MenuItem onSelect={selectInbox} selected={!selected} leading={inboxMark}>
          {t("sidebar.navigation.inbox")}
          {unreadCount ? ` (${unreadCount})` : ""}
        </MenuItem>
        {allProjects.map((project) => (
          <ProjectNavigationItem
            key={project.viewKey}
            project={project}
            icon={icons.get(project.viewKey) ?? null}
            selected={selected?.viewKey === project.viewKey}
            unread={navigation.unreadByProject.get(project.viewKey) ?? 0}
            presentation="menu"
          />
        ))}
      </MenuSurface>
    </MenuRoot>
  );
}

function ProjectNavigationItem({
  project,
  icon,
  selected,
  unread,
  presentation,
}: {
  project: SidebarProjectEntry;
  icon: string | null;
  selected: boolean;
  unread: number;
  presentation: "rail" | "menu";
}) {
  const selectProject = useSidebarNavigationStore((state) => state.selectProject);
  const select = useCallback(
    () => selectProject(project.viewKey),
    [selectProject, project.viewKey],
  );
  const mark = useMemo(() => <ProjectMark project={project} icon={icon} />, [project, icon]);
  if (presentation === "menu") {
    return (
      <MenuItem onSelect={select} selected={selected} leading={mark}>
        {project.projectName}
        {unread ? ` (${unread})` : ""}
      </MenuItem>
    );
  }
  return (
    <ToolbarButton
      label={project.projectName}
      selected={selected}
      onPress={select}
      testID={`sidebar-project-tab-${project.viewKey}`}
      tooltipSide="right"
      style={styles.railButton}
    >
      {mark}
      <UnreadBadge count={unread} />
    </ToolbarButton>
  );
}

const styles = StyleSheet.create((theme) => ({
  rail: {
    width: SIDEBAR_NAVIGATION_RAIL_WIDTH,
    alignItems: "center",
    borderRightWidth: theme.borderWidth[1],
    borderRightColor: theme.colors.border,
    paddingVertical: theme.spacing[2],
    gap: theme.spacing[2],
  },
  actions: { alignItems: "center", gap: theme.spacing[2] },
  separator: { height: theme.borderWidth[1], width: 24, backgroundColor: theme.colors.border },
  projects: { flex: 1, width: "100%" },
  projectItems: { alignItems: "center", gap: theme.spacing[2], paddingBottom: theme.spacing[2] },
  railButton: { width: 36, height: 36 },
  initial: { fontSize: theme.fontSize.sm, fontWeight: theme.fontWeight.medium },
  badge: {
    position: "absolute",
    right: -2,
    bottom: -2,
    minWidth: 14,
    paddingHorizontal: 3,
    borderRadius: theme.borderRadius.full,
    backgroundColor: theme.colors.accent,
  },
  badgeText: {
    fontSize: theme.fontSize.sm,
    color: theme.colors.accentForeground,
    textAlign: "center",
  },
  selector: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    padding: theme.spacing[3],
    minHeight: 48,
  },
  title: {
    flex: 1,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
  },
}));
