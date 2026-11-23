import { useTranslation } from "react-i18next";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import { isNative } from "@/constants/platform";
import { useStableEvent } from "@/hooks/use-stable-event";

export const useEditableNativeTrigger = create<{
  openPrompt: (() => void) | null;
  editing: boolean;
}>(() => ({ openPrompt: null, editing: false }));

export function EditableNativeTrigger({ onOpen }: { onOpen?: () => void }) {
  const { t } = useTranslation();
  const openPrompt = useEditableNativeTrigger((state) => state.openPrompt);
  const editing = useEditableNativeTrigger((state) => state.editing);
  const handlePress = useStableEvent(() => {
    onOpen?.();
    openPrompt?.();
  });
  if (!isNative || !openPrompt) return null;
  return (
    <Button size="sm" variant="ghost" onPress={handlePress} disabled={editing}>
      {t(editing ? "editable.editing" : "editable.editScreen")}
    </Button>
  );
}
