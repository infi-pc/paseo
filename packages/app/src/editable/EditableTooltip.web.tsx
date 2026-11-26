import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getOverlayRoot } from "@/lib/overlay-root";

export function EditableHoverTooltip({
  tooltip,
  style,
  focusable = false,
  children,
}: {
  tooltip: string;
  style?: React.CSSProperties;
  focusable?: boolean;
  children: React.ReactNode;
}) {
  const anchorRef = useRef<HTMLSpanElement | null>(null);
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null);

  const show = useStableEvent(() => {
    const el = anchorRef.current;
    if (!el || typeof window === "undefined") return;
    const rect = el.getBoundingClientRect();
    setPos({
      right: Math.max(12, window.innerWidth - rect.right),
      bottom: Math.max(12, window.innerHeight - rect.top + 6),
    });
  });
  const hide = useStableEvent(() => setPos(null));

  const floatingStyle = useMemo(
    () =>
      pos
        ? ({
            ...tooltipBubbleStyle,
            right: pos.right,
            bottom: pos.bottom,
          } as const)
        : null,
    [pos],
  );

  return (
    <span
      ref={anchorRef}
      title={tooltip}
      tabIndex={focusable ? 0 : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      style={style ?? inlineTooltipAnchorStyle}
    >
      {children}
      {floatingStyle && typeof document !== "undefined"
        ? createPortal(
            <div role="tooltip" data-ed-overlay="true" style={floatingStyle}>
              {tooltip}
            </div>,
            getOverlayRoot(),
          )
        : null}
    </span>
  );
}

function renderUpdateBeforeShipIcon(color: string) {
  return (
    <svg
      data-ed-ship-update="true"
      width={12}
      height={12}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
      <path d="M3 3v5h5" />
      <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
      <path d="M16 16h5v5" />
    </svg>
  );
}

function resolveShipTooltip(
  canFastForward: boolean,
  hasUiBuild: boolean,
  t: (key: string) => string,
): string {
  if (canFastForward) {
    return hasUiBuild ? t("editable.tooltipShipFast") : t("editable.tooltipShipFastDaemon");
  }
  return hasUiBuild ? t("editable.tooltipShipUpdate") : t("editable.tooltipShipUpdateDaemon");
}

export function EditableShipButton({
  canFastForward,
  hasUiBuild,
  disabled,
  onPress,
}: {
  canFastForward: boolean;
  hasUiBuild: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const { t } = useTranslation();
  const tooltip = resolveShipTooltip(canFastForward, hasUiBuild, t);
  return (
    <EditableHoverTooltip tooltip={tooltip}>
      <Button
        size="sm"
        variant="ghost"
        leftIcon={canFastForward ? undefined : renderUpdateBeforeShipIcon}
        disabled={disabled}
        onPress={onPress}
      >
        {t("editable.shipBranch")}
      </Button>
    </EditableHoverTooltip>
  );
}

const inlineTooltipAnchorStyle = {
  display: "inline-flex",
  alignItems: "center",
} as const;

const tooltipBubbleStyle = {
  position: "fixed",
  zIndex: 999999,
  maxWidth: 240,
  padding: "6px 8px",
  borderRadius: 6,
  background: "#0b0e14",
  color: "#e2e8f0",
  border: "1px solid rgba(255, 255, 255, 0.18)",
  boxShadow: "0 10px 26px rgba(0, 0, 0, 0.65)",
  font: "400 11px/15px system-ui, -apple-system, sans-serif",
  whiteSpace: "normal",
  pointerEvents: "none",
} as const;
