import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useStableEvent } from "@/hooks/use-stable-event";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { EditableChatView } from "./EditableChatView.web";
import type {
  EditableBranchAgentRecord,
  EditableBranchEntry,
  EditableBranchesSnapshot,
  EditableDesktopBridge,
  EditableDesktopStatus,
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
) {
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        rootRef.current &&
        event.target instanceof Node &&
        !rootRef.current.contains(event.target)
      ) {
        onClose();
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
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
  }, [open, rootRef, onClose]);
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
  hasChanges: boolean;
  behindMain: boolean;
  canFastForward: boolean;
  requiresDaemon: boolean;
  hasUpdate: boolean;
  loaded: boolean;
  agentId: string | null;
  error: string | null;
}

function buildMainRow(
  status: EditableDesktopStatus | null,
  branches: EditableBranchesSnapshot | null,
  loadedChannel: string,
  safe: boolean,
  statusUpdate: string | null,
): MergedBranchRow {
  const b = branches?.main;
  return {
    slug: "main",
    channel: "prod",
    isMain: true,
    status: "ready",
    summary: b?.summary ?? status?.releaseSummary ?? null,
    replyPreview: null,
    hasUnreadReply: false,
    generation: b?.generation ?? (status?.activeGeneration || null),
    releaseDigest: b?.releaseDigest ?? status?.releaseDigest ?? null,
    hasChanges: false,
    behindMain: false,
    canFastForward: false,
    requiresDaemon: false,
    hasUpdate: Boolean(b?.hasUpdate) || (loadedChannel === "prod" && !!statusUpdate),
    loaded: b ? b.loaded : !safe && loadedChannel === "prod",
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
    hasChanges: false,
    behindMain: false,
    canFastForward: false,
    requiresDaemon: false,
    hasUpdate: false,
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
  const hasChanges = b.hasChanges ?? Boolean(b.releaseDigest);
  const mergedStatus = resolveMergedWipStatus(b, {
    isShipping: ctx.shippingSlugs.has(b.slug),
    isAgentRunning,
    hasChanges,
  });

  return {
    slug: b.slug,
    channel: b.channel,
    isMain: false,
    status: mergedStatus,
    summary: b.summary ?? ctx.pending?.request ?? ctx.clientAgent?.request ?? null,
    replyPreview: ctx.replyPreview,
    hasUnreadReply: ctx.hasUnreadReply,
    generation: b.generation,
    releaseDigest: hasChanges ? b.releaseDigest : null,
    hasChanges,
    behindMain: b.behindMain,
    canFastForward: hasChanges && b.canFastForward,
    requiresDaemon: b.requiresDaemon,
    hasUpdate: hasChanges && (b.hasUpdate || (b.loaded && Boolean(ctx.statusUpdate))),
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

function MainBranchRow({
  row,
  busy,
  hasLoadBranch,
  onLoad,
  onReload,
}: {
  row: MergedBranchRow;
  busy: boolean;
  hasLoadBranch: boolean;
  onLoad: (channel: string) => void;
  onReload: () => void;
}) {
  const { t } = useTranslation();
  const { tone, pulse } = rowTone(row);
  const handleLoad = useStableEvent(() => onLoad("prod"));

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
            <Button size="sm" disabled={busy} onPress={onReload}>
              {hasLoadBranch ? t("editable.reloadRelease") : t("editable.applyRelease")}
            </Button>
          ) : null}
          {row.loaded && !row.hasUpdate ? (
            <span style={loadedBadgeStyle}>{t("editable.loadedBadge")}</span>
          ) : null}
          {!row.loaded && hasLoadBranch ? (
            <Button size="sm" variant="ghost" disabled={busy} onPress={handleLoad}>
              {t("editable.loadBranch")}
            </Button>
          ) : null}
        </div>
      </div>
      {row.summary ? <div style={summaryStyle}>{truncate(row.summary, 84)}</div> : null}
    </div>
  );
}

function WipBranchStatusBadge({ row }: { row: MergedBranchRow }) {
  const { t } = useTranslation();
  if (row.loaded) return <span style={loadedBadgeStyle}>{t("editable.loadedBadge")}</span>;
  if (row.status === "shipping") {
    return (
      <span style={workingBadgeStyle}>
        {row.behindMain ? t("editable.updatingBranch") : t("editable.shippingBranch")}
      </span>
    );
  }
  if (row.status === "working") {
    return <span style={workingBadgeStyle}>{t("editable.workingBadge")}</span>;
  }
  if (row.status === "failed") {
    return <span style={failedBadgeStyle}>{t("editable.failedBadge")}</span>;
  }
  if (row.status === "ready") {
    return <span style={readyBadgeStyle}>{t("editable.readyBadge")}</span>;
  }
  if (row.status === "draft") {
    return <span style={warnTagStyle}>{t("editable.draftBadge")}</span>;
  }
  if (row.hasUnreadReply) {
    return <span style={workingBadgeStyle}>{t("editable.repliedBadge")}</span>;
  }
  return <span style={mutedBadgeStyle}>{t("editable.noChangesBadge")}</span>;
}

function WipBranchActions({
  row,
  isBusyRow,
  canOpenChat,
  canManage,
  onLoad,
  onShip,
  onDiscard,
  onChat,
}: {
  row: MergedBranchRow;
  isBusyRow: boolean;
  canOpenChat: boolean;
  canManage: boolean;
  onLoad: () => void;
  onShip: () => void;
  onDiscard: () => void;
  onChat: () => void;
}) {
  const { t } = useTranslation();
  const canLoad =
    canManage && row.hasChanges && Boolean(row.releaseDigest) && (!row.loaded || row.hasUpdate);
  const canShip = canManage && row.hasChanges && row.status === "ready";
  const shipLabel = row.canFastForward ? t("editable.shipBranch") : t("editable.updateToMain");

  return (
    <div style={actionsRowStyle}>
      {canLoad ? (
        <Button
          size="sm"
          variant={row.hasUpdate ? "default" : "ghost"}
          disabled={isBusyRow}
          onPress={onLoad}
        >
          {row.hasUpdate ? t("editable.reloadRelease") : t("editable.loadBranch")}
        </Button>
      ) : null}
      {canShip ? (
        <Button size="sm" variant="ghost" disabled={isBusyRow} onPress={onShip}>
          {shipLabel}
        </Button>
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
  busy,
  canOpenChat,
  canManage,
  onLoad,
  onShip,
  onDiscard,
  onOpenChat,
}: {
  row: MergedBranchRow;
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
          {row.requiresDaemon ? <span style={warnTagStyle}>{t("editable.daemonTag")}</span> : null}
          {row.hasChanges && row.behindMain ? (
            <span style={mutedBadgeStyle}>{t("editable.behindMain")}</span>
          ) : null}
          <WipBranchStatusBadge row={row} />
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
            <Button size="sm" variant="ghost" disabled={busy} onPress={onRecover}>
              {t("editable.fallbackUi")}
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function StatusPopover({
  bridge,
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
            busy={busy}
            hasLoadBranch={canManage}
            onLoad={onLoadBranch}
            onReload={onReloadLoaded}
          />
          {wips.map((row) => (
            <WipBranchRow
              key={row.slug}
              row={row}
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
        <Button size="sm" disabled={busy} onPress={onReload}>
          {reloadLabel}
        </Button>
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
  const loadedHasUpdate = main.hasUpdate || wips.some((w) => w.loaded && w.hasUpdate);
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
    preview,
    recovery,
    workshopState,
    dotTone,
    dotPulse,
    pillLabel,
    badgeText,
  };
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
}: {
  bridge: EditableDesktopBridge | undefined;
  status: EditableDesktopStatus | null;
  workshopDaemon: EditableWorkshopDaemonStatus | null;
  branches?: EditableBranchesSnapshot | null;
  workshop: EditableStatusWorkshopInfo;
  onPick: () => void;
  onRefresh?: () => Promise<void>;
  layer: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [activeChatSlug, setActiveChatSlug] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const closePopover = useStableEvent(() => setOpen(false));
  useDismissPopover(open, rootRef, closePopover);

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
    setOpen((wasOpen) => {
      if (!wasOpen) void onRefresh?.();
      return !wasOpen;
    });
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
} as const;

const loadedBadgeStyle = {
  fontSize: 10,
  fontWeight: 600,
  padding: "1px 6px",
  borderRadius: 4,
  background: "rgba(34, 197, 94, 0.18)",
  color: "#4ade80",
} as const;

const readyBadgeStyle = {
  fontSize: 10,
  fontWeight: 500,
  padding: "1px 6px",
  borderRadius: 4,
  background: "rgba(34, 197, 94, 0.12)",
  color: "#86efac",
} as const;

const workingBadgeStyle = {
  fontSize: 10,
  fontWeight: 500,
  padding: "1px 6px",
  borderRadius: 4,
  background: "rgba(65, 145, 251, 0.18)",
  color: "#93c5fd",
} as const;

const failedBadgeStyle = {
  fontSize: 10,
  fontWeight: 600,
  padding: "1px 6px",
  borderRadius: 4,
  background: "rgba(239, 68, 68, 0.18)",
  color: "#fca5a5",
} as const;

const warnTagStyle = {
  fontSize: 10,
  padding: "1px 5px",
  borderRadius: 4,
  background: "rgba(245, 158, 11, 0.18)",
  color: "#fcd34d",
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
