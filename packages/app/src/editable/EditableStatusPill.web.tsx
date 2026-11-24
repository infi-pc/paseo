import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useStableEvent } from "@/hooks/use-stable-event";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import type {
  EditableDesktopBridge,
  EditableDesktopStatus,
  EditableWorkshopDaemonStatus,
} from "./types";

export const pillStyle = {
  borderRadius: 6,
  padding: "4px 8px",
  background: "rgba(24, 28, 36, 0.94)",
  color: "#f8fafc",
  border: "1px solid rgba(255, 255, 255, 0.14)",
  boxShadow: "0 4px 14px rgba(0, 0, 0, 0.32)",
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
  agentStatus?: string | null;
  lastRequest?: string | null;
  workshopError?: string | null;
  startWorkshop?: () => Promise<unknown>;
}

type StatusTone = "green" | "blue" | "amber" | "red" | "gray";

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

function StatusDot({ tone }: { tone: StatusTone }) {
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

function VersionSection({
  bridge,
  status,
  versionText,
  update,
  preview,
  recovery,
  busy,
  syncMessage,
  onSyncCloud,
  onApply,
  onExitPreview,
  onRecover,
}: {
  bridge: EditableDesktopBridge | undefined;
  status: EditableDesktopStatus | null;
  versionText: string;
  update: string | null;
  preview: boolean;
  recovery: boolean;
  busy: boolean;
  syncMessage: string | null;
  onSyncCloud: () => void;
  onApply: () => void;
  onExitPreview: () => void;
  onRecover: () => void;
}) {
  const { t } = useTranslation();
  const shortDigest = status?.releaseDigest ? status.releaseDigest.slice(0, 8) : null;
  return (
    <div style={sectionStyle}>
      <div style={sectionLabelStyle}>{t("editable.versionLabel")}</div>
      <div style={rowBetweenStyle}>
        <span style={versionValueStyle}>
          {versionText}
          {shortDigest ? ` · ${shortDigest}` : ""}
        </span>
        {status?.runtimeVersion ? <span style={mutedStyle}>{status.runtimeVersion}</span> : null}
      </div>
      {status?.releaseSummary ? (
        <div style={mutedStyle}>{truncate(status.releaseSummary, 90)}</div>
      ) : null}
      <div style={actionsRowStyle}>
        {bridge?.syncFromCloudShelf ? (
          <Button size="sm" variant="ghost" disabled={busy} onPress={onSyncCloud}>
            {busy ? t("editable.syncing") : t("editable.syncCloud")}
          </Button>
        ) : null}
        {bridge && update && !preview ? (
          <Button size="sm" disabled={busy} onPress={onApply}>
            {t("editable.applyRelease")}
          </Button>
        ) : null}
        {bridge && preview ? (
          <Button size="sm" disabled={busy} onPress={onExitPreview}>
            {t("editable.exitPreview")}
          </Button>
        ) : null}
        {bridge && !recovery ? (
          <Button size="sm" variant="ghost" disabled={busy} onPress={onRecover}>
            {t("editable.recovery")}
          </Button>
        ) : null}
      </div>
      {syncMessage ? <div style={mutedStyle}>{syncMessage}</div> : null}
    </div>
  );
}

function InProgressSection({
  workshop,
  worktrees,
  onOpenChat,
}: {
  workshop: EditableStatusWorkshopInfo;
  worktrees: string[];
  onOpenChat: () => void;
}) {
  const { t } = useTranslation();
  const inProgressText = formatInProgressText({
    startingWorkshop: !!workshop.startingWorkshop,
    editing: workshop.editing,
    lastRequest: workshop.lastRequest ?? null,
    t,
  });
  return (
    <div style={sectionStyle}>
      <div style={sectionLabelStyle}>{t("editable.inProgressLabel")}</div>
      <div>{inProgressText}</div>
      {worktrees.length > 0 ? (
        <div style={chipRowStyle}>
          {worktrees.map((slug) => (
            <span key={slug} style={chipStyle}>
              ed/wip/{slug}
            </span>
          ))}
        </div>
      ) : null}
      {workshop.hostId && workshop.agentId ? (
        <div style={actionsRowStyle}>
          <Button size="sm" variant="ghost" onPress={onOpenChat}>
            {t("editable.openWorkshopChat")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function WorkshopSection({
  workshop,
  workshopDaemon,
  workshopState,
  busy,
  onStartWorkshop,
}: {
  workshop: EditableStatusWorkshopInfo;
  workshopDaemon: EditableWorkshopDaemonStatus | null;
  workshopState: { label: string; tone: StatusTone; ready: boolean };
  busy: boolean;
  onStartWorkshop: () => void;
}) {
  const { t } = useTranslation();
  const showStart = workshop.managedWorkshop && workshopDaemon?.status !== "running";
  return (
    <div style={sectionStyle}>
      <div style={sectionLabelStyle}>{t("editable.workshopLabel")}</div>
      <div style={rowBetweenStyle}>
        <div style={titleRowStyle}>
          <StatusDot tone={workshopState.tone} />
          <span>{workshopState.label}</span>
        </div>
        {workshopDaemon?.listen ? <span style={mutedStyle}>{workshopDaemon.listen}</span> : null}
      </div>
      {showStart ? (
        <div style={actionsRowStyle}>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || !!workshop.startingWorkshop}
            onPress={onStartWorkshop}
          >
            {workshop.startingWorkshop
              ? t("editable.workshopStarting")
              : t("editable.startWorkshop")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

function StatusTriggerBar({
  open,
  dotTone,
  pillLabel,
  showExitPreview,
  showApply,
  busy,
  onToggle,
  onExitPreview,
  onApply,
}: {
  open: boolean;
  dotTone: StatusTone;
  pillLabel: string;
  showExitPreview: boolean;
  showApply: boolean;
  busy: boolean;
  onToggle: () => void;
  onExitPreview: () => void;
  onApply: () => void;
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
        <StatusDot tone={dotTone} />
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
      </button>
      {showExitPreview ? (
        <Button size="sm" disabled={busy} onPress={onExitPreview}>
          {t("editable.exitPreview")}
        </Button>
      ) : null}
      {showApply ? (
        <Button size="sm" disabled={busy} onPress={onApply}>
          {t("editable.applyRelease")}
        </Button>
      ) : null}
    </div>
  );
}

function StatusPopover({
  bridge,
  status,
  workshopDaemon,
  workshop,
  versionText,
  dotTone,
  workshopState,
  update,
  preview,
  recovery,
  busy,
  syncMessage,
  errorText,
  onPick,
  onSyncCloud,
  onApply,
  onExitPreview,
  onRecover,
  onOpenChat,
  onStartWorkshop,
}: {
  bridge: EditableDesktopBridge | undefined;
  status: EditableDesktopStatus | null;
  workshopDaemon: EditableWorkshopDaemonStatus | null;
  workshop: EditableStatusWorkshopInfo;
  versionText: string;
  dotTone: StatusTone;
  workshopState: { label: string; tone: StatusTone; ready: boolean };
  update: string | null;
  preview: boolean;
  recovery: boolean;
  busy: boolean;
  syncMessage: string | null;
  errorText: string | null;
  onPick: () => void;
  onSyncCloud: () => void;
  onApply: () => void;
  onExitPreview: () => void;
  onRecover: () => void;
  onOpenChat: () => void;
  onStartWorkshop: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div role="dialog" aria-label={t("editable.statusTitle")} style={popoverStyle}>
      <div style={rowBetweenStyle}>
        <div style={titleRowStyle}>
          <StatusDot tone={dotTone} />
          <strong style={titleTextStyle}>{t("editable.statusTitle")}</strong>
        </div>
        <Button size="sm" variant="ghost" onPress={onPick}>
          {t("editable.pickButton")}
        </Button>
      </div>
      <VersionSection
        bridge={bridge}
        status={status}
        versionText={versionText}
        update={update}
        preview={preview}
        recovery={recovery}
        busy={busy}
        syncMessage={syncMessage}
        onSyncCloud={onSyncCloud}
        onApply={onApply}
        onExitPreview={onExitPreview}
        onRecover={onRecover}
      />
      <InProgressSection
        workshop={workshop}
        worktrees={workshopDaemon?.worktrees ?? []}
        onOpenChat={onOpenChat}
      />
      <WorkshopSection
        workshop={workshop}
        workshopDaemon={workshopDaemon}
        workshopState={workshopState}
        busy={busy}
        onStartWorkshop={onStartWorkshop}
      />
      {errorText ? (
        <div role="alert" style={errorTextStyle}>
          {errorText}
        </div>
      ) : null}
    </div>
  );
}

function useEditableStatusActions({
  bridge,
  update,
  workshop,
  onPick,
  onRefresh,
  closePopover,
}: {
  bridge: EditableDesktopBridge | undefined;
  update: string | null;
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

  return {
    failed,
    syncMessage,
    busy,
    exitPreview: useStableEvent(() => {
      if (bridge) void run(() => bridge.setPreviewUrl(null));
    }),
    recover: useStableEvent(() => {
      if (bridge) void run(() => bridge.useRecoveryRenderer());
    }),
    apply: useStableEvent(() => {
      if (bridge && update) {
        void run(async () => {
          const result = await bridge.switchRelease(update);
          if (!result.ok) throw new Error(result.error);
        });
      }
    }),
    syncCloud: useStableEvent(() => {
      if (!bridge?.syncFromCloudShelf) return;
      void run(async () => {
        const result = await bridge.syncFromCloudShelf!();
        if (!result.ok) throw new Error(result.error ?? t("editable.desktopFailed"));
        await onRefresh?.();
        if (!result.updated) setSyncMessage(t("editable.upToDate"));
      });
    }),
    startWorkshop: useStableEvent(() => {
      if (!workshop.startWorkshop) return;
      void run(async () => {
        await workshop.startWorkshop!();
      });
    }),
    openChat: useStableEvent(() => {
      if (!workshop.hostId || !workshop.agentId) return;
      closePopover();
      router.push(buildHostAgentDetailRoute(workshop.hostId, workshop.agentId) as never);
    }),
    pickFromPopover: useStableEvent(() => {
      closePopover();
      onPick();
    }),
  };
}

function derivePillPresentation({
  status,
  workshopDaemon,
  workshop,
  failed,
  t,
}: {
  status: EditableDesktopStatus | null;
  workshopDaemon: EditableWorkshopDaemonStatus | null;
  workshop: EditableStatusWorkshopInfo;
  failed: string | null;
  t: (key: string) => string;
}) {
  const candidate = status?.availableDigest ?? status?.activeDigest ?? null;
  const update = !status?.safeRenderer && candidate !== status?.releaseDigest ? candidate : null;
  const preview = !!status?.previewUrl;
  const recovery = !!status?.safeRenderer;
  const versionText = formatVersionLabel(status, t);
  const workshopState = describeWorkshopState({
    managed: !!workshop.managedWorkshop,
    daemon: workshopDaemon,
    isConnected: !!workshop.isConnected,
    starting: !!workshop.startingWorkshop,
    hostLabel: workshop.host?.label ?? null,
    t,
  });
  const dotTone = pickDotTone({
    failed: !!failed || !!workshop.workshopError || workshopDaemon?.status === "errored",
    recovery,
    preview,
    update: !!update,
    editing: workshop.editing,
    workshopReady: workshopState.ready,
  });
  const pillLabel = compactPillLabel({
    failed: !!failed,
    preview,
    update: !!update,
    recovery,
    startingWorkshop: !!workshop.startingWorkshop,
    editing: workshop.editing,
    versionText,
    t,
  });
  return { update, preview, recovery, versionText, workshopState, dotTone, pillLabel };
}

export function EditableStatusPill({
  bridge,
  status,
  workshopDaemon,
  workshop,
  onPick,
  onRefresh,
  layer,
}: {
  bridge: EditableDesktopBridge | undefined;
  status: EditableDesktopStatus | null;
  workshopDaemon: EditableWorkshopDaemonStatus | null;
  workshop: EditableStatusWorkshopInfo;
  onPick: () => void;
  onRefresh?: () => Promise<void>;
  layer: number;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const closePopover = useStableEvent(() => setOpen(false));
  useDismissPopover(open, rootRef, closePopover);

  const candidate = status?.availableDigest ?? status?.activeDigest ?? null;
  const updateCandidate =
    !status?.safeRenderer && candidate !== status?.releaseDigest ? candidate : null;
  const actions = useEditableStatusActions({
    bridge,
    update: updateCandidate,
    workshop,
    onPick,
    onRefresh,
    closePopover,
  });

  const toggleOpen = useStableEvent(() => {
    setOpen((wasOpen) => {
      if (!wasOpen) void onRefresh?.();
      return !wasOpen;
    });
  });

  const { update, preview, recovery, versionText, workshopState, dotTone, pillLabel } =
    derivePillPresentation({ status, workshopDaemon, workshop, failed: actions.failed, t });
  const containerStyle = useMemo(
    () =>
      ({
        position: "fixed",
        left: 12,
        bottom: 12,
        zIndex: layer,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 8,
        pointerEvents: "none",
      }) as const,
    [layer],
  );

  return (
    <div ref={rootRef} data-ed-overlay="true" style={containerStyle}>
      {open ? (
        <StatusPopover
          bridge={bridge}
          status={status}
          workshopDaemon={workshopDaemon}
          workshop={workshop}
          versionText={versionText}
          dotTone={dotTone}
          workshopState={workshopState}
          update={update}
          preview={preview}
          recovery={recovery}
          busy={actions.busy}
          syncMessage={actions.syncMessage}
          errorText={actions.failed ?? workshop.workshopError ?? null}
          onPick={actions.pickFromPopover}
          onSyncCloud={actions.syncCloud}
          onApply={actions.apply}
          onExitPreview={actions.exitPreview}
          onRecover={actions.recover}
          onOpenChat={actions.openChat}
          onStartWorkshop={actions.startWorkshop}
        />
      ) : null}
      <StatusTriggerBar
        open={open}
        dotTone={dotTone}
        pillLabel={pillLabel}
        showExitPreview={!!bridge && preview}
        showApply={!!bridge && !!update && !preview}
        busy={actions.busy}
        onToggle={toggleOpen}
        onExitPreview={actions.exitPreview}
        onApply={actions.apply}
      />
    </div>
  );
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function formatInProgressText({
  startingWorkshop,
  editing,
  lastRequest,
  t,
}: {
  startingWorkshop: boolean;
  editing: boolean;
  lastRequest: string | null;
  t: (key: string) => string;
}): string {
  if (startingWorkshop) return t("editable.workshopStarting");
  if (editing) {
    return lastRequest
      ? `${t("editable.editing")} "${truncate(lastRequest, 60)}"`
      : t("editable.editing");
  }
  if (lastRequest) return `${t("editable.lastEdit")}: "${truncate(lastRequest, 60)}"`;
  return t("editable.nothingInProgress");
}

function formatVersionLabel(
  status: EditableDesktopStatus | null,
  t: (key: string) => string,
): string {
  if (!status) return t("editable.webVersion");
  if (status.safeRenderer) return t("editable.recovery");
  if (status.previewUrl) return t("editable.preview");
  if (status.releaseDigest && status.activeGeneration > 0) {
    return `Gen ${status.activeGeneration}`;
  }
  if (status.releaseDigest) return t("editable.signedVersion");
  return t("editable.builtInVersion");
}

function compactPillLabel({
  failed,
  preview,
  update,
  recovery,
  startingWorkshop,
  editing,
  versionText,
  t,
}: {
  failed: boolean;
  preview: boolean;
  update: boolean;
  recovery: boolean;
  startingWorkshop: boolean;
  editing: boolean;
  versionText: string;
  t: (key: string) => string;
}): string {
  if (failed) return t("editable.desktopFailed");
  if (preview) return t("editable.preview");
  if (update) return t("editable.updateReady");
  if (recovery) return t("editable.recovery");
  if (startingWorkshop) return t("editable.workshopStarting");
  if (editing) return t("editable.editing");
  return versionText;
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
      return isConnected
        ? { label: t("editable.workshopConnected"), tone: "green", ready: true }
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

function pickDotTone({
  failed,
  recovery,
  preview,
  update,
  editing,
  workshopReady,
}: {
  failed: boolean;
  recovery: boolean;
  preview: boolean;
  update: boolean;
  editing: boolean;
  workshopReady: boolean;
}): StatusTone {
  if (failed || recovery) return "red";
  if (editing) return "blue";
  if (update || preview) return "amber";
  return workshopReady ? "green" : "gray";
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
  width: 310,
  maxWidth: "calc(100vw - 24px)",
  background: "rgba(22, 26, 34, 0.97)",
  color: "#f8fafc",
  border: "1px solid rgba(255, 255, 255, 0.14)",
  borderRadius: 10,
  padding: 12,
  boxShadow: "0 12px 32px rgba(0, 0, 0, 0.45)",
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

const titleTextStyle = { fontSize: 13, fontWeight: 600 } as const;
const versionValueStyle = { fontWeight: 600 } as const;
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
} as const;

const sectionStyle = {
  borderTop: "1px solid rgba(255, 255, 255, 0.08)",
  paddingTop: 8,
  display: "flex",
  flexDirection: "column",
  gap: 4,
} as const;

const sectionLabelStyle = {
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "#94a3b8",
} as const;

const mutedStyle = {
  color: "#94a3b8",
  fontSize: 11,
} as const;

const actionsRowStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  marginTop: 4,
} as const;

const chipRowStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
  marginTop: 2,
} as const;

const chipStyle = {
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 4,
  background: "rgba(65, 145, 251, 0.16)",
  color: "#93c5fd",
} as const;
