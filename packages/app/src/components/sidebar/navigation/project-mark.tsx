import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { ProjectIconView } from "@/components/project-icon-view";
import { projectIconPlaceholderLabelFromDisplayName } from "@/utils/project-display-name";
import type { SidebarProjectEntry } from "@/hooks/use-sidebar-workspaces-list";

export function ProjectMark({
  project,
  icon,
}: {
  project: SidebarProjectEntry;
  icon: string | null;
}) {
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

export function UnreadBadge({ count }: { count: number }) {
  if (!count) return null;
  return (
    <View style={styles.badge}>
      <Text style={styles.badgeText}>{count}</Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
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
}));
