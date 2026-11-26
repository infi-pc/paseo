import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useStableEvent } from "@/hooks/use-stable-event";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { EditableChatView } from "./EditableChatView.web";
import {
  EditableHoverTooltip,
  EditableLoadButton,
  EditableShipButton,
} from "./EditableTooltip.web";
import type {
  EditableBranchAgentRecord,
  EditableBranchEntry,
  EditableBranchesSnapshot,
  EditableDesktopBridge,
  EditableDesktopStatus,
  EditableReferencedElement,
  EditableService,
  EditableWorkshopDaemonStatus,
} from "./types";

export const pillStyle = {
  borderRadius: 6,
  padding: "4px 8px",
  background: "#161a22",
  color: "#f8fafc",
  border: "1px solid rgba(255, 255, 255, 0.16)",
  boxShadow: "0 6px 18px rgba(0, 0, 0, 0.42)",
  font: "500 11px/16px system-ui, -apple-system, sans-serif",
  whiteSpace: "nowrap",
} as const;

export interface EditableStatusWorkshopInfo {
  editing: boolean;
  sending?: boolean;
  startingWorkshop?: boolean;
  managedWorkshop?: boolean;
  hostId?: string | null;
  host?: { serverId: string; label: string } | undefined;
  isConnected?: boolean;
  agentId?: string | null;
  branchAgents?: Record<string, EditableBranchAgentRecord>;
  pendingBranches?: Record<string, { slug: string; request: string; createdAt: string }>;
  agentStatuses?: Record<string, string>;
  agentReplies?: Record<string, string>;
  unreadReplySlugs?: string[];
  runningSlugs?: string[];
  lastRequest?: string | null;
  workshopError?: string | null;
  startWorkshop?: () => Promise<unknown>;
  clearBranchAgent?: (slug: string, options?: { archive?: boolean }) => void;
  markReplyRead?: (slug: string) => void;
}

type StatusTone = "green" | "blue" | "amber" | "red" | "gray";

const PULSE_CSS =
  "@keyframes paseoEdBlink{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(245,158,11,0.75)}50%{opacity:0.4;box-shadow:0 0 0 5px rgba(245,158,11,0)}}@keyframes paseoEdWork{0%,100%{opacity:1;box-shadow:0 0 0 0 rgba(65,145,251,0.7)}50%{opacity:0.45;box-shadow:0 0 0 4px rgba(65,145,251,0)}}";

const dotBaseStyle = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  display: "inline-block",
  flexShrink: 0,
} as const;

const DOT_STYLES: Record<StatusTone, React.CSSProperties> = {
  green: { ...dotBaseStyle, background: "#22c55e" },
  blue: { ...dotBaseStyle, background: "#4191fb" },
  amber: { ...dotBaseStyle, background: "#f59e0b" },
  red: { ...dotBaseStyle, background: "#ef4444" },
  gray: { ...dotBaseStyle, background: "#64748b" },
};

const BLINK_DOT_STYLE: React.CSSProperties = {
  ...dotBaseStyle,
  background: "#f59e0b",
  animation: "paseoEdBlink 1.3s ease-in-out infinite",
};

const WORK_DOT_STYLE: React.CSSProperties = {
  ...dotBaseStyle,
  background: "#4191fb",
  animation: "paseoEdWork 1.4s ease-in-out infinite",
};

function StatusDot({ tone, pulse }: { tone: StatusTone; pulse?: "update" | "work" | null }) {
  if (pulse === "update") return <span data-ed-blink="true" style={BLINK_DOT_STYLE} />;
  if (pulse === "work") return <span style={WORK_DOT_STYLE} />;
  return <span style={DOT_STYLES[tone]} />;
}

function useDismissPopover(
  open: boolean,
  rootRef: React.RefObject<HTMLDivElement | null>,
  onClose: () => void,
  options: { suppressDismiss?: boolean; keepOpenOnAltClick?: boolean } = {},
) {
  const { suppressDismiss = false, keepOpenOnAltClick = false } = options;
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (suppressDismiss || (keepOpenOnAltClick && event.altKey)) return;
      if (
        rootRef.current &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (suppressDismiss) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open, rootRef, onClose, suppressDismiss, keepOpenOnAltClick]);
}

interface MergedBranchRow {
  slug: string;
  channel: string;
  isMain: boolean;
  status: "ready" | "working" | "draft" | "idle" | "shipping" | "failed";
  summary: string | null;
  replyPreview: string | null;
  hasUnreadReply: boolean;
  generation: number | null;
  releaseDigest: string | null;
  daemonReleaseDigest: string | null;
  services: EditableService[];
  hasChanges: boolean;
  behindMain: boolean;
  canFastForward: boolean;
  requiresDaemon: boolean;
  hasUpdate: boolean;
  hasUiUpdate: boolean;
  hasDaemonUpdate: boolean;
  requiresDaemonRestartOnLoad: boolean;
  loaded: boolean;
  agentId: string | null;
  error: string | null;
}

function inferRowServices(input: {
  explicit?: EditableService[];
  releaseDigest: string | null;
  daemonReleaseDigest: string | null;
  requiresDaemon: boolean;
}): EditableService[] {
  if (input.explicit && input.explicit.length > 0) return input.explicit;
  const services: EditableService[] = [];
  if (input.releaseDigest) services.push("ui");
  if (input.daemonReleaseDigest || input.requiresDaemon) services.push("daemon");
  return services;
}

function pickFirst<T>(...values: Array<T | null | undefined>): T | null {
  for (const v of values) {
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function resolveMainRowUpdates(
  b: EditableBranchEntry | undefined,
  loadedChannel: string,
  statusUpdate: string | null,
) {
  const hasUiUpdate =
    Boolean(b?.hasUiUpdate) || (loadedChannel === "prod" && Boolean(statusUpdate));
  const hasDaemonUpdate = Boolean(b?.hasDaemonUpdate);
  return {
    hasUpdate: Boolean(b?.hasUpdate) || hasUiUpdate || hasDaemonUpdate,
    hasUiUpdate,
    hasDaemonUpdate,
  };
}

function buildMainRow(
  status: EditableDesktopStatus | null,
  branches: EditableBranchesSnapshot | null,
  loadedChannel: string,
  safe: boolean,
  statusUpdate: string | null,
): MergedBranchRow {
  const b = branches?.main;
  const updates = resolveMainRowUpdates(b, loadedChannel, statusUpdate);
  const loaded = b ? b.loaded : !safe && loadedChannel === "prod";
  const statusGen = status && status.activeGeneration > 0 ? status.activeGeneration : null;
  return {
    slug: "main",
    channel: "prod",
    isMain: true,
    status: "ready",
    summary: pickFirst(b?.summary, status?.releaseSummary),
    replyPreview: null,
    hasUnreadReply: false,
    generation: pickFirst(b?.generation, statusGen),
    releaseDigest: pickFirst(b?.releaseDigest, status?.releaseDigest),
    daemonReleaseDigest: pickFirst(b?.daemonReleaseDigest, status?.activeDaemonDigest),
    services: b?.services ?? [],
    hasChanges: false,
    behindMain: false,
    canFastForward: false,
    requiresDaemon: false,
    ...updates,
    requiresDaemonRestartOnLoad: Boolean(b?.requiresDaemonRestartOnLoad),
    loaded,
    agentId: null,
    error: null,
  };
}

function buildPendingWipRow(
  rec: { slug: string; request: string; agentId: string | null },
  liveStatus: string | undefined,
  replyPreview: string | null,
  hasUnreadReply: boolean,
): MergedBranchRow {
  const running =
    liveStatus === "running" || liveStatus === "initializing" || liveStatus === undefined;
  return {
    slug: rec.slug,
    channel: `wip-${rec.slug}`,
    isMain: false,
    status: running ? "working" : "idle",
    summary: rec.request,
    replyPreview,
    hasUnreadReply,
    generation: null,
    releaseDigest: null,
    daemonReleaseDigest: null,
    services: [],
    hasChanges: false,
    behindMain: false,
    canFastForward: false,
    requiresDaemon: false,
    hasUpdate: false,
    hasUiUpdate: false,
    hasDaemonUpdate: false,
    requiresDaemonRestartOnLoad: false,
    loaded: false,
    agentId: rec.agentId,
    error: null,
  };
}

function resolveMergedWipStatus(
  entry: EditableBranchEntry,
  options: { isShipping: boolean; isAgentRunning: boolean; hasChanges: boolean },
): MergedBranchRow["status"] {
  if (options.isShipping || entry.status === "shipping") return "shipping";
  if (options.isAgentRunning) return "working";
  if (!options.hasChanges && entry.status !== "failed") return "idle";
  return entry.status;
}

function resolveWipUpdateFlags(
  b: EditableBranchEntry,
  hasChanges: boolean,
  statusUpdate: string | null,
) {
  if (!hasChanges) {
    return { hasUpdate: false, hasUiUpdate: false, hasDaemonUpdate: false };
  }
  const hasUiUpdate = Boolean(b.hasUiUpdate) || (b.loaded && Boolean(statusUpdate));
  const hasDaemonUpdate = Boolean(b.hasDaemonUpdate);
  return {
    hasUpdate: b.hasUpdate || hasUiUpdate || hasDaemonUpdate,
    hasUiUpdate,
    hasDaemonUpdate,
  };
}

function mergeWipEntryRow(
  b: EditableBranchEntry,
  ctx: {
    clientAgent: EditableBranchAgentRecord | undefined;
    pending: { slug: string; request: string } | undefined;
    liveStatus: string | undefined;
    replyPreview: string | null;
    hasUnreadReply: boolean;
    shippingSlugs: Set<string>;
    statusUpdate: string | null;
  },
): MergedBranchRow {
  const isAgentRunning =
    Boolean(ctx.pending) || ctx.liveStatus === "running" || ctx.liveStatus === "initializing";
  const hasChanges = b.hasChanges ?? Boolean(b.releaseDigest || b.daemonReleaseDigest);
  const mergedStatus = resolveMergedWipStatus(b, {
    isShipping: ctx.shippingSlugs.has(b.slug),
    isAgentRunning,
    hasChanges,
  });
  const releaseDigest = hasChanges ? b.releaseDigest : null;
  const daemonReleaseDigest = hasChanges ? (b.daemonReleaseDigest ?? null) : null;
  const updates = resolveWipUpdateFlags(b, hasChanges, ctx.statusUpdate);

  return {
    slug: b.slug,
    channel: b.channel,
    isMain: false,
    status: mergedStatus,
    summary: pickFirst(b.summary, ctx.pending?.request, ctx.clientAgent?.request),
    replyPreview: ctx.replyPreview,
    hasUnreadReply: ctx.hasUnreadReply,
    generation: b.generation,
    releaseDigest,
    daemonReleaseDigest,
    services: hasChanges
      ? inferRowServices({
          explicit: b.services,
          releaseDigest,
          daemonReleaseDigest,
          requiresDaemon: b.requiresDaemon,
        })
      : [],
    hasChanges,
    behindMain: b.behindMain,
    canFastForward: hasChanges && b.canFastForward,
    requiresDaemon: b.requiresDaemon || Boolean(daemonReleaseDigest),
    ...updates,
    requiresDaemonRestartOnLoad: Boolean(b.requiresDaemonRestartOnLoad),
    loaded: b.loaded,
    agentId: ctx.clientAgent?.agentId ?? b.agentId,
    error: b.error,
  };
}

function resolveLoadedContext(
  status: EditableDesktopStatus | null,
  branches: EditableBranchesSnapshot | null,
) {
  const loadedChannel = branches?.loadedChannel ?? status?.activeChannel ?? "prod";
  const safe = Boolean(branches?.safeRenderer ?? status?.safeRenderer);
  const candidate = status?.availableDigest ?? status?.activeDigest ?? null;
  const statusUpdate = !safe && candidate !== status?.releaseDigest ? candidate : null;
  return { loadedChannel, safe, statusUpdate };
}

function buildBranchRows(
  status: EditableDesktopStatus | null,
  branches: EditableBranchesSnapshot | null,
  workshop: EditableStatusWorkshopInfo,
  shippingSlugs: Set<string>,
): { main: MergedBranchRow; wips: MergedBranchRow[] } {
  const { loadedChannel, safe, statusUpdate } = resolveLoadedContext(status, branches);
  const main = buildMainRow(status, branches, loadedChannel, safe, statusUpdate);
  const agentStatuses = workshop.agentStatuses ?? {};
  const agentReplies = workshop.agentReplies ?? {};
  const unreadSet = new Set(workshop.unreadReplySlugs ?? []);
  const clientAgents = workshop.branchAgents ?? {};
  const pendingBranches = workshop.pendingBranches ?? {};
  const bySlug = new Map<string, MergedBranchRow>();

  for (const pending of Object.values(pendingBranches)) {
    const rec = clientAgents[pending.slug];
    bySlug.set(
      pending.slug,
      buildPendingWipRow(
        { slug: pending.slug, request: pending.request, agentId: rec?.agentId ?? null },
        agentStatuses[pending.slug] ?? "initializing",
        agentReplies[pending.slug] ?? null,
        unreadSet.has(pending.slug),
      ),
    );
  }

  for (const b of branches?.branches ?? []) {
    bySlug.set(
      b.slug,
      mergeWipEntryRow(b, {
        clientAgent: clientAgents[b.slug],
        pending: pendingBranches[b.slug],
        liveStatus: agentStatuses[b.slug],
        replyPreview: agentReplies[b.slug] ?? null,
        hasUnreadReply: unreadSet.has(b.slug),
        shippingSlugs,
        statusUpdate,
      }),
    );
  }

  for (const rec of Object.values(clientAgents)) {
    if (bySlug.has(rec.slug)) continue;
    const st = agentStatuses[rec.slug];
    if (st !== "closed" && st !== "archived") {
      bySlug.set(
        rec.slug,
        buildPendingWipRow(rec, st, agentReplies[rec.slug] ?? null, unreadSet.has(rec.slug)),
      );
    }
  }

  return { main, wips: Array.from(bySlug.values()) };
}

function rowTone(row: MergedBranchRow): { tone: StatusTone; pulse: "update" | "work" | null } {
  if (row.hasUpdate) return { tone: "amber", pulse: "update" };
  if (row.status === "working" || row.status === "shipping") return { tone: "blue", pulse: "work" };
  if (row.status === "failed") return { tone: "red", pulse: null };
  if (row.hasUnreadReply) return { tone: "blue", pulse: null };
  if (row.loaded || row.status === "ready") return { tone: "green", pulse: null };
  if (row.status === "draft") return { tone: "amber", pulse: null };
  return { tone: "gray", pulse: null };
}

function describeUiCompositionPart(row: MergedBranchRow): string {
  if (!row.releaseDigest) return "built-in";
  if (row.isMain && row.generation) return `v${row.generation}`;
  return row.slug;
}

function describeDaemonCompositionPart(
  row: MergedBranchRow,
  branches: EditableBranchesSnapshot,
): string {
  if (!branches.loadedDaemonDigest) return "built-in";
  if (row.daemonReleaseDigest !== branches.loadedDaemonDigest) return "main";
  if (row.isMain) return `v${branches.mainDaemonGeneration ?? row.generation ?? 1}`;
  return row.slug;
}

function formatLoadedCompositionTooltip(
  row: MergedBranchRow,
  branches: EditableBranchesSnapshot | null,
  t: (key: string) => string,
): string {
  if (!branches) return t("editable.tooltipLoaded");
  const uiPart = describeUiCompositionPart(row);
  const daemonPart = describeDaemonCompositionPart(row, branches);
  return `${t("editable.tooltipLoaded")} (UI: ${uiPart} · Daemon: ${daemonPart})`;
}

function MainBranchRow({
  row,
  branches,
  busy,
  hasLoadBranch,
  onLoad,
  onReload,
}: {
  row: MergedBranchRow;
  branches: EditableBranchesSnapshot | null;
  busy: boolean;
  hasLoadBranch: boolean;
  onLoad: (channel: string) => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const { tone, pulse } = rowTone(row);
  const handleLoad = useStableEvent(() => onLoad("prod"));
  const daemonListen = branches?.daemonListen ?? null;

  return (
    <div style={row.loaded ? branchRowActiveStyle : branchRowStyle}>
      <div style={rowBetweenStyle}>
        <div style={titleRowStyle}>
          <StatusDot tone={tone} pulse={pulse} />
          <span style={branchNameStyle}>main</span>
          {row.generation ? <span style={mutedBadgeStyle}>v{row.generation}</span> : null}
        </div>
        <div style={inlineActionsStyle}>
          {row.loaded && row.hasUpdate ? (
            <EditableLoadButton
              label={hasLoadBranch ? t("editable.reloadRelease") : t("editable.applyRelease")}
              variant="default"
              disabled={busy}
              restartsRunningDaemon={row.requiresDaemonRestartOnLoad}
              daemonListen={daemonListen}
              onPress={onReload}
            />
          ) : null}
          {row.loaded && !row.hasUpdate ? (
            <InfoBadge
              label={t("editable.loadedBadge")}
              tooltip={formatLoadedCompositionTooltip(row, branches, t)}
              style={loadedBadgeStyle}
            />
          ) : null}
          {!row.loaded && hasLoadBranch ? (
            <EditableLoadButton
              label={t("editable.loadBranch")}
              variant="ghost"
              disabled={busy}
              restartsRunningDaemon={row.requiresDaemonRestartOnLoad}
              daemonListen={daemonListen}
              onPress={handleLoad}
            />
          ) : null}
        </div>
      </div>
      {row.summary ? <div style={summaryStyle}>{truncate(row.summary, 84)}</div> : null}
    </div>
  );
}

function InfoBadge({
  label,
  tooltip,
  style,
}: {
  label: string;
  tooltip: string;
  style: React.CSSProperties;
}) {
  return (
    <EditableHoverTooltip tooltip={tooltip} style={style} focusable>
      {label}
    </EditableHoverTooltip>
  );
}

function resolveServiceBadge(
  service: EditableService,
  row: MergedBranchRow,
  t: (key: string) => string,
): { label: string; tooltip: string; style: React.CSSProperties } {
  if (service === "ui") {
    return {
      label: t("editable.serviceUi"),
      tooltip: t("editable.tooltipServiceUi"),
      style: uiServiceBadgeStyle,
    };
  }
  if (service === "daemon") {
    return {
      label: t("editable.serviceDaemon"),
      tooltip: row.daemonReleaseDigest
        ? t("editable.tooltipServiceDaemonReady")
        : t("editable.tooltipServiceDaemonUnstaged"),
      style: warnTagStyle,
    };
  }
  if (service === "desktop") {
    return {
      label: t("editable.serviceDesktop"),
      tooltip: t("editable.tooltipServiceDesktop"),
      style: failedBadgeStyle,
    };
  }
  return {
    label: t("editable.serviceIos"),
    tooltip: t("editable.tooltipServiceIos"),
    style: mutedBadgeStyle,
  };
}

function ServiceBadges({ row }: { row: MergedBranchRow }) {
  const { t } = useTranslation();
  if (!row.hasChanges || row.services.length === 0) return null;
  return (
    <>
      {row.services.map((service) => {
        const badge = resolveServiceBadge(service, row, t);
        return (
          <InfoBadge
            key={service}
            label={badge.label}
            tooltip={badge.tooltip}
            style={badge.style}
          />
        );
      })}
    </>
  );
}

function resolveStatusBadgeProps(
  row: MergedBranchRow,
  branches: EditableBranchesSnapshot | null,
  t: (key: string) => string,
): { label: string; tooltip: string; style: React.CSSProperties } {
  if (row.loaded) {
    return {
      label: t("editable.loadedBadge"),
      tooltip: formatLoadedCompositionTooltip(row, branches, t),
      style: loadedBadgeStyle,
    };
  }
  if (row.status === "shipping") {
    return {
      label: row.behindMain ? t("editable.updatingBranch") : t("editable.shippingBranch"),
      tooltip: row.behindMain ? t("editable.tooltipUpdating") : t("editable.tooltipShipping"),
      style: workingBadgeStyle,
    };
  }
  if (row.status === "working") {
    return {
      label: t("editable.workingBadge"),
      tooltip: t("editable.tooltipWorking"),
      style: workingBadgeStyle,
    };
  }
  if (row.status === "failed") {
    return {
      label: t("editable.failedBadge"),
      tooltip: row.error || t("editable.tooltipFailed"),
      style: failedBadgeStyle,
    };
  }
  if (row.status === "ready") {
    let tooltip = t("editable.tooltipReadyDaemonOnly");
    if (row.releaseDigest && row.daemonReleaseDigest) {
      tooltip = t("editable.tooltipReadyUiAndDaemon");
    } else if (row.releaseDigest) {
      tooltip = t("editable.tooltipReadyUi");
    } else if (row.daemonReleaseDigest) {
      tooltip = t("editable.tooltipReadyDaemonHotSwap");
    }
    return {
      label: t("editable.readyBadge"),
      tooltip,
      style: readyBadgeStyle,
    };
  }
  if (row.status === "draft") {
    return {
      label: t("editable.draftBadge"),
      tooltip: t("editable.tooltipDraft"),
      style: warnTagStyle,
    };
  }
  if (row.hasUnreadReply) {
    return {
      label: t("editable.repliedBadge"),
      tooltip: t("editable.tooltipReplied"),
      style: workingBadgeStyle,
    };
  }
  return {
    label: t("editable.noChangesBadge"),
    tooltip: t("editable.tooltipNoChanges"),
    style: mutedBadgeStyle,
  };
}

function WipBranchStatusBadge({
  row,
  branches,
}: {
  row: MergedBranchRow;
  branches: EditableBranchesSnapshot | null;
}) {
  const { t } = useTranslation();
  const badge = resolveStatusBadgeProps(row, branches, t);
  return <InfoBadge label={badge.label} tooltip={badge.tooltip} style={badge.style} />;
}

function WipBranchActions({
  row,
  daemonListen,
  isBusyRow,
  canOpenChat,
  canManage,
  onLoad,
  onShip,
  onDiscard,
  onChat,
}: {
  row: MergedBranchRow;
  daemonListen: string | null;
  isBusyRow: boolean;
  canOpenChat: boolean;
  canManage: boolean;
  onLoad: () => void;
  onShip: () => void;
  onDiscard: () => void;
  onChat: () => void;
}) {
  const { t } = useTranslation();
  const hasLoadableBuild = Boolean(row.releaseDigest || row.daemonReleaseDigest);
  const canLoad = canManage && row.hasChanges && hasLoadableBuild && (!row.loaded || row.hasUpdate);
  const canShip = canManage && row.hasChanges && row.status === "ready";

  return (
    <div style={actionsRowStyle}>
      {canLoad ? (
        <EditableLoadButton
          label={row.hasUpdate ? t("editable.reloadRelease") : t("editable.loadBranch")}
          variant={row.hasUpdate ? "default" : "ghost"}
          disabled={isBusyRow}
          restartsRunningDaemon={row.requiresDaemonRestartOnLoad}
          daemonListen={daemonListen}
          onPress={onLoad}
        />
      ) : null}
      {canShip ? (
        <EditableShipButton
          canFastForward={row.canFastForward}
          hasUiBuild={Boolean(row.releaseDigest)}
          hasDaemonBuild={Boolean(row.daemonReleaseDigest || row.requiresDaemon)}
          disabled={isBusyRow}
          onPress={onShip}
        />
      ) : null}
      {canOpenChat && row.agentId ? (
        <Button size="sm" variant={row.hasUnreadReply ? "default" : "ghost"} onPress={onChat}>
          {t("editable.openChatShort")}
        </Button>
      ) : null}
      {canManage && row.status !== "shipping" ? (
        <Button size="sm" variant="ghost" disabled={isBusyRow} onPress={onDiscard}>
          ×
        </Button>
      ) : null}
    </div>
  );
}

function WipBranchRow({
  row,
  branches,
  busy,
  canOpenChat,
  canManage,
  onLoad,
  onShip,
  onDiscard,
  onOpenChat,
}: {
  row: MergedBranchRow;
  branches: EditableBranchesSnapshot | null;
  busy: boolean;
  canOpenChat: boolean;
  canManage: boolean;
  onLoad: (channel: string) => void;
  onShip: (slug: string) => void;
  onDiscard: (slug: string) => void;
  onOpenChat: (slug: string, agentId: string) => void;
}) {
  const { t } = useTranslation();
  const { tone, pulse } = rowTone(row);
  const handleLoad = useStableEvent(() => onLoad(row.channel));
  const handleShip = useStableEvent(() => onShip(row.slug));
  const handleDiscard = useStableEvent(() => onDiscard(row.slug));
  const handleChat = useStableEvent(() => {
    if (row.agentId) onOpenChat(row.slug, row.agentId);
  });

  const isBusyRow = busy || row.status === "shipping";
  const showReplyPreview = Boolean(row.replyPreview && (!row.hasChanges || row.hasUnreadReply));
  const subtitle = showReplyPreview ? row.replyPreview : row.summary;

  return (
    <div style={row.loaded ? branchRowActiveStyle : branchRowStyle}>
      <div style={rowBetweenStyle}>
        <div style={titleRowStyle}>
          <StatusDot tone={tone} pulse={pulse} />
          <span style={branchNameStyle}>{row.slug}</span>
        </div>
        <div style={inlineActionsStyle}>
          <ServiceBadges row={row} />
          {row.hasChanges && row.behindMain ? (
            <InfoBadge
              label={t("editable.behindMain")}
              tooltip={t("editable.tooltipBehindMain")}
              style={mutedBadgeStyle}
            />
          ) : null}
          <WipBranchStatusBadge row={row} branches={branches} />
        </div>
      </div>

      {subtitle ? (
        <div style={showReplyPreview ? replyPreviewStyle : summaryStyle}>
          {truncate(subtitle, 96)}
        </div>
      ) : null}
      {row.error ? <div style={errorTextStyle}>{truncate(row.error, 100)}</div> : null}

      <WipBranchActions
        row={row}
        daemonListen={branches?.daemonListen ?? null}
        isBusyRow={isBusyRow}
        canOpenChat={canOpenChat}
        canManage={canManage}
        onLoad={handleLoad}
        onShip={handleShip}
        onDiscard={handleDiscard}
        onChat={handleChat}
      />
    </div>
  );
}

function WorkshopFooter({
  bridge,
  branches,
  workshop,
  workshopDaemon,
  workshopState,
  recovery,
  busy,
  onStartWorkshop,
  onSync,
  onRecover,
}: {
  bridge: EditableDesktopBridge | undefined;
  branches: EditableBranchesSnapshot | null;
  workshop: EditableStatusWorkshopInfo;
  workshopDaemon: EditableWorkshopDaemonStatus | null;
  workshopState: { label: string; tone: StatusTone; ready: boolean };
  recovery: boolean;
  busy: boolean;
  onStartWorkshop: () => void;
  onSync: () => void;
  onRecover: () => void;
}) {
  const { t } = useTranslation();
  const showStart = workshop.managedWorkshop && workshopDaemon?.status !== "running";
  const fallbackRestartsDaemon = Boolean(branches?.daemonRunning && branches?.loadedDaemonDigest);
  return (
    <div style={footerStyle}>
      <div style={rowBetweenStyle}>
        <div style={titleRowStyle}>
          <StatusDot tone={workshopState.tone} />
          <span style={mutedStyle}>{workshopState.label}</span>
        </div>
        <div style={inlineActionsStyle}>
          {showStart ? (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy || !!workshop.startingWorkshop}
              onPress={onStartWorkshop}
            >
              {t("editable.startWorkshop")}
            </Button>
          ) : null}
          {bridge?.syncNow || bridge?.syncFromCloudShelf ? (
            <Button size="sm" variant="ghost" disabled={busy} onPress={onSync}>
              {busy ? t("editable.syncing") : t("editable.syncCloud")}
            </Button>
          ) : null}
          {bridge && !recovery ? (
            <EditableLoadButton
              label={t("editable.fallbackUi")}
              variant="ghost"
              disabled={busy}
              restartsRunningDaemon={fallbackRestartsDaemon}
              daemonListen={branches?.daemonListen ?? null}
              onPress={onRecover}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StatusPopover({
  bridge,
  branches,
  main,
  wips,
  workshop,
  workshopDaemon,
  workshopState,
  dotTone,
  dotPulse,
  preview,
  recovery,
  busy,
  syncMessage,
  errorText,
  onPick,
  onLoadBranch,
  onReloadLoaded,
  onShipBranch,
  onDiscardBranch,
  onOpenChat,
  onStartWorkshop,
  onSync,
  onExitPreview,
  onRecover,
}: {
  bridge: EditableDesktopBridge | undefined;
  branches: EditableBranchesSnapshot | null;
  main: MergedBranchRow;
  wips: MergedBranchRow[];
  workshop: EditableStatusWorkshopInfo;
  workshopDaemon: EditableWorkshopDaemonStatus | null;
  workshopState: { label: string; tone: StatusTone; ready: boolean };
  dotTone: StatusTone;
  dotPulse: "update" | "work" | null;
  preview: boolean;
  recovery: boolean;
  busy: boolean;
  syncMessage: string | null;
  errorText: string | null;
  onPick: () => void;
  onLoadBranch: (channel: string) => void;
  onReloadLoaded: () => void;
  onShipBranch: (slug: string) => void;
  onDiscardBranch: (slug: string) => void;
  onOpenChat: (slug: string, agentId: string) => void;
  onStartWorkshop: () => void;
  onSync: () => void;
  onExitPreview: () => void;
  onRecover: () => void;
}) {
  const { t } = useTranslation();
  const canOpenChat = Boolean(workshop.hostId);
  const canManage = Boolean(bridge?.loadBranch);

  return (
    <div role="dialog" aria-label={t("editable.statusTitle")} style={popoverStyle}>
      <div style={rowBetweenStyle}>
        <div style={titleRowStyle}>
          <StatusDot tone={dotTone} pulse={dotPulse} />
          <strong style={titleTextStyle}>{t("editable.statusTitle")}</strong>
        </div>
        <Button size="sm" variant="ghost" onPress={onPick}>
          {t("editable.pickButton")}
        </Button>
      </div>

      {preview && bridge ? (
        <div style={previewBannerStyle}>
          <span>{t("editable.preview")}</span>
          <Button size="sm" disabled={busy} onPress={onExitPreview}>
            {t("editable.exitPreview")}
          </Button>
        </div>
      ) : null}

      <div style={sectionStyle}>
        <div style={sectionLabelStyle}>{t("editable.branchesLabel")}</div>
        <div style={branchListStyle}>
          <MainBranchRow
            row={main}
            branches={branches}
            busy={busy}
            hasLoadBranch={canManage}
            onLoad={onLoadBranch}
            onReload={onReloadLoaded}
          />
          {wips.map((row) => (
            <WipBranchRow
              key={row.slug}
              row={row}
              branches={branches}
              busy={busy}
              canOpenChat={canOpenChat}
              canManage={canManage}
              onLoad={onLoadBranch}
              onShip={onShipBranch}
              onDiscard={onDiscardBranch}
              onOpenChat={onOpenChat}
            />
          ))}
        </div>
        {syncMessage ? <div style={mutedStyle}>{syncMessage}</div> : null}
      </div>

      <WorkshopFooter
        bridge={bridge}
        branches={branches}
        workshop={workshop}
        workshopDaemon={workshopDaemon}
        workshopState={workshopState}
        recovery={recovery}
        busy={busy}
        onStartWorkshop={onStartWorkshop}
        onSync={onSync}
        onRecover={onRecover}
      />

      {errorText ? (
        <div role="alert" style={errorTextStyle}>
          {errorText}
        </div>
      ) : null}
    </div>
  );
}

function StatusTriggerBar({
  open,
  dotTone,
  dotPulse,
  pillLabel,
  badgeText,
  showExitPreview,
  showReload,
  reloadLabel,
  reloadRestartsDaemon,
  daemonListen,
  busy,
  onToggle,
  onExitPreview,
  onReload,
}: {
  open: boolean;
  dotTone: StatusTone;
  dotPulse: "update" | "work" | null;
  pillLabel: string;
  badgeText: string | null;
  showExitPreview: boolean;
  showReload: boolean;
  reloadLabel: string;
  reloadRestartsDaemon: boolean;
  daemonListen: string | null;
  busy: boolean;
  onToggle: () => void;
  onExitPreview: () => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div style={barStyle}>
      <button
        type="button"
        aria-label={t("editable.statusButton")}
        aria-expanded={open}
        onClick={onToggle}
        style={triggerButtonStyle}
      >
        <StatusDot tone={dotTone} pulse={dotPulse} />
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
        <span role="status">{pillLabel}</span>
        {badgeText ? <span style={pillBadgeStyle}>{badgeText}</span> : null}
      </button>
      {showExitPreview ? (
        <Button size="sm" disabled={busy} onPress={onExitPreview}>
          {t("editable.exitPreview")}
        </Button>
      ) : null}
      {showReload ? (
        <EditableLoadButton
          label={reloadLabel}
          variant="default"
          disabled={busy}
          restartsRunningDaemon={reloadRestartsDaemon}
          daemonListen={daemonListen}
          onPress={onReload}
        />
      ) : null}
    </div>
  );
}

function useBranchActions({
  bridge,
  status,
  loadedChannel,
  updateDigest,
  workshop,
  onPick,
  onRefresh,
  closePopover,
}: {
  bridge: EditableDesktopBridge | undefined;
  status: EditableDesktopStatus | null;
  loadedChannel: string;
  updateDigest: string | null;
  workshop: EditableStatusWorkshopInfo;
  onPick: () => void;
  onRefresh?: () => Promise<void>;
  closePopover: () => void;
}) {
  const { t } = useTranslation();
  const router = useRouter();
  const [failed, setFailed] = useState<string | null>(null);
  const [syncMessage, setSyncMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [shippingSlugs, setShippingSlugs] = useState<Set<string>>(() => new Set());

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailed(null);
    setSyncMessage(null);
    try {
      await action();
    } catch (error) {
      setFailed(error instanceof Error ? error.message : t("editable.desktopFailed"));
    } finally {
      setBusy(false);
    }
  }

  const loadBranch = useStableEvent((channel: string) => {
    if (!bridge?.loadBranch) return;
    void run(async () => {
      const res = await bridge.loadBranch!(channel);
      if (!res.ok) throw new Error(res.error ?? t("editable.desktopFailed"));
      await onRefresh?.();
    });
  });

  const reloadLoaded = useStableEvent(() => {
    if (!bridge) return;
    if (bridge.loadBranch) {
      loadBranch(loadedChannel);
      return;
    }
    const digest = updateDigest ?? status?.availableDigest ?? status?.activeDigest;
    if (!digest) return;
    void run(async () => {
      const res = await bridge.switchRelease(digest);
      if (!res.ok) throw new Error(res.error);
    });
  });

  const shipBranch = useStableEvent((slug: string) => {
    if (!bridge?.shipBranch) return;
    setFailed(null);
    setSyncMessage(null);
    setShippingSlugs((prev) => new Set(prev).add(slug));
    void (async () => {
      try {
        const res = await bridge.shipBranch!(slug);
        if (!res.ok) throw new Error(res.error ?? t("editable.desktopFailed"));
        workshop.clearBranchAgent?.(slug);
        await onRefresh?.();
        if (!res.autoLoaded) {
          setSyncMessage(t("editable.updateReady"));
        }
      } catch (error) {
        setFailed(error instanceof Error ? error.message : t("editable.desktopFailed"));
      } finally {
        setShippingSlugs((prev) => {
          const next = new Set(prev);
          next.delete(slug);
          return next;
        });
      }
    })();
  });

  const discardBranch = useStableEvent((slug: string) => {
    if (!bridge?.discardBranch) return;
    void run(async () => {
      const res = await bridge.discardBranch!(slug);
      if (!res.ok) throw new Error(res.error ?? t("editable.desktopFailed"));
      workshop.clearBranchAgent?.(slug, { archive: true });
      await onRefresh?.();
    });
  });

  const sync = useStableEvent(() => {
    const syncFn = bridge?.syncNow ?? bridge?.syncFromCloudShelf;
    if (!syncFn) return;
    void run(async () => {
      const res = await syncFn();
      if (!res.ok) throw new Error(res.error ?? t("editable.desktopFailed"));
      await onRefresh?.();
      if (!res.updated) setSyncMessage(t("editable.upToDate"));
    });
  });

  const openFullChat = useStableEvent((agentId: string) => {
    if (!workshop.hostId) return;
    closePopover();
    router.push(buildHostAgentDetailRoute(workshop.hostId, agentId) as never);
  });

  return {
    failed,
    syncMessage,
    busy,
    shippingSlugs,
    loadBranch,
    reloadLoaded,
    shipBranch,
    discardBranch,
    sync,
    openFullChat,
    exitPreview: useStableEvent(() => {
      if (bridge) void run(() => bridge.setPreviewUrl(null));
    }),
    recover: useStableEvent(() => {
      if (bridge) void run(() => bridge.useRecoveryRenderer());
    }),
    startWorkshop: useStableEvent(() => {
      if (!workshop.startWorkshop) return;
      void run(async () => {
        await workshop.startWorkshop!();
      });
    }),
    pickFromPopover: useStableEvent(() => {
      closePopover();
      onPick();
    }),
  };
}

function resolvePillDot(input: {
  hasError: boolean;
  recovery: boolean;
  loadedHasUpdate: boolean;
  working: boolean;
  unreadReply: boolean;
  preview: boolean;
  workshopReady: boolean;
}): { dotTone: StatusTone; dotPulse: "update" | "work" | null } {
  if (input.hasError || input.recovery) return { dotTone: "red", dotPulse: null };
  if (input.loadedHasUpdate) return { dotTone: "amber", dotPulse: "update" };
  if (input.working) return { dotTone: "blue", dotPulse: "work" };
  if (input.unreadReply) return { dotTone: "blue", dotPulse: null };
  if (input.preview) return { dotTone: "amber", dotPulse: null };
  return { dotTone: input.workshopReady ? "green" : "gray", dotPulse: null };
}

function resolvePillLabel(input: {
  failed: string | null;
  preview: boolean;
  recovery: boolean;
  loadedWip: MergedBranchRow | null;
  status: EditableDesktopStatus | null;
  main: MergedBranchRow;
  t: (key: string) => string;
}): string {
  if (input.failed) return input.t("editable.desktopFailed");
  if (input.preview) return input.t("editable.preview");
  if (input.recovery) return input.t("editable.fallbackUi");
  if (input.loadedWip) return truncate(input.loadedWip.slug, 22);
  return formatMainPill(input.status, input.main, input.t);
}

function resolveBadgeText(
  workingCount: number,
  unreadReplyCount: number,
  readyBackgroundCount: number,
): string | null {
  if (workingCount > 0) return `${workingCount} working`;
  if (unreadReplyCount > 0) {
    return unreadReplyCount === 1 ? "1 reply" : `${unreadReplyCount} replies`;
  }
  if (readyBackgroundCount > 0) return `${readyBackgroundCount} ready`;
  return null;
}

function resolveUpdateDigest(status: EditableDesktopStatus | null): string | null {
  if (!status || status.safeRenderer) return null;
  const candidate = status.availableDigest ?? status.activeDigest ?? null;
  return candidate !== status.releaseDigest ? candidate : null;
}

function deriveSummaryState({
  main,
  wips,
  status,
  workshop,
  workshopDaemon,
  failed,
  t,
}: {
  main: MergedBranchRow;
  wips: MergedBranchRow[];
  status: EditableDesktopStatus | null;
  workshop: EditableStatusWorkshopInfo;
  workshopDaemon: EditableWorkshopDaemonStatus | null;
  failed: string | null;
  t: (key: string) => string;
}) {
  const loadedWip = wips.find((w) => w.loaded) ?? null;
  const loadedRow = loadedWip ?? main;
  const loadedHasUpdate = main.hasUpdate || wips.some((w) => w.loaded && w.hasUpdate);
  const reloadRestartsDaemon = loadedRow.requiresDaemonRestartOnLoad;
  const workingCount = wips.filter((w) => w.status === "working" || w.status === "shipping").length;
  const unreadReplyCount = wips.filter((w) => w.hasUnreadReply).length;
  const readyBackgroundCount = wips.filter((w) => !w.loaded && w.status === "ready").length;
  const preview = !!status?.previewUrl;
  const recovery = !!status?.safeRenderer;
  const workshopState = describeWorkshopState({
    managed: !!workshop.managedWorkshop,
    daemon: workshopDaemon,
    isConnected: !!workshop.isConnected,
    starting: !!workshop.startingWorkshop,
    hostLabel: workshop.host?.label ?? null,
    t,
  });
  const { dotTone, dotPulse } = resolvePillDot({
    hasError: Boolean(failed || workshop.workshopError || workshopDaemon?.status === "errored"),
    recovery,
    loadedHasUpdate,
    working: workingCount > 0 || workshop.editing,
    unreadReply: unreadReplyCount > 0,
    preview,
    workshopReady: workshopState.ready,
  });
  const pillLabel = resolvePillLabel({ failed, preview, recovery, loadedWip, status, main, t });
  const badgeText = resolveBadgeText(workingCount, unreadReplyCount, readyBackgroundCount);

  return {
    loadedHasUpdate,
    reloadRestartsDaemon,
    preview,
    recovery,
    workshopState,
    dotTone,
    dotPulse,
    pillLabel,
    badgeText,
  };
}

interface StatusChatReferenceProps {
  referencedElements?: ReadonlyArray<EditableReferencedElement>;
  onRemoveReference?: (id: string) => void;
  onClearReferences?: () => void;
  onStartPickReference?: () => void;
  pickingReference?: boolean;
  loadedWipSlug?: string | null;
  onSendReferencedToTarget?: (input: {
    targetSlug: string | null;
    text: string;
    references: ReadonlyArray<EditableReferencedElement>;
  }) => Promise<boolean>;
}

function StatusPopoverPanel({
  open,
  activeChatSlug,
  bridge,
  branches,
  main,
  wips,
  workshop,
  workshopDaemon,
  summary,
  actions,
  chatReferences,
  onOpenInlineChat,
  onBackToBranches,
  onClosePopover,
  onTurnFinished,
}: {
  open: boolean;
  activeChatSlug: string | null;
  bridge: EditableDesktopBridge | undefined;
  branches: EditableBranchesSnapshot | null;
  main: MergedBranchRow;
  wips: MergedBranchRow[];
  workshop: EditableStatusWorkshopInfo;
  workshopDaemon: EditableWorkshopDaemonStatus | null;
  summary: ReturnType<typeof deriveSummaryState>;
  actions: ReturnType<typeof useBranchActions>;
  chatReferences: StatusChatReferenceProps;
  onOpenInlineChat: (slug: string) => void;
  onBackToBranches: () => void;
  onClosePopover: () => void;
  onTurnFinished: () => void;
}) {
  if (!open) return null;
  const activeChatRow = activeChatSlug
    ? (wips.find((w) => w.slug === activeChatSlug) ?? null)
    : null;
  if (activeChatRow?.agentId) {
    const activeChatBranch = branches?.branches.find((b) => b.slug === activeChatRow.slug) ?? null;
    return (
      <div role="dialog" aria-label={activeChatRow.slug} style={chatPopoverWrapStyle}>
        <EditableChatView
          serverId={workshop.hostId}
          agentId={activeChatRow.agentId}
          slug={activeChatRow.slug}
          title={activeChatRow.slug}
          branch={activeChatBranch}
          referencedElements={chatReferences.referencedElements}
          onRemoveReference={chatReferences.onRemoveReference}
          onClearReferences={chatReferences.onClearReferences}
          onStartPickReference={chatReferences.onStartPickReference}
          pickingReference={chatReferences.pickingReference}
          loadedWipSlug={chatReferences.loadedWipSlug}
          onSendReferencedToTarget={chatReferences.onSendReferencedToTarget}
          busy={actions.busy}
          onBack={onBackToBranches}
          onClose={onClosePopover}
          onPopOut={workshop.hostId ? actions.openFullChat : undefined}
          onLoadBranch={bridge?.loadBranch ? actions.loadBranch : undefined}
          onShipBranch={bridge?.shipBranch ? actions.shipBranch : undefined}
          onTurnFinished={onTurnFinished}
        />
      </div>
    );
  }
  return (
    <StatusPopover
      bridge={bridge}
      branches={branches}
      main={main}
      wips={wips}
      workshop={workshop}
      workshopDaemon={workshopDaemon}
      workshopState={summary.workshopState}
      dotTone={summary.dotTone}
      dotPulse={summary.dotPulse}
      preview={summary.preview}
      recovery={summary.recovery}
      busy={actions.busy}
      syncMessage={actions.syncMessage}
      errorText={actions.failed ?? workshop.workshopError ?? null}
      onPick={actions.pickFromPopover}
      onLoadBranch={actions.loadBranch}
      onReloadLoaded={actions.reloadLoaded}
      onShipBranch={actions.shipBranch}
      onDiscardBranch={actions.discardBranch}
      onOpenChat={onOpenInlineChat}
      onStartWorkshop={actions.startWorkshop}
      onSync={actions.sync}
      onExitPreview={actions.exitPreview}
      onRecover={actions.recover}
    />
  );
}

export function EditableStatusPill({
  bridge,
  status,
  workshopDaemon,
  branches = null,
  workshop,
  onPick,
  onRefresh,
  layer,
  popoverOpen: controlledOpen,
  onPopoverOpenChange,
  activeChatSlug: controlledActiveChatSlug,
  onActiveChatSlugChange,
  suppressDismiss = false,
  referencedElements,
  onRemoveReference,
  onClearReferences,
  onStartPickReference,
  pickingReference = false,
  loadedWipSlug = null,
  onSendReferencedToTarget,
}: {
  bridge: EditableDesktopBridge | undefined;
  status: EditableDesktopStatus | null;
  workshopDaemon: EditableWorkshopDaemonStatus | null;
  branches?: EditableBranchesSnapshot | null;
  workshop: EditableStatusWorkshopInfo;
  onPick: () => void;
  onRefresh?: () => Promise<void>;
  layer: number;
  popoverOpen?: boolean;
  onPopoverOpenChange?: (open: boolean) => void;
  activeChatSlug?: string | null;
  onActiveChatSlugChange?: (slug: string | null) => void;
  suppressDismiss?: boolean;
} & StatusChatReferenceProps) {
  const { t } = useTranslation();
  const [localOpen, setLocalOpen] = useState(false);
  const [localActiveChatSlug, setLocalActiveChatSlug] = useState<string | null>(null);
  const open = controlledOpen ?? localOpen;
  const activeChatSlug =
    controlledActiveChatSlug !== undefined ? controlledActiveChatSlug : localActiveChatSlug;
  const setOpen = useStableEvent((next: boolean) => {
    if (controlledOpen === undefined) setLocalOpen(next);
    onPopoverOpenChange?.(next);
  });
  const setActiveChatSlug = useStableEvent((next: string | null) => {
    if (controlledActiveChatSlug === undefined) setLocalActiveChatSlug(next);
    onActiveChatSlugChange?.(next);
  });

  const rootRef = useRef<HTMLDivElement | null>(null);
  const closePopover = useStableEvent(() => setOpen(false));
  useDismissPopover(open, rootRef, closePopover, {
    suppressDismiss,
    keepOpenOnAltClick: Boolean(activeChatSlug),
  });

  const loadedChannel = branches?.loadedChannel ?? status?.activeChannel ?? "prod";
  const actions = useBranchActions({
    bridge,
    status,
    loadedChannel,
    updateDigest: resolveUpdateDigest(status),
    workshop,
    onPick,
    onRefresh,
    closePopover,
  });

  const { main, wips } = useMemo(
    () => buildBranchRows(status, branches, workshop, actions.shippingSlugs),
    [status, branches, workshop, actions.shippingSlugs],
  );
  const summary = deriveSummaryState({
    main,
    wips,
    status,
    workshop,
    workshopDaemon,
    failed: actions.failed,
    t,
  });
  const toggleOpen = useStableEvent(() => {
    const next = !open;
    if (next) void onRefresh?.();
    setOpen(next);
  });
  const openInlineChat = useStableEvent((slug: string) => {
    workshop.markReplyRead?.(slug);
    setActiveChatSlug(slug);
  });
  const backToBranches = useStableEvent(() => setActiveChatSlug(null));
  const handleTurnFinished = useStableEvent(() => {
    void bridge?.syncNow?.().finally(() => void onRefresh?.());
  });
  const containerStyle = useMemo(
    () =>
      ({
        position: "fixed",
        right: 12,
        bottom: 12,
        zIndex: layer,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        gap: 8,
        pointerEvents: "none",
      }) as const,
    [layer],
  );
  const reloadLabel = bridge?.loadBranch ? t("editable.reloadRelease") : t("editable.applyRelease");

  const chatReferences = useMemo(
    () => ({
      referencedElements,
      onRemoveReference,
      onClearReferences,
      onStartPickReference,
      pickingReference,
      loadedWipSlug,
      onSendReferencedToTarget,
    }),
    [
      referencedElements,
      onRemoveReference,
      onClearReferences,
      onStartPickReference,
      pickingReference,
      loadedWipSlug,
      onSendReferencedToTarget,
    ],
  );

  return (
    <div ref={rootRef} data-ed-overlay="true" style={containerStyle}>
      <style>{PULSE_CSS}</style>
      <StatusPopoverPanel
        open={open}
        activeChatSlug={activeChatSlug}
        bridge={bridge}
        branches={branches}
        main={main}
        wips={wips}
        workshop={workshop}
        workshopDaemon={workshopDaemon}
        summary={summary}
        actions={actions}
        chatReferences={chatReferences}
        onOpenInlineChat={openInlineChat}
        onBackToBranches={backToBranches}
        onClosePopover={closePopover}
        onTurnFinished={handleTurnFinished}
      />
      <StatusTriggerBar
        open={open}
        dotTone={summary.dotTone}
        dotPulse={summary.dotPulse}
        pillLabel={summary.pillLabel}
        badgeText={summary.badgeText}
        showExitPreview={!!bridge && summary.preview}
        showReload={!!bridge && summary.loadedHasUpdate && !summary.preview}
        reloadLabel={reloadLabel}
        reloadRestartsDaemon={summary.reloadRestartsDaemon}
        daemonListen={branches?.daemonListen ?? null}
        busy={actions.busy}
        onToggle={toggleOpen}
        onExitPreview={actions.exitPreview}
        onReload={actions.reloadLoaded}
      />
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatMainPill(
  status: EditableDesktopStatus | null,
  main: MergedBranchRow,
  t: (key: string) => string,
): string {
  if (!status) return t("editable.webVersion");
  if (main.generation && status.releaseDigest) return `main · v${main.generation}`;
  if (status.releaseDigest) return "main";
  return t("editable.builtInVersion");
}

function describeWorkshopState({
  managed,
  daemon,
  isConnected,
  starting,
  hostLabel,
  t,
}: {
  managed: boolean;
  daemon: EditableWorkshopDaemonStatus | null;
  isConnected: boolean;
  starting: boolean;
  hostLabel: string | null;
  t: (key: string) => string;
}): { label: string; tone: StatusTone; ready: boolean } {
  if (managed) {
    if (starting || daemon?.status === "starting") {
      return { label: t("editable.workshopStarting"), tone: "blue", ready: false };
    }
    if (daemon?.status === "running") {
      const port = daemon.listen.split(":").at(-1);
      return isConnected
        ? { label: `Workshop :${port ?? "6769"}`, tone: "green", ready: true }
        : { label: t("editable.workshopConnecting"), tone: "amber", ready: false };
    }
    if (daemon?.status === "errored") {
      return { label: t("editable.workshopErrored"), tone: "red", ready: false };
    }
    return { label: t("editable.workshopStopped"), tone: "gray", ready: false };
  }
  if (hostLabel) {
    return isConnected
      ? { label: `${hostLabel} · Connected`, tone: "green", ready: true }
      : { label: `${hostLabel} · Offline`, tone: "amber", ready: false };
  }
  return { label: t("editable.workshopNotConfigured"), tone: "gray", ready: false };
}

const barStyle = {
  ...pillStyle,
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "4px 6px",
  borderRadius: 999,
  pointerEvents: "auto",
} as const;

const popoverStyle = {
  width: 348,
  maxWidth: "calc(100vw - 24px)",
  background: "#161a22",
  color: "#f8fafc",
  border: "1px solid rgba(255, 255, 255, 0.16)",
  borderRadius: 10,
  padding: 12,
  boxShadow: "0 14px 36px rgba(0, 0, 0, 0.6)",
  font: "400 12px/18px system-ui, -apple-system, sans-serif",
  display: "flex",
  flexDirection: "column",
  gap: 10,
  pointerEvents: "auto",
} as const;

const triggerButtonStyle = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  background: "transparent",
  border: "none",
  color: "inherit",
  padding: "2px 4px",
  cursor: "pointer",
  font: "inherit",
} as const;

const pillBadgeStyle = {
  fontSize: 10,
  padding: "0px 5px",
  borderRadius: 999,
  background: "rgba(65, 145, 251, 0.22)",
  color: "#93c5fd",
} as const;

const titleTextStyle = { fontSize: 13, fontWeight: 600 } as const;
const branchNameStyle = { fontWeight: 600, fontSize: 12 } as const;
const errorTextStyle = { color: "#f87171", fontSize: 11 } as const;

const rowBetweenStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
} as const;

const titleRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
} as const;

const inlineActionsStyle = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexShrink: 0,
} as const;

const sectionStyle = {
  borderTop: "1px solid rgba(255, 255, 255, 0.08)",
  paddingTop: 8,
  display: "flex",
  flexDirection: "column",
  gap: 6,
} as const;

const footerStyle = {
  borderTop: "1px solid rgba(255, 255, 255, 0.08)",
  paddingTop: 8,
} as const;

const sectionLabelStyle = {
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "#94a3b8",
} as const;

const branchListStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
  maxHeight: 280,
  overflowY: "auto",
} as const;

const branchRowStyle = {
  padding: "8px 9px",
  borderRadius: 8,
  background: "#1d222d",
  border: "1px solid rgba(255, 255, 255, 0.08)",
  display: "flex",
  flexDirection: "column",
  gap: 4,
} as const;

const branchRowActiveStyle = {
  ...branchRowStyle,
  background: "#1c2838",
  border: "1px solid rgba(65, 145, 251, 0.55)",
} as const;

const summaryStyle = {
  color: "#cbd5e1",
  fontSize: 11,
  lineHeight: "15px",
} as const;

const replyPreviewStyle = {
  color: "#e2e8f0",
  fontSize: 11,
  lineHeight: "15px",
  borderLeft: "2px solid rgba(65, 145, 251, 0.55)",
  paddingLeft: 6,
} as const;

const mutedStyle = {
  color: "#94a3b8",
  fontSize: 11,
} as const;

const mutedBadgeStyle = {
  fontSize: 10,
  padding: "1px 5px",
  borderRadius: 4,
  background: "rgba(148, 163, 184, 0.14)",
  color: "#94a3b8",
  cursor: "help",
} as const;

const loadedBadgeStyle = {
  fontSize: 10,
  fontWeight: 600,
  padding: "1px 6px",
  borderRadius: 4,
  background: "rgba(34, 197, 94, 0.18)",
  color: "#4ade80",
  cursor: "help",
} as const;

const readyBadgeStyle = {
  fontSize: 10,
  fontWeight: 500,
  padding: "1px 6px",
  borderRadius: 4,
  background: "rgba(34, 197, 94, 0.12)",
  color: "#86efac",
  cursor: "help",
} as const;

const workingBadgeStyle = {
  fontSize: 10,
  fontWeight: 500,
  padding: "1px 6px",
  borderRadius: 4,
  background: "rgba(65, 145, 251, 0.18)",
  color: "#93c5fd",
  cursor: "help",
} as const;

const failedBadgeStyle = {
  fontSize: 10,
  fontWeight: 600,
  padding: "1px 6px",
  borderRadius: 4,
  background: "rgba(239, 68, 68, 0.18)",
  color: "#fca5a5",
  cursor: "help",
} as const;

const warnTagStyle = {
  fontSize: 10,
  padding: "1px 5px",
  borderRadius: 4,
  background: "rgba(245, 158, 11, 0.18)",
  color: "#fcd34d",
  cursor: "help",
} as const;

const uiServiceBadgeStyle = {
  fontSize: 10,
  padding: "1px 5px",
  borderRadius: 4,
  background: "rgba(56, 189, 248, 0.16)",
  color: "#7dd3fc",
  cursor: "help",
} as const;

const previewBannerStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  padding: "6px 8px",
  borderRadius: 6,
  background: "rgba(245, 158, 11, 0.14)",
  border: "1px solid rgba(245, 158, 11, 0.35)",
  color: "#fcd34d",
  fontSize: 11,
} as const;

const actionsRowStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  marginTop: 2,
} as const;

const chatPopoverWrapStyle = {
  pointerEvents: "auto",
  width: 420,
  maxWidth: "calc(100vw - 24px)",
} as const;
