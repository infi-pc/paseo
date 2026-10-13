import { useCallback, useMemo, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import { AttachmentLabel, AttachmentPill } from "@/components/attachment-pill";
import { getAgentAttachmentPillContent } from "@/attachments/attachment-pill-content";
import { AdaptiveModalSheet, type SheetHeader } from "@/components/adaptive-modal-sheet";
import type { TranscriptAttachment } from "./attachment";

export function TranscriptAttachmentPill({
  attachment,
  disabled,
  onRemove,
  index,
}: {
  attachment: TranscriptAttachment;
  disabled: boolean;
  index: number;
  onRemove: (index: number) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const show = useCallback(() => setOpen(true), []);
  const close = useCallback(() => setOpen(false), []);
  const remove = useCallback(() => onRemove(index), [onRemove, index]);
  const content = getAgentAttachmentPillContent(attachment.attachment, t);
  const header = useMemo<SheetHeader>(
    () => ({ title: attachment.attachment.title }),
    [attachment.attachment.title],
  );
  return (
    <>
      <AttachmentPill
        testID="composer-transcript-attachment-pill"
        disabled={disabled}
        onOpen={show}
        onRemove={remove}
        openAccessibilityLabel={t("transcript.open")}
        removeAccessibilityLabel={t("transcript.remove")}
      >
        <AttachmentLabel {...content} />
      </AttachmentPill>
      {open ? (
        <AdaptiveModalSheet visible onClose={close} header={header} testID="transcript-preview">
          <View style={styles.body}>
            <Text selectable style={styles.text}>
              {attachment.attachment.text}
            </Text>
          </View>
        </AdaptiveModalSheet>
      ) : null}
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  body: { padding: theme.spacing[4] },
  text: { color: theme.colors.foreground, fontSize: theme.fontSize.content },
}));
