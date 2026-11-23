import { useCallback, useEffect, useState } from "react";
import { usePathname } from "expo-router";
import { BottomSheetScrollView } from "@gorhom/bottom-sheet";
import { Platform } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import {
  IsolatedBottomSheetModal,
  useIsolatedBottomSheetVisibility,
} from "@/components/ui/isolated-bottom-sheet-modal";
import { isNative } from "@/constants/platform";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useEditableNativeTrigger } from "./EditableNativeTrigger";
import { EditablePrompt } from "./EditablePrompt";
import { routeLocatorContext } from "./types";
import { useEditablePrompt } from "./use-editable-prompt";

export function EditableOverlay() {
  const route = usePathname();
  const prompt = useEditablePrompt();
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const sheet = useIsolatedBottomSheetVisibility({ visible: open, onClose: close });
  const openPrompt = useStableEvent(() => {
    prompt.reset();
    setOpen(true);
  });
  const submit = useStableEvent(() => {
    const context = routeLocatorContext({
      route,
      platform: Platform.OS === "ios" ? "ios" : "android",
      releaseDigest: process.env.EXPO_PUBLIC_EDITABLE_RELEASE_DIGEST ?? null,
    });
    void prompt.submit(context, close, () => setOpen(true));
  });
  const enabled = isNative && prompt.config?.enabled === true;
  useEffect(() => {
    useEditableNativeTrigger.setState({
      openPrompt: enabled ? openPrompt : null,
      editing: prompt.editing,
    });
    return () => useEditableNativeTrigger.setState({ openPrompt: null, editing: false });
  }, [enabled, openPrompt, prompt.editing]);

  if (!enabled) return null;
  return (
    <IsolatedBottomSheetModal
      ref={sheet.sheetRef}
      contextBridge={null}
      snapPoints={["50%"]}
      enableDynamicSizing={false}
      onChange={sheet.handleSheetChange}
      onDismiss={sheet.handleSheetDismiss}
      backdropOpacity={0.45}
      enablePanDownToClose
    >
      <BottomSheetScrollView style={styles.sheet} keyboardShouldPersistTaps="handled">
        <EditablePrompt prompt={prompt} inSheet onClose={close} onSubmit={submit} />
      </BottomSheetScrollView>
    </IsolatedBottomSheetModal>
  );
}

const styles = StyleSheet.create((theme) => ({
  sheet: { paddingHorizontal: 12, backgroundColor: theme.colors.surface0 },
}));
