import { useCallback, useEffect, useRef, useState } from "react";
import { isWeb } from "@/constants/platform";
import { useNavigationContainerRef } from "expo-router";
import type {
  EditableBranchesSnapshot,
  EditableDesktopStatus,
  EditableWorkshopDaemonStatus,
} from "./types";

export function useEditableDesktop() {
  const navigation = useNavigationContainerRef();
  const bridge = isWeb && typeof window !== "undefined" ? window.paseoDesktop?.editable : undefined;
  const [status, setStatus] = useState<EditableDesktopStatus | null>(null);
  const [workshopDaemon, setWorkshopDaemon] = useState<EditableWorkshopDaemonStatus | null>(null);
  const [branches, setBranches] = useState<EditableBranchesSnapshot | null>(null);
  const acknowledged = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const sampleNow = useCallback(async () => {
    if (!bridge) return;
    try {
      const [next, nextWorkshop, nextBranches] = await Promise.all([
        bridge.getStatus(),
        bridge.getWorkshopStatus?.().catch(() => null) ?? Promise.resolve(null),
        bridge.getBranches?.().catch(() => null) ?? Promise.resolve(null),
      ]);
      if (!mountedRef.current) return;
      setStatus(next);
      if (bridge.getWorkshopStatus) setWorkshopDaemon(nextWorkshop);
      if (bridge.getBranches) setBranches(nextBranches);
      if (
        navigation.isReady() &&
        next.activeDigest &&
        next.releaseDigest === next.activeDigest &&
        acknowledged.current !== next.activeDigest
      ) {
        await bridge.reportHealthy(next.activeDigest);
        acknowledged.current = next.activeDigest;
      }
    } catch {
      // Preload may disappear while the renderer reloads. Retry on the next sample.
    }
  }, [bridge, navigation]);

  useEffect(() => {
    mountedRef.current = true;
    if (!bridge) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const loop = async () => {
      await sampleNow();
      if (!stopped) timer = setTimeout(loop, 3000);
    };
    void loop();
    return () => {
      stopped = true;
      mountedRef.current = false;
      clearTimeout(timer);
    };
  }, [bridge, sampleNow]);

  return { bridge, status, workshopDaemon, branches, refresh: sampleNow };
}
