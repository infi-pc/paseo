import { useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  CHANGE_CATEGORIES,
  PRODUCTION_CATEGORIES,
  productionStat,
  sumDiffStats,
  type DiffStat,
  type LineStat,
} from "@getpaseo/protocol/diff-stat";
import { formatDiffCount } from "@/git/file-header-presentation";
import { useStableEvent } from "@/hooks/use-stable-event";
import { getOverlayRoot } from "@/lib/overlay-root";

function formatStatNumbers(
  stat: LineStat,
  exact: boolean,
): { add: string | null; del: string | null } {
  return {
    add:
      stat.additions !== 0
        ? `+${exact ? stat.additions.toLocaleString() : formatDiffCount(stat.additions)}`
        : null,
    del:
      stat.deletions !== 0
        ? `-${exact ? stat.deletions.toLocaleString() : formatDiffCount(stat.deletions)}`
        : null,
  };
}

function InlineStatNumbers({
  stat,
  exact = false,
  muted = false,
}: {
  stat: LineStat;
  exact?: boolean;
  muted?: boolean;
}) {
  if (stat.additions === 0 && stat.deletions === 0) return null;
  const { add, del } = formatStatNumbers(stat, exact);
  return (
    <span style={statNumbersRowStyle}>
      {add ? <span style={muted ? mutedStatStyle : additionsStyle}>{add}</span> : null}
      {del ? <span style={muted ? mutedStatStyle : deletionsStyle}>{del}</span> : null}
    </span>
  );
}

function DrilldownRow({
  label,
  stat,
  indent = false,
}: {
  label: string;
  stat: LineStat;
  indent?: boolean;
}) {
  return (
    <div style={indent ? drilldownRowIndentStyle : drilldownRowStyle}>
      <span style={drilldownLabelStyle}>{label}</span>
      <InlineStatNumbers stat={stat} exact />
    </div>
  );
}

function DiffDrilldownContent({ diffStat }: { diffStat: DiffStat }) {
  const { t } = useTranslation();
  const { breakdown } = useMemo(() => sumDiffStats([diffStat]), [diffStat]);

  if (!breakdown) {
    return (
      <div style={drilldownBodyStyle}>
        <DrilldownRow label={t("changeStats.total")} stat={diffStat} />
        <div style={drilldownNoteStyle}>{t("changeStats.unavailable")}</div>
      </div>
    );
  }

  const production = productionStat(breakdown);
  const excluded = CHANGE_CATEGORIES.filter(
    (category) => !PRODUCTION_CATEGORIES.some((entry) => entry === category),
  );
  const prodRows = PRODUCTION_CATEGORIES.filter(
    (category) => breakdown[category].additions || breakdown[category].deletions,
  );
  const excludedRows = excluded.filter(
    (category) => breakdown[category].additions || breakdown[category].deletions,
  );
  const hasEstimates =
    breakdown.commentsIncluded.additions > 0 || breakdown.commentsIncluded.deletions > 0;

  return (
    <div style={drilldownBodyStyle}>
      <DrilldownRow label={t("changeStats.total")} stat={diffStat} />
      <DrilldownRow label={t("changeStats.production")} stat={production} />
      {prodRows.map((category) => (
        <DrilldownRow
          key={category}
          label={t(`changeStats.categories.${category}`)}
          stat={breakdown[category]}
          indent
        />
      ))}
      {excludedRows.map((category) => (
        <DrilldownRow
          key={category}
          label={t(`changeStats.categories.${category}`)}
          stat={breakdown[category]}
        />
      ))}
      {hasEstimates ? (
        <div style={drilldownEstimateStyle}>
          <div style={drilldownNoteStyle}>{t("changeStats.commentsIncluded")}</div>
          <InlineStatNumbers stat={breakdown.commentsIncluded} exact />
        </div>
      ) : null}
    </div>
  );
}

/**
 * Compact Paseo diff-stat badge for Editable branch cards & inline chat headers:
 * shows only production changes (matching sidebar ChangeStats, falling back to muted total
 * when there are no production code lines), with the full Paseo category drilldown on hover.
 */
export function EditableDiffStat({ diffStat }: { diffStat: DiffStat | null | undefined }) {
  const { t } = useTranslation();
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
            ...drilldownCardStyle,
            right: pos.right,
            bottom: pos.bottom,
          } as const)
        : null,
    [pos],
  );

  if (!diffStat || (diffStat.additions === 0 && diffStat.deletions === 0)) {
    return null;
  }

  const breakdown = diffStat.breakdown;
  const code = breakdown ? productionStat(breakdown) : null;
  const hasCode = code !== null && (code.additions !== 0 || code.deletions !== 0);
  const displayedStat: LineStat = hasCode ? code : diffStat;

  return (
    <span
      ref={anchorRef}
      tabIndex={0}
      aria-label={t("changeStats.title")}
      data-ed-diff-stat="true"
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      style={diffAnchorStyle}
    >
      <InlineStatNumbers stat={displayedStat} muted={!hasCode} />
      {floatingStyle && typeof document !== "undefined"
        ? createPortal(
            <div
              role="tooltip"
              data-ed-overlay="true"
              data-ed-diff-drilldown="true"
              style={floatingStyle}
            >
              <DiffDrilldownContent diffStat={diffStat} />
            </div>,
            getOverlayRoot(),
          )
        : null}
    </span>
  );
}

const diffAnchorStyle = {
  display: "inline-flex",
  alignItems: "center",
  flexShrink: 0,
  cursor: "help",
  padding: "1px 4px",
  borderRadius: 4,
  font: "500 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

const statNumbersRowStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  flexShrink: 0,
} as const;

const additionsStyle = { color: "#4ade80" } as const;
const deletionsStyle = { color: "#f87171" } as const;
const mutedStatStyle = { color: "#94a3b8" } as const;

const drilldownCardStyle = {
  position: "fixed",
  zIndex: 999999,
  minWidth: 224,
  maxWidth: 280,
  padding: "8px 10px",
  borderRadius: 8,
  background: "#0b0e14",
  color: "#e2e8f0",
  border: "1px solid rgba(255, 255, 255, 0.18)",
  boxShadow: "0 12px 30px rgba(0, 0, 0, 0.7)",
  font: "400 11px/16px system-ui, -apple-system, sans-serif",
  whiteSpace: "normal",
  pointerEvents: "none",
} as const;

const drilldownBodyStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
} as const;

const drilldownRowStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
} as const;

const drilldownRowIndentStyle = {
  ...drilldownRowStyle,
  paddingLeft: 10,
} as const;

const drilldownLabelStyle = {
  color: "#94a3b8",
  fontSize: 11,
} as const;

const drilldownNoteStyle = {
  color: "#94a3b8",
  fontSize: 10,
  lineHeight: "14px",
} as const;

const drilldownEstimateStyle = {
  borderTop: "1px solid rgba(255, 255, 255, 0.1)",
  paddingTop: 5,
  marginTop: 3,
  display: "flex",
  flexDirection: "column",
  gap: 2,
} as const;
