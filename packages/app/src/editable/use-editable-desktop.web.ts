import { useEffect, useRef, useState } from "react";
import { isWeb } from "@/constants/platform";
import { useNavigationContainerRef } from "expo-router";
import type { EditableDesktopStatus } from "./types";

export function useEditableDesktop() {
  const navigation = useNavigationContainerRef();
  const bridge = isWeb && typeof window !== "undefined" ? window.paseoDesktop?.editable : undefined;
  const [status, setStatus] = useState<EditableDesktopStatus | null>(null);
  const acknowledged = useRef<string | null>(null);

  useEffect(() => {
    if (!bridge) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const sample = async () => {
      try {
        const next = await bridge.getStatus();
        if (stopped) return;
        setStatus(next);
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
      if (!stopped) timer = setTimeout(sample, 3000);
    };
    void sample();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [bridge, navigation]);

  return { bridge, status };
}
