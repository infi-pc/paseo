import { useCallback, useEffect, useRef, useState } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { parseComposeDeepLink } from "@getpaseo/protocol/compose-deep-link";
import { useFetchQuery } from "@/data/query";
import { Button } from "@/components/ui/button";
import { useLocalDaemonServerIdState } from "@/hooks/use-is-local-daemon";
import { useDirectoryDemand } from "@/hooks/use-directory-demand";
import { getHostRuntimeStore, useHosts, useHostRuntimeSnapshot } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import {
  useWorkspaceLayoutStore,
  useWorkspaceLayoutStoreHydrated,
} from "@/stores/workspace-layout-store";
import { useDraftStore } from "@/stores/draft-store";
import { buildDraftStoreKey, generateDraftId } from "@/stores/draft-keys";
import { buildWorkspaceTabPersistenceKey, type WorkspaceTabTarget } from "@/workspace-tabs/model";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { selectActiveWorkspaceTabId } from "@/navigation/history/select-active-tab";
import { formatComposeReference, matchComposeWorkspace } from "./location";

export function ComposeScreen() {
  const params = useLocalSearchParams<Record<string, string | string[]>>();
  const search = composeSearchParams(params);
  const target = parseComposeDeepLink(`paseo://compose?${search}`);
  const local = useLocalDaemonServerIdState();
  const serverId = target?.serverId ?? (local.status === "resolved" ? local.serverId : null);
  const runtime = useHostRuntimeSnapshot(serverId ?? "");
  const hosts = useHosts();
  const hydrated = useWorkspaceLayoutStoreHydrated();
  const { t } = useTranslation();
  const handled = useRef<string | null>(null);
  const [appendFailed, setAppendFailed] = useState(false);
  useDirectoryDemand(serverId);
  const requestKey = JSON.stringify([serverId, search.toString(), params.requestId]);
  const activeRequest = useRef<string | null>(requestKey);
  useEffect(() => {
    activeRequest.current = requestKey;
    return () => {
      activeRequest.current = null;
    };
  }, [requestKey]);
  const query = useFetchQuery({
    queryKey: ["compose-location", requestKey],
    enabled: Boolean(target && serverId && hydrated && runtime?.connectionStatus === "online"),
    retry: false,
    dataShape: "value",
    staleTimeMs: 0,
    gcTime: 0,
    queryFn: async () => {
      if (!target || !serverId || !runtime?.client) throw new Error("Compose host unavailable");
      await getHostRuntimeStore().refreshWorkspaceDirectory({ serverId });
      const session = useSessionStore.getState().sessions[serverId];
      const workspace = matchComposeWorkspace(session?.workspaces.values() ?? [], target.cwd);
      if (!workspace) throw new Error("Compose worktree not found");
      const workspaceKey = buildWorkspaceTabPersistenceKey({ serverId, workspaceId: workspace.id });
      if (!workspaceKey) throw new Error("Invalid compose workspace identity");
      const layout = useWorkspaceLayoutStore.getState();
      const activeTabId = selectActiveWorkspaceTabId(layout, workspaceKey);
      const activeTarget = layout
        .getWorkspaceTabs(workspaceKey)
        .find((tab) => tab.tabId === activeTabId)?.target;
      const focusedAgentId = layout.lastFocusedAgentByWorkspace[workspaceKey];
      const agentId =
        focusedAgentId ?? (activeTarget?.kind === "agent" ? activeTarget.agentId : null);
      let tabTarget: WorkspaceTabTarget = { kind: "draft", draftId: generateDraftId() };
      if (agentId) {
        const result = await runtime.client.fetchAgent({ agentId });
        if (result?.agent?.workspaceId === workspace.id) tabTarget = { kind: "agent", agentId };
      }
      const draftKey =
        tabTarget.kind === "agent"
          ? buildDraftStoreKey({ serverId, agentId: tabTarget.agentId })
          : buildDraftStoreKey({ serverId, agentId: "", draftId: tabTarget.draftId });
      return {
        serverId,
        workspaceId: workspace.id,
        tabTarget,
        draftKey,
        text: formatComposeReference(target),
      };
    },
  });

  useEffect(() => {
    const result = query.data;
    if (!result || handled.current === requestKey) return;
    handled.current = requestKey;
    void useDraftStore
      .getState()
      .appendDraftText({ draftKey: result.draftKey, text: result.text })
      .then(() => {
        if (activeRequest.current !== requestKey) return undefined;
        return navigateToWorkspace({
          serverId: result.serverId,
          workspaceId: result.workspaceId,
          target: result.tabTarget,
          pin: true,
        });
      })
      .catch(() => {
        if (activeRequest.current === requestKey) setAppendFailed(true);
      });
  }, [query.data, requestKey]);

  const failed =
    composeHostFailed({ target, local, serverId, hosts, runtime }) || query.isError || appendFailed;
  const retry = useCallback(() => {
    handled.current = null;
    setAppendFailed(false);
    if (serverId) void getHostRuntimeStore().runProbeCycleNow(serverId);
    void query.refetch();
  }, [serverId, query]);
  const back = useCallback(() => router.replace("/open-project"), []);
  return (
    <View style={styles.container} testID="compose-route">
      <Text style={styles.text}>{t(failed ? "composeLink.failed" : "composeLink.loading")}</Text>
      {failed ? (
        <>
          <Text style={styles.text}>{t("composeLink.help")}</Text>
          <Button onPress={retry}>{t("common.actions.retry")}</Button>
          <Button variant="outline" onPress={back}>
            {t("common.actions.back")}
          </Button>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
    backgroundColor: theme.colors.background,
  },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.base },
}));

function composeSearchParams(params: Record<string, string | string[]>): URLSearchParams {
  const search = new URLSearchParams();
  for (const key of ["cwd", "file", "line", "column", "serverId"]) {
    const value = params[key];
    if (Array.isArray(value)) value.forEach((part) => search.append(key, part));
    else if (value !== undefined) search.set(key, value);
  }
  return search;
}

interface ComposeHostState {
  target: ReturnType<typeof parseComposeDeepLink>;
  local: ReturnType<typeof useLocalDaemonServerIdState>;
  serverId: string | null;
  hosts: ReturnType<typeof useHosts>;
  runtime: ReturnType<typeof useHostRuntimeSnapshot>;
}

function composeHostFailed({ target, local, serverId, hosts, runtime }: ComposeHostState): boolean {
  if (!target) return true;
  if (!target.serverId && local.status === "error") return true;
  if (local.status === "resolved" && !serverId) return true;
  if (serverId && !hosts.some((host) => host.serverId === serverId)) return true;
  return runtime?.connectionStatus === "offline" || runtime?.connectionStatus === "error";
}
