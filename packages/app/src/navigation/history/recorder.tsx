import { useLocalSearchParams, usePathname } from "expo-router";
import { useEffect, useMemo } from "react";
import {
  useWorkspaceLayoutStore,
  useWorkspaceLayoutStoreHydrated,
} from "@/stores/workspace-layout-store";
import { useSidebarNavigationStore } from "@/components/sidebar/navigation/store";
import { useHosts } from "@/runtime/host-runtime";
import { useWorkspaceStructure } from "@/stores/session-store-hooks";
import { buildHostWorkspaceRoute } from "@/utils/host-routes";
import { workspaceTabTargetsEqual } from "@/workspace-tabs/identity";
import { buildWorkspaceTabPersistenceKey } from "@/workspace-tabs/model";
import { classifyLocation, entriesEqual, type HistoryEntry } from "./model";
import {
  rememberBrowserSidebarContext,
  initializeBrowserSidebarContext,
} from "./browser-sidebar-context";
import { selectActiveWorkspaceTabId } from "./select-active-tab";
import { navigationHistoryStore, type NavigationHistoryStore } from "./store";

// Register before React Navigation mounts its popstate listener and can commit a route.
initializeBrowserSidebarContext(useSidebarNavigationStore.getState().selectProject);

/**
 * Records where the user is looking as navigation history. Mounted once, renders nothing.
 *
 * Observation is a React effect on (pathname, focused tab of the pathname's workspace), not a raw
 * store subscription. `navigateToWorkspace` writes the destination's layout before the pathname
 * flips, so a raw subscription would see a torn (old pathname, new tab) sample. Selecting the tab
 * for the workspace the pathname names makes that intermediate state invisible: while the
 * pathname still says A, A's tab is unchanged and nothing is recorded.
 *
 * Replay never needs to suppress recording. It moves the index first, so the landing location
 * equals the current entry and the compare below turns it into a no-op.
 */
export function NavigationHistoryRecorder({
  store = navigationHistoryStore,
}: {
  store?: NavigationHistoryStore;
}) {
  const pathname = usePathname();
  const params = useLocalSearchParams<{
    serverId?: string | string[];
    workspaceId?: string | string[];
  }>();
  const paramServerId = params.serverId;
  const paramWorkspaceId = params.workspaceId;
  const hydrated = useWorkspaceLayoutStoreHydrated();
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const { projects } = useWorkspaceStructure(serverIds);

  const location = useMemo(
    () =>
      classifyLocation({
        pathname,
        params: { serverId: paramServerId, workspaceId: paramWorkspaceId },
      }),
    [pathname, paramServerId, paramWorkspaceId],
  );
  const workspaceKey =
    location?.kind === "workspace" ? buildWorkspaceTabPersistenceKey(location) : null;
  const destinationProjectKey = projects.find((project) =>
    workspaceKey ? project.workspaceKeys.includes(workspaceKey) : false,
  )?.viewKey;
  const focusedTabId = useWorkspaceLayoutStore((state) =>
    workspaceKey && hydrated ? selectActiveWorkspaceTabId(state, workspaceKey) : null,
  );
  // getWorkspaceTabs normalizes the persisted layout and therefore returns fresh tab objects.
  // Subscribe to a primitive target signature so same-ID retargets trigger this observer without
  // handing Zustand an uncached object snapshot.
  const focusedTabTargetSignature = useWorkspaceLayoutStore((state) => {
    if (!workspaceKey || !hydrated) {
      return null;
    }
    const activeTabId = selectActiveWorkspaceTabId(state, workspaceKey);
    const focusedTab = activeTabId
      ? state.getWorkspaceTabs(workspaceKey).find((candidate) => candidate.tabId === activeTabId)
      : undefined;
    return focusedTab ? JSON.stringify(focusedTab.target) : null;
  });

  useEffect(() => {
    if (!location) {
      return;
    }
    let entry: HistoryEntry;
    if (location.kind === "workspace") {
      if (!hydrated || !workspaceKey) {
        return;
      }
      const tab = focusedTabId
        ? useWorkspaceLayoutStore
            .getState()
            .getWorkspaceTabs(workspaceKey)
            .find((candidate) => candidate.tabId === focusedTabId)
        : undefined;
      entry = { ...location, tabId: focusedTabId, target: tab?.target ?? null };
    } else {
      entry = location;
    }
    // FORK(locator-compose): source links target the remembered worktree composer.
    if (entry.kind === "workspace" && entry.target?.kind === "agent" && workspaceKey) {
      const agentId = entry.target.agentId;
      const state = useWorkspaceLayoutStore.getState();
      if (state.lastFocusedAgentByWorkspace[workspaceKey] !== agentId) {
        useWorkspaceLayoutStore.setState({
          lastFocusedAgentByWorkspace: {
            ...state.lastFocusedAgentByWorkspace,
            [workspaceKey]: agentId,
          },
        });
      }
    }
    recordNavigationLocation(store, entry, {
      ...useSidebarNavigationStore.getState(),
      destinationProjectKey,
    });
    const { entries, index } = store.getState();
    const recorded = entries[index];
    if (recorded?.sidebarProjectKey !== undefined && entriesEqual(recorded, entry)) {
      const browserPath =
        recorded.kind === "workspace"
          ? buildHostWorkspaceRoute(recorded.serverId, recorded.workspaceId)
          : recorded.path;
      rememberBrowserSidebarContext(browserPath, recorded.sidebarProjectKey);
    }
  }, [
    destinationProjectKey,
    focusedTabId,
    focusedTabTargetSignature,
    hydrated,
    location,
    store,
    workspaceKey,
  ]);

  return null;
}

interface SidebarNavigationContext {
  projectKey: string | null;
  destinationProjectKey: string | undefined;
  selectProject: (projectKey: string | null) => void;
}

export function recordNavigationLocation(
  store: NavigationHistoryStore,
  entry: HistoryEntry,
  sidebar?: SidebarNavigationContext,
) {
  // Missing layouts and Explorer-only focus are transitional. Settled empty workspaces have
  // a New tab; recording a tabless location cannot restore its focus when replayed.
  if (entry.kind === "workspace" && (!entry.tabId || !entry.target)) {
    return;
  }
  const { entries, index } = store.getState();
  const current = entries[index];
  const sameLocation = current && entriesEqual(current, entry);
  const targetChanged = current && focusedTargetChanged(current, entry);
  const previousVisit = sameLocation && !targetChanged ? current : undefined;
  entry = followSidebarNavigation(entry, previousVisit, sidebar);
  if (sameLocation) {
    const contextResolved =
      current.sidebarProjectKey === undefined && entry.sidebarProjectKey !== undefined;
    if (targetChanged || contextResolved) store.replaceCurrent(entry);
    return;
  }
  store.record(entry);
}

function followSidebarNavigation(
  entry: HistoryEntry,
  current: HistoryEntry | undefined,
  sidebar: SidebarNavigationContext | undefined,
): HistoryEntry {
  // FORK(project-navigation): browsing the rail does not rewrite the current visit.
  if (current?.sidebarProjectKey !== undefined) {
    return { ...entry, sidebarProjectKey: current.sidebarProjectKey };
  }
  if (!sidebar) return entry;
  if (entry.kind === "workspace" && sidebar.destinationProjectKey === undefined) return entry;
  let projectKey = sidebar.projectKey;
  if (entry.kind === "workspace" && projectKey !== null && sidebar.destinationProjectKey) {
    projectKey = sidebar.destinationProjectKey;
  }
  sidebar.selectProject(projectKey);
  return { ...entry, sidebarProjectKey: projectKey };
}

function focusedTargetChanged(current: HistoryEntry, entry: HistoryEntry): boolean {
  if (current.kind !== "workspace" || entry.kind !== "workspace") return false;
  if (current.target === null || entry.target === null) return current.target !== entry.target;
  return !workspaceTabTargetsEqual(current.target, entry.target);
}
