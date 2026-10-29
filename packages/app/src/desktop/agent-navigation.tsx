import { router, type Href } from "expo-router";
// FORK(locator-compose): source links enter the global compose route.
import {
  buildComposeRoute,
  type DesktopNavigationTarget,
} from "@getpaseo/protocol/compose-deep-link";
import { generateMessageId } from "@/types/stream";
import { useEffect } from "react";
import { listenToDesktopEvent } from "@/desktop/electron/events";
import { getDesktopHost } from "@/desktop/host";
import { useStableEvent } from "@/hooks/use-stable-event";
import { navigateToAgent } from "@/utils/navigate-to-agent";

export function AgentNavigationListener() {
  const openAgent = useStableEvent((payload: DesktopNavigationTarget | null) => {
    if (!payload) return;
    if ("kind" in payload) {
      router.navigate(buildComposeRoute(payload, generateMessageId()) as Href);
      return;
    }
    const { serverId, agentId } = payload;
    navigateToAgent({ serverId, agentId });
  });

  useEffect(() => {
    const host = getDesktopHost();
    const ready = host?.agentNavigation?.ready;
    if (typeof host?.events?.on !== "function" || typeof ready !== "function") {
      return;
    }

    let disposed = false;
    let unlisten: (() => void) | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = async () => {
      let dispose: (() => void) | null = null;
      try {
        dispose = await listenToDesktopEvent<DesktopNavigationTarget>("open-agent", openAgent);
        if (disposed) {
          dispose();
          return;
        }
        unlisten = dispose;
        const pending = await ready();
        if (!disposed && pending) {
          openAgent(pending);
        }
      } catch {
        dispose?.();
        if (unlisten === dispose) {
          unlisten = null;
        }
        if (!disposed) {
          retryTimer = setTimeout(() => void connect(), 1_000);
        }
      }
    };

    void connect();

    return () => {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      unlisten?.();
    };
  }, [openAgent]);

  return null;
}
