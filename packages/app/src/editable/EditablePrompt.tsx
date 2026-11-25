import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { EditingTextInput } from "@/components/ui/text-input";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { useEditablePrompt } from "./use-editable-prompt";

function workshopStatusKey(prompt: ReturnType<typeof useEditablePrompt>): string {
  if (prompt.startingWorkshop) return "editable.workshopStarting";
  if (prompt.workshopDaemon?.status === "running") {
    return prompt.isConnected ? "editable.workshopConnected" : "editable.workshopConnecting";
  }
  return "editable.workshopAutoStart";
}

function PromptTargetSection({
  prompt,
  showHostPicker,
}: {
  prompt: ReturnType<typeof useEditablePrompt>;
  showHostPicker: () => void;
}) {
  const { t } = useTranslation();
  if (prompt.managedWorkshop) {
    return (
      <View style={styles.workshopRow}>
        <Text style={styles.label}>{t(workshopStatusKey(prompt))}</Text>
      </View>
    );
  }
  if (prompt.choosingHost) {
    return (
      <View style={styles.hosts}>
        <Text style={styles.label}>
          {t(prompt.hosts.length ? "editable.selectHost" : "editable.noHosts")}
        </Text>
        {prompt.hosts.map((host) => (
          <WorkshopHostButton
            key={host.serverId}
            serverId={host.serverId}
            label={host.label}
            select={prompt.chooseHost}
            disabled={prompt.saving}
          />
        ))}
      </View>
    );
  }
  return (
    <View style={styles.row}>
      <Button size="sm" variant="ghost" onPress={showHostPicker} numberOfLines={1}>
        {prompt.host?.label}
      </Button>
      <EditingTextInput
        accessibilityLabel={t("editable.repoPath")}
        placeholder={prompt.defaultCwd}
        style={styles.path}
        initialValue={prompt.cwd}
        onChangeText={prompt.setCwd}
        autoCapitalize="none"
        autoCorrect={false}
      />
    </View>
  );
}

function BranchTargetToggle({ prompt }: { prompt: ReturnType<typeof useEditablePrompt> }) {
  const { t } = useTranslation();
  const selectCurrent = useStableEvent(() => prompt.setTargetNewBranch(false));
  const selectNew = useStableEvent(() => prompt.setTargetNewBranch(true));
  if (!prompt.loadedWipSlug) return null;
  return (
    <View style={styles.targetRow}>
      <Text style={styles.label}>{t("editable.targetOn")}</Text>
      <Button
        size="sm"
        variant={prompt.targetNewBranch ? "ghost" : "default"}
        onPress={selectCurrent}
        numberOfLines={1}
      >
        {prompt.loadedWipSlug}
      </Button>
      <Button size="sm" variant={prompt.targetNewBranch ? "default" : "ghost"} onPress={selectNew}>
        {t("editable.newBranch")}
      </Button>
    </View>
  );
}

export function EditablePrompt({
  prompt,
  onSubmit,
  onClose,
  inSheet = false,
}: {
  prompt: ReturnType<typeof useEditablePrompt>;
  onSubmit: () => void;
  onClose: () => void;
  inSheet?: boolean;
}) {
  const { t } = useTranslation();
  const showHostPicker = useStableEvent(() => prompt.setChoosingHost(true));
  return (
    <View style={styles.body}>
      <EditingTextInput
        accessibilityLabel={t("editable.placeholder")}
        placeholder={t("editable.placeholder")}
        style={styles.input}
        initialValue={prompt.draft}
        onChangeText={prompt.setDraft}
        onSubmitEditing={onSubmit}
        returnKeyType="send"
        autoFocus={!inSheet}
      />
      <BranchTargetToggle prompt={prompt} />
      <PromptTargetSection prompt={prompt} showHostPicker={showHostPicker} />
      {prompt.error ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {prompt.error}
        </Text>
      ) : null}
      <View style={styles.actions}>
        <Button size="sm" variant="ghost" onPress={onClose}>
          {t("editable.cancel")}
        </Button>
        <Button size="sm" variant="default" onPress={onSubmit} disabled={!prompt.canSend}>
          {t("editable.send")}
        </Button>
      </View>
    </View>
  );
}

function WorkshopHostButton({
  serverId,
  label,
  select,
  disabled,
}: {
  serverId: string;
  label: string;
  select: (serverId: string) => Promise<void>;
  disabled: boolean;
}) {
  const onPress = useStableEvent(() => {
    void select(serverId);
  });
  return (
    <Button size="sm" onPress={onPress} disabled={disabled} numberOfLines={1}>
      {label}
    </Button>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: {
    padding: 8,
    gap: 6,
    backgroundColor: theme.colors.surface0,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: 8,
  },
  input: {
    color: theme.colors.foreground,
    borderRadius: 5,
    backgroundColor: theme.colors.surface1,
    paddingHorizontal: 8,
    paddingVertical: 6,
    minHeight: 32,
    fontSize: 14,
  },
  path: {
    flex: 1,
    minWidth: 0,
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface1,
    borderRadius: 5,
    paddingHorizontal: 6,
    fontSize: 12,
  },
  hosts: { flexDirection: "row", flexWrap: "wrap", gap: 4, alignItems: "center" },
  targetRow: { flexDirection: "row", flexWrap: "wrap", gap: 4, alignItems: "center" },
  workshopRow: { flexDirection: "row", alignItems: "center", paddingHorizontal: 2 },
  row: { flexDirection: "row", gap: 4 },
  label: { color: theme.colors.foregroundMuted, fontSize: 12 },
  actions: { justifyContent: "flex-end", flexDirection: "row", gap: 4 },
  error: { color: theme.colors.destructive, fontSize: 12 },
}));
