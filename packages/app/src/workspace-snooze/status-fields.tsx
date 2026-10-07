import { useCallback } from "react";
import { View, Text } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/form-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import {
  statusWatchKey,
  type StatusWatchSnapshot,
} from "@getpaseo/protocol/workspace-status-snooze";
import type { openSnoozeForm, SnoozeFormState } from "./form-model";

export function StatusSnoozeFields({
  model,
  state,
  size,
}: {
  model: ReturnType<typeof openSnoozeForm>;
  state: SnoozeFormState;
  size: "sm" | "md";
}) {
  const { t } = useTranslation();
  const reload = useCallback(() => void model.loadStatus(), [model]);
  const interval = useCallback(
    (value: string) => model.setStatusInterval(value === "5" ? 5 : 60),
    [model],
  );
  return (
    <View style={styles.body}>
      <Text style={styles.text}>{t("workspaceSnooze.statusRule")}</Text>
      {state.statusLoad === "loading" ? (
        <Text style={styles.text}>{t("workspaceSnooze.loadingStatuses")}</Text>
      ) : null}
      {state.statusLoad === "ready" && !state.candidates.length ? (
        <Text style={styles.text}>{t("workspaceSnooze.noStatuses")}</Text>
      ) : null}
      {state.candidates.map((snapshot) => (
        <StatusRow
          key={statusWatchKey(snapshot.target)}
          snapshot={snapshot}
          selected={state.selected.includes(statusWatchKey(snapshot.target))}
          toggle={model.toggleTarget}
        />
      ))}
      {[...new Set(state.discoveryErrors)].map((error) => (
        <Text key={error} style={styles.error}>
          {error}
        </Text>
      ))}
      <Button variant="secondary" onPress={reload} disabled={state.statusLoad === "loading"}>
        {t("workspaceSnooze.refreshStatuses")}
      </Button>
      <Field label={t("workspaceSnooze.interval")}>
        <SegmentedControl
          size={size}
          value={String(state.intervalMinutes)}
          onValueChange={interval}
          options={[
            { value: "5", label: t("workspaceSnooze.fiveMinutes") },
            { value: "60", label: t("workspaceSnooze.hourly") },
          ]}
        />
      </Field>
      {state.autoArchiveAfterMerge ? (
        <Text style={styles.text}>{t("workspaceSnooze.archivePrecedence")}</Text>
      ) : null}
    </View>
  );
}
function StatusRow({
  snapshot,
  selected,
  toggle,
}: {
  snapshot: StatusWatchSnapshot;
  selected: boolean;
  toggle: (key: string) => void;
}) {
  const key = statusWatchKey(snapshot.target);
  const change = useCallback(() => toggle(key), [key, toggle]);
  return (
    <View style={styles.row}>
      <View style={styles.label}>
        <Text style={styles.text}>{snapshot.label}</Text>
        <Text style={styles.text}>{snapshot.valueLabel}</Text>
      </View>
      <Switch
        value={selected}
        onValueChange={change}
        accessibilityLabel={snapshot.label}
        testID={`snooze-watch-${key}`}
      />
    </View>
  );
}
const styles = StyleSheet.create((theme) => ({
  body: { gap: theme.spacing[3] },
  row: { flexDirection: "row", alignItems: "center", gap: theme.spacing[3] },
  label: { flex: 1 },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  error: { color: theme.colors.destructive, fontSize: theme.fontSize.sm },
}));
