import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { getIsElectron, isWeb } from "@/constants/platform";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useOverlayRegistration } from "@/keyboard";
import { getOverlayRoot, useGlobalOverlayLayer } from "@/lib/overlay-root";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { EditableChatView, type EditableChatDraftControls } from "./EditableChatView.web";
import { EditableStatusPill, pillStyle } from "./EditableStatusPill.web";
import { locateEditableTarget } from "./locator";
import type { EditableTarget } from "./locator.ts";
import type { EditableRouteContext } from "./types";
import { useEditableDesktop } from "./use-editable-desktop.web";
import { useEditablePrompt } from "./use-editable-prompt";

const FRAME_GAP = 8;
const DRAFT_POPOVER_WIDTH = 360;
const CHAT_POPOVER_WIDTH = 410;

function useOptionHoldPicking(enabled: boolean): [boolean, () => void] {
  const [altPicking, setAltPicking] = useState(false);
  const clear = useCallback(() => setAltPicking(false), []);

  useEffect(() => {
    if (!isWeb || !enabled) {
      setAltPicking(false);
      return;
    }
    const cancelAlt = () => setAltPicking(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Alt") {
        if (!event.ctrlKey && !event.metaKey && !event.shiftKey) setAltPicking(true);
        return;
      }
      // Pressing another key while holding Option (e.g. Option+Arrow or Option+Shift+F8) cancels hold-pick.
      setAltPicking(false);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Alt") setAltPicking(false);
    };
    const onVisibility = () => {
      if (document.hidden) setAltPicking(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", cancelAlt);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", cancelAlt);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  return [altPicking, clear];
}

function usePointerPositionRef() {
  const pointerPos = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!isWeb) return;
    const onPointerMove = (event: PointerEvent) => {
      pointerPos.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove, true);
    };
  }, []);
  return pointerPos;
}

function useEditableEscape(
  active: boolean,
  layer: number,
  manageFocus: boolean,
  close: () => void,
) {
  return useOverlayRegistration({
    active,
    layer,
    keys: ["Escape"],
    manageFocus,
    onKeyDown(event) {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      close();
      return true;
    },
  });
}

function PickingHint({ visible, layer }: { visible: boolean; layer: number }) {
  const { t } = useTranslation();
  const hintStyle = useMemo(
    () =>
      ({
        ...pillStyle,
        position: "fixed",
        right: 12,
        bottom: 52,
        zIndex: layer,
        pointerEvents: "none",
      }) as const,
    [layer],
  );
  if (!visible) return null;
  return (
    <div role="status" data-ed-overlay="true" style={hintStyle}>
      {t("editable.pickHint")}
    </div>
  );
}

function shouldRenderOverlay({
  active,
  enabled,
  hasBridge,
  editing,
}: {
  active: boolean;
  enabled: boolean;
  hasBridge: boolean;
  editing: boolean;
}): boolean {
  if (!isWeb || typeof document === "undefined") return false;
  return active || enabled || hasBridge || editing;
}

function workshopStatusTextKey(prompt: ReturnType<typeof useEditablePrompt>): string {
  if (prompt.startingWorkshop) return "editable.workshopStarting";
  if (prompt.workshopDaemon?.status === "running") {
    return prompt.isConnected ? "editable.workshopConnected" : "editable.workshopConnecting";
  }
  return "editable.workshopAutoStart";
}

function buildDraftControls(
  prompt: ReturnType<typeof useEditablePrompt>,
  t: (key: string) => string,
  onSubmitDraft: () => void,
): EditableChatDraftControls {
  return {
    draft: prompt.draft,
    setDraft: prompt.setDraft,
    canSend: prompt.canSend,
    sending: prompt.sending,
    error: prompt.error,
    loadedWipSlug: prompt.loadedWipSlug,
    targetNewBranch: prompt.targetNewBranch,
    setTargetNewBranch: prompt.setTargetNewBranch,
    managedWorkshop: prompt.managedWorkshop,
    choosingHost: prompt.choosingHost,
    setChoosingHost: prompt.setChoosingHost,
    hosts: prompt.hosts,
    host: prompt.host,
    chooseHost: prompt.chooseHost,
    saving: prompt.saving,
    cwd: prompt.cwd,
    setCwd: prompt.setCwd,
    defaultCwd: prompt.defaultCwd,
    workshopStatusText: t(workshopStatusTextKey(prompt)),
    onSubmitDraft,
  };
}

function formatTargetLabel(target: EditableTarget, fallback: string): string {
  const { componentName, file, line } = target.context;
  const shortFile = file ? file.split("/").pop() : null;
  const suffix = shortFile ? `${shortFile}${line ? `:${line}` : ""}` : null;
  if (componentName && suffix) return `${componentName} · ${suffix}`;
  return componentName || suffix || fallback;
}

function SelectedElementChat({
  selected,
  inlineChat,
  rect,
  layer,
  setScope,
  prompt,
  bridge,
  branches,
  refresh,
  onClose,
  onSubmitDraft,
  onPopOutChat,
}: {
  selected: EditableTarget;
  inlineChat: { slug: string; agentId: string } | null;
  rect: DOMRect | null;
  layer: number;
  setScope: (node: unknown) => void;
  prompt: ReturnType<typeof useEditablePrompt>;
  bridge: ReturnType<typeof useEditableDesktop>["bridge"];
  branches: ReturnType<typeof useEditableDesktop>["branches"];
  refresh: () => Promise<void>;
  onClose: () => void;
  onSubmitDraft: () => void;
  onPopOutChat: (agentId: string) => void;
}) {
  const { t } = useTranslation();
  const onLoadInlineBranch = useStableEvent((channel: string) => {
    if (!bridge?.loadBranch) return;
    void (async () => {
      await bridge.loadBranch!(channel);
      await refresh();
    })();
  });
  const onShipInlineBranch = useStableEvent((slug: string) => {
    if (!bridge?.shipBranch) return;
    void (async () => {
      const res = await bridge.shipBranch!(slug);
      if (res.ok) prompt.clearBranchAgent?.(slug);
      await refresh();
    })();
  });
  const onInlineTurnFinished = useStableEvent(() => {
    void bridge?.syncNow?.().finally(() => void refresh());
  });

  const inlineBranch = inlineChat
    ? (branches?.branches.find((b) => b.slug === inlineChat.slug) ?? null)
    : null;
  const draftControls = buildDraftControls(prompt, t, onSubmitDraft);
  const selectedLabel = formatTargetLabel(selected, t("editable.component"));

  return (
    <InlinePopover
      rect={rect}
      layer={layer}
      width={inlineChat ? CHAT_POPOVER_WIDTH : DRAFT_POPOVER_WIDTH}
      setScope={setScope}
      onDismiss={onClose}
      label={inlineChat ? inlineChat.slug : t("editable.placeholder")}
    >
      <EditableChatView
        serverId={prompt.hostId}
        agentId={inlineChat?.agentId ?? null}
        slug={inlineChat?.slug ?? null}
        title={inlineChat ? inlineChat.slug : selectedLabel}
        locatorChip={inlineChat ? selectedLabel : null}
        branch={inlineBranch}
        draftControls={draftControls}
        compact
        onClose={onClose}
        onPopOut={prompt.hostId ? onPopOutChat : undefined}
        onLoadBranch={bridge?.loadBranch ? onLoadInlineBranch : undefined}
        onShipBranch={bridge?.shipBranch ? onShipInlineBranch : undefined}
        onTurnFinished={onInlineTurnFinished}
      />
    </InlinePopover>
  );
}

export function EditableOverlay() {
  const route = usePathname();
  const router = useRouter();
  const { bridge, status, workshopDaemon, branches, refresh } = useEditableDesktop();
  const loadedChannel = branches?.loadedChannel ?? status?.activeChannel ?? "prod";
  const prompt = useEditablePrompt({
    bridge,
    workshopDaemon,
    branches,
    loadedChannel,
    refreshDesktop: refresh,
  });
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<EditableTarget | null>(null);
  const [inlineChat, setInlineChat] = useState<{ slug: string; agentId: string } | null>(null);
  const pointerPos = usePointerPositionRef();
  const canPick = isWeb && prompt.config?.enabled === true && !prompt.sending;
  const [altPicking, clearAltPicking] = useOptionHoldPicking(canPick && !selected);
  const currentRoute = useRef(route);
  currentRoute.current = route;

  const close = useCallback(() => {
    setSelected(null);
    setInlineChat(null);
    setPicking(false);
    clearAltPicking();
  }, [clearAltPicking]);
  useEffect(close, [route, close]);

  const isPickingMode = picking || altPicking;
  const active = isPickingMode || !!selected;
  const layer = useGlobalOverlayLayer("floating", active);

  const startPick = useCallback(() => {
    if (!canPick) return;
    prompt.reset();
    setSelected(null);
    setInlineChat(null);
    clearAltPicking();
    setPicking(true);
  }, [canPick, clearAltPicking, prompt]);

  useKeyboardActionHandler({
    handlerId: "editable.pick",
    actions: ["editable.pick"],
    enabled: canPick,
    priority: 100,
    handle: () => {
      if (active) close();
      else startPick();
      return true;
    },
  });

  const setScope = useEditableEscape(active, layer, !!selected, close);

  const onPick = useCallback(
    (target: EditableTarget) => {
      setSelected(target);
      setInlineChat(null);
      setPicking(false);
      clearAltPicking();
    },
    [clearAltPicking],
  );
  const hover = useHoveredTarget({
    picking,
    altPicking,
    pointerPos,
    route,
    releaseDigest: status?.releaseDigest ?? null,
    onPick,
  });
  const target = selected ?? hover;
  const rect = useTargetRect(target?.element);

  const onSubmitDraft = useStableEvent(() => {
    if (!selected) return;
    void (async () => {
      const sent = await prompt.submitInPlace(selected.context);
      if (sent && currentRoute.current === route) setInlineChat(sent);
    })();
  });

  const onPopOutChat = useStableEvent((agentId: string) => {
    if (!prompt.hostId) return;
    close();
    router.push(buildHostAgentDetailRoute(prompt.hostId, agentId) as never);
  });

  if (
    !shouldRenderOverlay({
      active,
      enabled: prompt.config?.enabled === true,
      hasBridge: !!bridge,
      editing: prompt.editing,
    })
  ) {
    return null;
  }

  return createPortal(
    <>
      <PickingHint visible={isPickingMode} layer={layer} />
      {target && rect ? <PickerHighlight rect={rect} target={target} layer={layer} /> : null}
      {selected ? (
        <SelectedElementChat
          selected={selected}
          inlineChat={inlineChat}
          rect={rect}
          layer={layer}
          setScope={setScope}
          prompt={prompt}
          bridge={bridge}
          branches={branches}
          refresh={refresh}
          onClose={close}
          onSubmitDraft={onSubmitDraft}
          onPopOutChat={onPopOutChat}
        />
      ) : null}
      <EditableStatusPill
        bridge={bridge}
        status={status}
        workshopDaemon={workshopDaemon}
        branches={branches}
        workshop={prompt}
        onPick={startPick}
        onRefresh={refresh}
        layer={layer}
      />
    </>,
    getOverlayRoot(),
  );
}

function useHoveredTarget({
  picking,
  altPicking,
  pointerPos,
  route,
  releaseDigest,
  onPick,
}: {
  picking: boolean;
  altPicking: boolean;
  pointerPos: React.RefObject<{ x: number; y: number } | null>;
  route: string;
  releaseDigest: string | null;
  onPick: (target: EditableTarget) => void;
}) {
  const [hover, setHover] = useState<EditableTarget | null>(null);
  const active = picking || altPicking;

  useEffect(() => {
    if (!isWeb || !active) return;
    const context: EditableRouteContext = {
      route,
      releaseDigest,
      platform: getIsElectron() ? "electron" : "web",
    };

    // Immediately highlight whatever sits under the cursor when Option is pressed.
    const pos = pointerPos.current;
    if (pos && typeof document.elementFromPoint === "function") {
      const under = document.elementFromPoint(pos.x, pos.y);
      if (under && !under.closest('[data-ed-overlay="true"]')) {
        const initial = locateEditableTarget(under, context);
        if (initial) setHover(initial);
      }
    }

    const onMove = (event: PointerEvent) => {
      const candidate = locateEditableTarget(event.target, context);
      setHover((previous) => (previous?.element === candidate?.element ? previous : candidate));
    };
    const clearHover = () => setHover(null);
    const isPageTarget = (event: MouseEvent) =>
      event.target instanceof Element && !event.target.closest('[data-ed-overlay="true"]');
    const matchesClickMode = (event: MouseEvent) => picking || (altPicking && event.altKey);
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !isPageTarget(event) || !matchesClickMode(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onClick = (event: MouseEvent) => {
      if (!isPageTarget(event) || !matchesClickMode(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const target = locateEditableTarget(event.target, context);
      if (target) onPick(target);
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("blur", clearHover);
    document.documentElement.addEventListener("pointerleave", clearHover);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("blur", clearHover);
      document.documentElement.removeEventListener("pointerleave", clearHover);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("click", onClick, true);
      clearHover();
    };
  }, [active, picking, altPicking, pointerPos, route, releaseDigest, onPick]);

  return active ? hover : null;
}

function PickerHighlight({
  rect,
  target,
  layer,
}: {
  rect: DOMRect;
  target: EditableTarget;
  layer: number;
}) {
  const { t } = useTranslation();
  const frameStyle = useMemo(
    () =>
      ({
        position: "fixed",
        pointerEvents: "none",
        zIndex: layer,
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        border: "1px solid #4191fb",
        background: "rgba(65, 145, 251, 0.16)",
        boxSizing: "border-box",
      }) as const,
    [rect, layer],
  );
  const labelStyle = useMemo(
    () =>
      ({
        ...pillStyle,
        position: "absolute",
        top: rect.top > 22 ? -23 : 0,
        left: 0,
      }) as const,
    [rect.top],
  );
  return (
    <div aria-hidden data-ed-overlay="true" style={frameStyle}>
      <span style={labelStyle}>
        {target.context.componentName ?? t("editable.component")} ·{" "}
        {target.context.file.split("/").at(-1)}:{target.context.line}
      </span>
    </div>
  );
}

function InlinePopover({
  rect,
  layer,
  width: preferredWidth,
  setScope,
  onDismiss,
  label,
  children,
}: {
  rect: DOMRect | null;
  layer: number;
  width: number;
  setScope: (node: unknown) => void;
  onDismiss: () => void;
  label: string;
  children: React.ReactNode;
}) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<React.CSSProperties>();

  const attachRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      setScope(node);
    },
    [setScope],
  );

  useEffect(() => {
    if (!isWeb) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        onDismiss();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onDismiss]);

  useLayoutEffect(() => {
    if (!isWeb || !frame) return;
    const measure = () => {
      const { height } = frame.getBoundingClientRect();
      const width = Math.max(0, Math.min(preferredWidth, window.innerWidth - FRAME_GAP * 2));
      const edge = rect?.bottom ?? FRAME_GAP;
      const fitsBelow = edge + height + FRAME_GAP * 2 <= window.innerHeight;
      const top = fitsBelow ? edge + FRAME_GAP : (rect?.top ?? edge) - height - FRAME_GAP;
      setStyle({
        zIndex: layer,
        position: "fixed",
        width,
        pointerEvents: "auto",
        maxHeight: Math.max(0, window.innerHeight - FRAME_GAP * 2),
        overflow: "visible",
        top: Math.max(FRAME_GAP, Math.min(top, window.innerHeight - height - FRAME_GAP)),
        left: Math.max(
          FRAME_GAP,
          Math.min(rect?.left ?? FRAME_GAP, window.innerWidth - width - FRAME_GAP),
        ),
        borderRadius: 10,
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(frame);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [frame, layer, preferredWidth, rect]);

  return (
    <div
      ref={attachRef}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      data-ed-overlay="true"
      style={style}
    >
      <div ref={setFrame}>{children}</div>
    </div>
  );
}

function useTargetRect(element: Element | undefined) {
  const [rect, setRect] = useState<{ element: Element; bounds: DOMRect } | null>(null);
  useEffect(() => {
    if (!isWeb || !element) return;
    const measure = () => {
      if (element.isConnected) setRect({ element, bounds: element.getBoundingClientRect() });
      else setRect(null);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [element]);
  return rect && rect.element === element ? rect.bounds : null;
}
