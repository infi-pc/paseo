import { SIDEBAR_NAVIGATION_RAIL_WIDTH } from "@/constants/layout";
import { useMemo, useCallback, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { View, Text, type LayoutChangeEvent } from "react-native";
import { ChevronDown, FolderPlus, Inbox, MoreHorizontal } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuRoot, MenuTrigger, MenuSurface, MenuItem } from "@/components/ui/menu";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { DensityIcon } from "@/components/ui/density-icon";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import type { DraggableListDragHandleProps } from "@/components/draggable-list.types";
import { SidebarProjectsDialog } from "./projects-dialog";
import { ProjectMark, UnreadBadge } from "./project-mark";
import {
  PROJECT_RAIL_ITEM_SIZE,
  PROJECT_RAIL_ITEM_GAP,
  visibleRailProjectCount,
  projectNavigationKey,
  useReorderSidebarProjects,
} from "./project-order";
import { useProjectIcons } from "@/projects/icons";
import { resolveSidebarProjectIconTargets } from "@/utils/sidebar-project-row-model";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarModel } from "../sidebar-model";
import { SidebarNavRows } from "../sidebar-nav-rows";
import { useSidebarNavigationStore } from "./store";

const inboxMark = <DensityIcon icon={Inbox} size="md" color="foregroundMuted" />;

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
  const [projectsHeight, setProjectsHeight] = useState(0);
  const [showProjects, setShowProjects] = useState(false);
  const openProjects = useCallback(() => setShowProjects(true), []);
  const measureProjects = useCallback(
    (event: LayoutChangeEvent) => setProjectsHeight(event.nativeEvent.layout.height),
    [],
  );
  const closeProjects = useCallback(() => setShowProjects(false), []);
  const reorder = useReorderSidebarProjects();
  const visibleCount = visibleRailProjectCount(projectsHeight, allProjects.length);
  const visibleProjects = useMemo(
    () => allProjects.slice(0, visibleCount),
    [allProjects, visibleCount],
  );
  const renderProject = useCallback(
    ({ item, drag, dragHandleProps }: DraggableRenderItemInfo<SidebarProjectEntry>) => (
      <View style={styles.railItem}>
        <ProjectNavigationItem
          project={item}
          icon={icons.get(item.viewKey) ?? null}
          selected={navigation.selectedProject?.viewKey === item.viewKey}
          unread={navigation.unreadByProject.get(item.viewKey) ?? 0}
          presentation="rail"
          onLongPress={drag}
          dragHandleProps={dragHandleProps}
        />
      </View>
    ),
    [icons, navigation.selectedProject, navigation.unreadByProject],
  );
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
      <View style={styles.projects} onLayout={measureProjects}>
        <DraggableList
          data={visibleProjects}
          keyExtractor={projectNavigationKey}
          renderItem={renderProject}
          onDragEnd={reorder}
          scrollEnabled={false}
          useDragHandle
          containerStyle={styles.railItems}
          testID="sidebar-rail-projects"
        />
        {projectsHeight > 0 && visibleCount < allProjects.length ? (
          <ToolbarButton
            label={t("sidebar.navigation.allProjects")}
            onPress={openProjects}
            tooltipSide="right"
            testID="sidebar-project-overflow"
            style={styles.railItemButton}
          >
            <DensityIcon icon={MoreHorizontal} size="md" color="foregroundMuted" />
          </ToolbarButton>
        ) : null}
        <ToolbarButton
          label={t("sidebar.actions.addProject")}
          onPress={onAddProject}
          tooltipSide="right"
          testID="sidebar-rail-add-project"
          style={styles.railButton}
        >
          <DensityIcon icon={FolderPlus} size="md" color="foregroundMuted" />
        </ToolbarButton>
      </View>
      <SidebarProjectsDialog visible={showProjects} onClose={closeProjects} icons={icons} />
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
  onLongPress,
  dragHandleProps,
}: {
  project: SidebarProjectEntry;
  icon: string | null;
  selected: boolean;
  unread: number;
  presentation: "rail" | "menu";
  onLongPress?: () => void;
  dragHandleProps?: DraggableListDragHandleProps;
}) {
  const selectProject = useSidebarNavigationStore((state) => state.selectProject);
  const select = useCallback(
    () => selectProject(project.viewKey),
    [selectProject, project.viewKey],
  );
  const mark = useMemo(() => <ProjectMark project={project} icon={icon} />, [project, icon]);
  if (presentation === "menu") {
    return (
      <MenuItem
        onSelect={select}
        selected={selected}
        leading={mark}
        testID={`sidebar-project-option-${project.viewKey}`}
      >
        {project.projectName}
        {unread ? ` (${unread})` : ""}
      </MenuItem>
    );
  }
  return (
    <ToolbarButton
      {...dragHandleProps?.attributes}
      {...dragHandleProps?.listeners}
      label={project.projectName}
      selected={selected}
      onPress={select}
      onLongPress={onLongPress}
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
  projects: { flex: 1, minHeight: 0, width: "100%", alignItems: "center" },
  railItems: { flexShrink: 0, alignItems: "center" },
  railItem: { marginBottom: PROJECT_RAIL_ITEM_GAP },
  railButton: { width: PROJECT_RAIL_ITEM_SIZE, height: PROJECT_RAIL_ITEM_SIZE },
  railItemButton: {
    width: PROJECT_RAIL_ITEM_SIZE,
    height: PROJECT_RAIL_ITEM_SIZE,
    marginBottom: PROJECT_RAIL_ITEM_GAP,
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
