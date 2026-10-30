import {
  splitPinnedSidebarGroups,
  type PinnedSidebarGroups,
  type PinnedSidebarKeys,
} from "@/hooks/use-sidebar-pins";
import type {
  SidebarProjectEntry,
  SidebarWorkspaceEntry,
} from "@/hooks/use-sidebar-workspaces-list";
import {
  resolveSidebarProjectIconTargets,
  type SidebarProjectIconTarget,
} from "@/utils/sidebar-project-row-model";
import {
  buildSidebarShortcutSections,
  type SidebarShortcutModel,
  type SidebarShortcutSection,
} from "@/utils/sidebar-shortcuts";

export interface SidebarProjection {
  pinnedGroups: PinnedSidebarGroups;
  projectIconTargets: SidebarProjectIconTarget[];
  shortcutModel: SidebarShortcutModel;
}

export interface SidebarProjectionInput {
  flatWorkspaces?: SidebarWorkspaceEntry[];
  projects: SidebarProjectEntry[];
  pinnedKeys: PinnedSidebarKeys;
  pinnedWorkspaceOrder: string[];
  pinnedCollapsed: boolean;
  collapsedProjectKeys: ReadonlySet<string>;
}

export function buildSidebarProjection(input: SidebarProjectionInput): SidebarProjection {
  if (input.flatWorkspaces) {
    return {
      pinnedGroups: { pinnedChats: [], unpinnedProjects: input.projects },
      projectIconTargets: resolveSidebarProjectIconTargets(input.projects),
      shortcutModel: buildSidebarShortcutSections({
        sections: [{ workspaces: input.flatWorkspaces }],
      }),
    };
  }
  const pinnedGroups = splitPinnedSidebarGroups({
    projects: input.projects,
    keys: input.pinnedKeys,
    pinnedWorkspaceOrder: input.pinnedWorkspaceOrder,
  });
  const sections: SidebarShortcutSection[] = [];
  if (!input.pinnedCollapsed) {
    sections.push({ workspaces: pinnedGroups.pinnedChats });
  }
  sections.push(
    ...pinnedGroups.unpinnedProjects.map((project) => ({
      workspaces: project.workspaces,
      collapsed: input.collapsedProjectKeys.has(project.viewKey),
    })),
  );
  return {
    pinnedGroups,
    projectIconTargets: resolveSidebarProjectIconTargets(input.projects),
    shortcutModel: buildSidebarShortcutSections({ sections }),
  };
}
