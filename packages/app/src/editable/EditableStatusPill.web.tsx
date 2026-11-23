import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { EditableDesktopBridge, EditableDesktopStatus } from "./types";

export const pillStyle = {
  borderRadius: 5,
  padding: "3px 6px",
  background: "#202733",
  color: "#fff",
  font: "500 11px/16px system-ui, sans-serif",
  whiteSpace: "nowrap",
} as const;

export function EditableStatusPill({
  bridge,
  status,
  editing,
  layer,
}: {
  bridge: EditableDesktopBridge | undefined;
  status: EditableDesktopStatus | null;
  editing: boolean;
  layer: number;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const candidate = status?.availableDigest ?? status?.activeDigest;
  const update = !status?.safeRenderer && candidate !== status?.releaseDigest ? candidate : null;
  const preview = !!status?.previewUrl;
  const showRecovery = bridge && (preview || update || failed);
  const style = useMemo(
    () =>
      ({
        ...pillStyle,
        position: "fixed",
        right: 12,
        bottom: 12,
        zIndex: layer,
        display: "flex",
        alignItems: "center",
        gap: 6,
        pointerEvents: "auto",
      }) as const,
    [layer],
  );

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setFailed(false);
    try {
      await action();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  const exitPreview = useStableEvent(() => {
    if (bridge) void run(() => bridge.setPreviewUrl(null));
  });
  const recover = useStableEvent(() => {
    if (bridge) void run(() => bridge.useRecoveryRenderer());
  });
  const apply = useStableEvent(() => {
    if (bridge && update)
      void run(async () => {
        const result = await bridge.switchRelease(update);
        if (!result.ok) throw new Error(result.error);
      });
  });

  const label = statusLabel({
    failed,
    preview,
    update: !!update,
    recovery: !!status?.safeRenderer,
    editing,
  });
  if (!label) return null;

  return (
    <div data-ed-overlay="true" style={style}>
      <span role="status">{t(label)}</span>
      {bridge && preview && (
        <Button size="sm" disabled={busy} onPress={exitPreview}>
          {t("editable.exitPreview")}
        </Button>
      )}
      {bridge && update && !preview && (
        <Button size="sm" disabled={busy} onPress={apply}>
          {t("editable.applyRelease")}
        </Button>
      )}
      {showRecovery ? (
        <Button size="sm" disabled={busy} onPress={recover}>
          {t("editable.recovery")}
        </Button>
      ) : null}
    </div>
  );
}

function statusLabel({
  failed,
  preview,
  update,
  recovery,
  editing,
}: {
  failed: boolean;
  preview: boolean;
  update: boolean;
  recovery: boolean;
  editing: boolean;
}) {
  if (failed) return "editable.desktopFailed";
  if (preview) return "editable.preview";
  if (update) return "editable.updateReady";
  if (recovery) return "editable.recovery";
  if (editing) return "editable.editing";
  return null;
}
