// FORK(transcript-clipboard): copy context from the existing fork affordance.
import { useTranscriptCopy, type TranscriptCopySource } from "@/transcript/use-copy";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { Copy, Split } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ICON_SIZE, type Theme } from "@/styles/theme";

export type AssistantForkTarget = "tab" | "workspace";

interface AssistantForkMenuProps {
  onFork: (target: AssistantForkTarget) => Promise<void> | void;
  testID?: string;
  transcriptSource?: TranscriptCopySource;
}

const ThemedSplit = withUnistyles(Split);
const ThemedCopy = withUnistyles(Copy);

const foregroundColorMapping = (theme: Theme) => ({ color: theme.colors.foreground });
const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

export const AssistantForkMenu = memo(function AssistantForkMenu({
  onFork,
  transcriptSource,
  testID = "assistant-fork-menu",
}: AssistantForkMenuProps) {
  const { t } = useTranslation();
  const { copyTranscript } = useTranscriptCopy(
    transcriptSource?.serverId ?? "",
    Boolean(transcriptSource),
  );
  const [isOpen, setIsOpen] = useState(false);
  const [pendingTarget, setPendingTarget] = useState<AssistantForkTarget | "copy" | null>(null);
  const isLocked = pendingTarget !== null;

  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (!next && pendingTarget !== null) return;
      setIsOpen(next);
    },
    [pendingTarget],
  );

  const handleSelect = useCallback(
    (target: AssistantForkTarget) => async () => {
      if (isLocked) return;
      setPendingTarget(target);
      try {
        await onFork(target);
      } finally {
        setPendingTarget(null);
        setIsOpen(false);
      }
    },
    [isLocked, onFork],
  );

  const copyIcon = useMemo(
    () => <ThemedCopy size={ICON_SIZE.sm} uniProps={foregroundColorMapping} />,
    [],
  );

  const handleCopy = useCallback(async () => {
    if (isLocked || !transcriptSource) return;
    setPendingTarget("copy");
    try {
      await copyTranscript(transcriptSource.agentId, transcriptSource.boundary);
    } finally {
      setPendingTarget(null);
      setIsOpen(false);
    }
  }, [copyTranscript, isLocked, transcriptSource]);

  const triggerStyle = useCallback(
    () => [styles.trigger, isLocked ? styles.triggerDisabled : null],
    [isLocked],
  );

  const tooltipContent = useMemo(
    () => (
      <TooltipContent side="top" align="center" offset={8}>
        <Text style={styles.tooltipText}>{t("message.actions.forkMenu")}</Text>
      </TooltipContent>
    ),
    [t],
  );

  const forkIcon = useMemo(
    () => <ThemedSplit size={ICON_SIZE.sm} uniProps={foregroundColorMapping} />,
    [],
  );

  return (
    <DropdownMenu open={isOpen} onOpenChange={handleOpenChange}>
      <Tooltip delayDuration={250} enabledOnDesktop enabledOnMobile={false}>
        <TooltipTrigger asChild>
          <View style={styles.triggerSlot} collapsable={false}>
            <DropdownMenuTrigger
              accessibilityLabel={t("message.actions.forkMenu")}
              accessibilityRole="button"
              disabled={isLocked}
              style={triggerStyle}
              testID={`${testID}-trigger`}
            >
              {({ hovered, open }) => (
                <ThemedSplit
                  size={ICON_SIZE.sm}
                  uniProps={hovered || open ? foregroundColorMapping : foregroundMutedColorMapping}
                />
              )}
            </DropdownMenuTrigger>
          </View>
        </TooltipTrigger>
        {tooltipContent}
      </Tooltip>
      <DropdownMenuContent align="start" minWidth={220} side="bottom" testID={`${testID}-content`}>
        <DropdownMenuItem
          closeOnSelect={false}
          disabled={isLocked && pendingTarget !== "tab"}
          leading={forkIcon}
          onSelect={handleSelect("tab")}
          status={pendingTarget === "tab" ? "pending" : undefined}
          testID={`${testID}-new-tab`}
        >
          {t("message.actions.forkInNewTab")}
        </DropdownMenuItem>
        <DropdownMenuItem
          closeOnSelect={false}
          disabled={isLocked && pendingTarget !== "workspace"}
          leading={forkIcon}
          onSelect={handleSelect("workspace")}
          status={pendingTarget === "workspace" ? "pending" : undefined}
          testID={`${testID}-new-workspace`}
        >
          {t("message.actions.forkInNewWorkspace")}
        </DropdownMenuItem>
        {transcriptSource ? (
          <DropdownMenuItem
            closeOnSelect={false}
            disabled={isLocked && pendingTarget !== "copy"}
            leading={copyIcon}
            onSelect={handleCopy}
            status={pendingTarget === "copy" ? "pending" : undefined}
            testID={`${testID}-copy-transcript`}
          >
            {t(transcriptSource.boundary ? "transcript.copyUpToHere" : "transcript.copyFull")}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
});

const styles = StyleSheet.create((theme) => ({
  trigger: {
    padding: theme.spacing[1],
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
  },
  triggerDisabled: {
    opacity: theme.opacity[50],
  },
  triggerSlot: {
    alignSelf: "center",
  },
  tooltipText: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
}));
