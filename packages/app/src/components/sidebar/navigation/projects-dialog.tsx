import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { GripVertical } from "lucide-react-native";
import { StyleSheet } from "react-native-unistyles";
import { AdaptiveModalSheet } from "@/components/adaptive-modal-sheet";
import { DraggableList, type DraggableRenderItemInfo } from "@/components/draggable-list";
import { PressHighlight } from "@/components/ui/press-highlight";
import { DensityIcon } from "@/components/ui/density-icon";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarModel } from "../sidebar-model";
import { useSidebarNavigationStore } from "./store";
import { projectNavigationKey, useReorderSidebarProjects } from "./project-order";
import { ProjectMark, UnreadBadge } from "./project-mark";

export function SidebarProjectsDialog({
  visible,
  onClose,
  icons,
}: {
  visible: boolean;
  onClose: () => void;
  icons: ReadonlyMap<string, string | null>;
}) {
  const { t } = useTranslation();
  const { allProjects, navigation } = useSidebarModel();
  const reorder = useReorderSidebarProjects();
  const header = useMemo(
    () => ({
      title: t("sidebar.navigation.allProjects"),
      subtitle: <Text style={styles.hint}>{t("sidebar.navigation.reorderHint")}</Text>,
    }),
    [t],
  );
  const renderProject = useCallback(
    (info: DraggableRenderItemInfo<SidebarProjectEntry>) => (
      <ProjectDialogRow
        info={info}
        icon={icons.get(info.item.viewKey) ?? null}
        selected={navigation.selectedProject?.viewKey === info.item.viewKey}
        unread={navigation.unreadByProject.get(info.item.viewKey) ?? 0}
        onClose={onClose}
      />
    ),
    [icons, navigation.selectedProject, navigation.unreadByProject, onClose],
  );
  return (
    <AdaptiveModalSheet
      header={header}
      visible={visible}
      onClose={onClose}
      testID="sidebar-all-projects-dialog"
      scrollable={false}
      desktopHeight="70%"
    >
      <DraggableList
        data={allProjects}
        keyExtractor={projectNavigationKey}
        renderItem={renderProject}
        onDragEnd={reorder}
        useDragHandle
        testID="sidebar-all-projects-list"
      />
    </AdaptiveModalSheet>
  );
}

function ProjectDialogRow({
  info,
  icon,
  selected,
  unread,
  onClose,
}: {
  info: DraggableRenderItemInfo<SidebarProjectEntry>;
  icon: string | null;
  selected: boolean;
  unread: number;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { item, drag, dragHandleProps } = info;
  const selectProject = useSidebarNavigationStore((state) => state.selectProject);
  const select = useCallback(() => {
    selectProject(item.viewKey);
    onClose();
  }, [item.viewKey, onClose, selectProject]);
  const selectionState = useMemo(() => ({ selected }), [selected]);
  return (
    <View style={styles.row} testID={`sidebar-all-project-row-${item.viewKey}`}>
      <PressHighlight
        accessibilityRole="button"
        accessibilityState={selectionState}
        onPress={select}
        style={[styles.select, selected && styles.selected]}
        testID={`sidebar-all-project-option-${item.viewKey}`}
      >
        <View>
          <ProjectMark project={item} icon={icon} />
          <UnreadBadge count={unread} />
        </View>
        <Text style={styles.label} numberOfLines={1}>
          {item.projectName}
        </Text>
      </PressHighlight>
      <ToolbarButton
        {...dragHandleProps?.attributes}
        {...dragHandleProps?.listeners}
        label={t("sidebar.navigation.reorderProject", { name: item.projectName })}
        onPress={drag}
        onLongPress={drag}
        testID={`sidebar-project-drag-${item.viewKey}`}
        style={styles.handle}
      >
        <DensityIcon icon={GripVertical} size="md" color="foregroundMuted" />
      </ToolbarButton>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: theme.spacing[4] },
  select: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[3],
    minHeight: 48,
  },
  selected: { backgroundColor: theme.colors.surface2 },
  hint: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  label: { flex: 1, color: theme.colors.foreground, fontSize: theme.fontSize.base },
  handle: { width: 36, height: 36 },
}));
