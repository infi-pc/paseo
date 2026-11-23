import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "expo-router";
import { useTranslation } from "react-i18next";
import { getIsElectron, isWeb } from "@/constants/platform";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useOverlayRegistration } from "@/keyboard";
import { getOverlayRoot, useGlobalOverlayLayer } from "@/lib/overlay-root";
import { EditablePrompt } from "./EditablePrompt";
import { EditableStatusPill, pillStyle } from "./EditableStatusPill.web";
import { locateEditableTarget } from "./locator";
import type { EditableTarget } from "./locator.ts";
import type { EditableRouteContext } from "./types";
import { useEditableDesktop } from "./use-editable-desktop.web";
import { useEditablePrompt } from "./use-editable-prompt";

const FRAME_GAP = 8;
const PROMPT_WIDTH = 320;

export function EditableOverlay() {
  const { t } = useTranslation();
  const route = usePathname();
  const { bridge, status } = useEditableDesktop();
  const prompt = useEditablePrompt();
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<EditableTarget | null>(null);
  const currentRoute = useRef(route);
  currentRoute.current = route;

  const close = useCallback(() => {
    setSelected(null);
    setPicking(false);
  }, []);
  useEffect(close, [route, close]);

  const active = picking || !!selected;
  const layer = useGlobalOverlayLayer("floating", active);
  useKeyboardActionHandler({
    handlerId: "editable.pick",
    actions: ["editable.pick"],
    enabled: isWeb && prompt.config?.enabled === true && !prompt.sending,
    priority: 100,
    handle: () => {
      if (active) close();
      else {
        prompt.reset();
        setPicking(true);
      }
      return true;
    },
  });
  const setScope = useOverlayRegistration({
    active,
    layer,
    keys: ["Escape"],
    manageFocus: !!selected,
    onKeyDown(event) {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      close();
      return true;
    },
  });

  const onPick = useCallback((target: EditableTarget) => {
    setSelected(target);
    setPicking(false);
  }, []);
  const hover = useHoveredTarget(picking, route, status?.releaseDigest ?? null, onPick);
  const target = selected ?? hover;
  const rect = useTargetRect(target?.element);
  const onSubmit = useStableEvent(() => {
    if (!selected) return;
    void prompt.submit(selected.context, close, () => {
      if (currentRoute.current === route) setSelected(selected);
    });
  });
  const hintStyle = useMemo(
    () =>
      ({
        ...pillStyle,
        position: "fixed",
        left: 12,
        bottom: 12,
        zIndex: layer,
        pointerEvents: "none",
      }) as const,
    [layer],
  );

  if (!isWeb || typeof document === "undefined") return null;
  if (!active && !bridge && !prompt.editing) return null;

  return createPortal(
    <>
      {picking ? (
        <div role="status" data-ed-overlay="true" style={hintStyle}>
          {t("editable.pickHint")}
        </div>
      ) : null}
      {target && rect ? <PickerHighlight rect={rect} target={target} layer={layer} /> : null}
      {selected ? (
        <InlinePopover
          rect={rect}
          layer={layer}
          setScope={setScope}
          label={t("editable.placeholder")}
        >
          <EditablePrompt prompt={prompt} onClose={close} onSubmit={onSubmit} />
        </InlinePopover>
      ) : null}
      <EditableStatusPill bridge={bridge} status={status} editing={prompt.editing} layer={layer} />
    </>,
    getOverlayRoot(),
  );
}

function useHoveredTarget(
  picking: boolean,
  route: string,
  releaseDigest: string | null,
  onPick: (target: EditableTarget) => void,
) {
  const [hover, setHover] = useState<EditableTarget | null>(null);

  useEffect(() => {
    if (!isWeb || !picking) return;
    const context: EditableRouteContext = {
      route,
      releaseDigest,
      platform: getIsElectron() ? "electron" : "web",
    };
    const onMove = (event: PointerEvent) => {
      const candidate = locateEditableTarget(event.target, context);
      setHover((previous) => (previous?.element === candidate?.element ? previous : candidate));
    };
    const clearHover = () => setHover(null);
    const isPageTarget = (event: MouseEvent) =>
      event.target instanceof Element && !event.target.closest('[data-ed-overlay="true"]');
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !isPageTarget(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onClick = (event: MouseEvent) => {
      if (!isPageTarget(event)) return;
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
  }, [picking, route, releaseDigest, onPick]);

  return picking ? hover : null;
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
  setScope,
  label,
  children,
}: {
  rect: DOMRect | null;
  layer: number;
  setScope: (node: unknown) => void;
  label: string;
  children: React.ReactNode;
}) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<React.CSSProperties>();
  useLayoutEffect(() => {
    if (!isWeb || !frame) return;
    const measure = () => {
      const { height } = frame.getBoundingClientRect();
      const width = Math.max(0, Math.min(PROMPT_WIDTH, window.innerWidth - FRAME_GAP * 2));
      const edge = rect?.bottom ?? FRAME_GAP;
      const fitsBelow = edge + height + FRAME_GAP * 2 <= window.innerHeight;
      const top = fitsBelow ? edge + FRAME_GAP : (rect?.top ?? edge) - height - FRAME_GAP;
      setStyle({
        zIndex: layer,
        position: "fixed",
        width,
        pointerEvents: "auto",
        maxHeight: Math.max(0, window.innerHeight - FRAME_GAP * 2),
        overflow: "auto",
        top: Math.max(FRAME_GAP, Math.min(top, window.innerHeight - height - FRAME_GAP)),
        left: Math.max(
          FRAME_GAP,
          Math.min(rect?.left ?? FRAME_GAP, window.innerWidth - width - FRAME_GAP),
        ),
        boxShadow: "0 6px 24px rgba(0, 0, 0, 0.22)",
        borderRadius: 8,
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
  }, [frame, layer, rect]);

  return (
    <div
      ref={setScope}
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
