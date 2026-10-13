import { DiffViewer } from "./diff-viewer";
import { parseUnifiedDiff } from "@/utils/tool-call-parsers";
import React, { useState, useCallback, useMemo } from "react";
import { Text, View, ScrollView } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { ChevronDown, ChevronRight } from "lucide-react-native";
import type {
  ProviderActivity,
  ProviderActivityRecord,
} from "@getpaseo/protocol/provider-activity";
import { Button } from "./ui/button";

export function CapturedDetails({ payload, value }: { payload?: string; value?: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();
  const toggle = useCallback(() => setExpanded((previous) => !previous), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  const renderedPayload = useMemo(
    () => (expanded ? (payload ?? JSON.stringify(value, null, 2)) : ""),
    [expanded, payload, value],
  );
  return (
    <View style={styles.section}>
      <Button
        style={styles.toggle}
        variant="ghost"
        size="sm"
        onPress={toggle}
        accessibilityState={accessibilityState}
        leftIcon={expanded ? ChevronDown : ChevronRight}
      >
        {t("toolCallDetails.fullDetails")}
      </Button>
      {expanded && (
        <ScrollView style={styles.payload}>
          <Text selectable style={styles.code}>
            {renderedPayload}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

export function ActivityRecord({ entry }: { entry: ProviderActivityRecord }) {
  const { t } = useTranslation();
  const diffLines = useMemo(() => (entry.diff ? parseUnifiedDiff(entry.diff) : []), [entry.diff]);
  return (
    <View style={styles.record}>
      <Text selectable style={entry.level === "info" ? styles.summary : styles.warning}>
        {entry.summary}
      </Text>
      <Text selectable style={styles.caption}>
        {entry.timestamp} · {entry.event}
      </Text>
      {entry.callId && (
        <Text selectable style={styles.caption}>
          {t("toolCallDetails.toolCallId", { id: entry.callId })}
        </Text>
      )}
      {entry.truncated && <Text style={styles.warning}>{t("toolCallDetails.truncated")}</Text>}
      {entry.diff !== undefined && (
        <View>
          <Text style={styles.caption}>{t("toolCallDetails.diffScope")}</Text>
          <DiffViewer diffLines={diffLines} maxHeight={300} />
        </View>
      )}
      <CapturedDetails payload={entry.payload} />
    </View>
  );
}

export function ProviderActivityView({
  activity,
  message,
  level,
}: {
  activity: ProviderActivity;
  message: string;
  level: "info" | "warning" | "error";
}) {
  const [expanded, setExpanded] = useState(false);
  const { t } = useTranslation();
  const toggle = useCallback(() => setExpanded((previous) => !previous), []);
  const accessibilityState = useMemo(() => ({ expanded }), [expanded]);
  return (
    <View style={styles.section} testID="provider-activity">
      <Button
        style={styles.toggle}
        variant="ghost"
        size="sm"
        onPress={toggle}
        accessibilityState={accessibilityState}
        leftIcon={expanded ? ChevronDown : ChevronRight}
      >
        {activity.provider === "Paseo"
          ? t("toolCallDetails.turnChanges")
          : t("toolCallDetails.activity", {
              provider: activity.provider,
              count: activity.records.length,
            })}
      </Button>
      {level !== "info" && (
        <Text selectable style={styles.warning}>
          {message}
        </Text>
      )}
      {expanded && (
        <View style={styles.section}>
          <Text style={styles.caption}>{t("toolCallDetails.captureScope")}</Text>
          {activity.omitted > 0 && (
            <Text style={styles.warning}>
              {t("toolCallDetails.omitted", { count: activity.omitted })}
            </Text>
          )}
          {activity.records.map((entry) => (
            <ActivityRecord key={entry.id} entry={entry} />
          ))}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  toggle: { alignSelf: "flex-start", paddingHorizontal: 0 },
  section: { gap: theme.spacing[2], alignItems: "stretch" },
  record: {
    gap: theme.spacing[1],
    padding: theme.spacing[2],
    borderLeftWidth: theme.borderWidth[1],
    borderLeftColor: theme.colors.border,
  },
  summary: { color: theme.colors.foreground, fontSize: theme.fontSize.sm },
  warning: { color: theme.colors.statusWarning, fontSize: theme.fontSize.sm },
  caption: { color: theme.colors.foregroundMuted, fontSize: theme.fontSize.sm },
  payload: { maxHeight: 300 },
  code: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
}));
