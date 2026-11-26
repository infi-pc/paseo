import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname, useRouter } from "expo-router";
import { useTranslation } from "react-i18next";
import { getIsElectron, isWeb } from "@/constants/platform";
import { useKeyboardActionHandler } from "@/hooks/use-keyboard-action-handler";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useOverlayRegistration } from "@/keyboard";
import { getOverlayRoot, useGlobalOverlayLayer } from "@/lib/overlay-root";
import { buildHostAgentDetailRoute } from "@/utils/host-routes";
import { EditableChatView, type EditableChatDraftControls } from "./EditableChatView.web";
import { EditableStatusPill, pillStyle } from "./EditableStatusPill.web";
import {
  captureEditableElementSnapshot,
  installEditableInspector,
  recordEditableRoute,
} from "./inspector";
import { locateEditableTarget } from "./locator";
import type { EditableTarget } from "./locator.ts";
import type {
  EditableElementSnapshot,
  EditableReferencedElement,
  EditableRouteContext,
  EditableScreenshotAttachment,
} from "./types";
import { useEditableDesktop } from "./use-editable-desktop.web";
import { useEditablePrompt } from "./use-editable-prompt";

const FRAME_GAP = 8;
const DRAFT_POPOVER_WIDTH = 360;
const CHAT_POPOVER_WIDTH = 410;

function useOptionHoldPicking(enabled: boolean): [boolean, () => void] {
  const [altPicking, setAltPicking] = useState(false);
  const clear = useCallback(() => setAltPicking(false), []);

  useEffect(() => {
    if (!isWeb || !enabled) {
      setAltPicking(false);
      return;
    }
    const cancelAlt = () => setAltPicking(false);
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Alt") {
        if (!event.ctrlKey && !event.metaKey && !event.shiftKey) setAltPicking(true);
        return;
      }
      // Pressing another key while holding Option (e.g. Option+Arrow or Option+Shift+F8) cancels hold-pick.
      setAltPicking(false);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Alt") setAltPicking(false);
    };
    const onVisibility = () => {
      if (document.hidden) setAltPicking(false);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", cancelAlt);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", cancelAlt);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);

  return [altPicking, clear];
}

function usePointerPositionRef() {
  const pointerPos = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    if (!isWeb) return;
    const onPointerMove = (event: PointerEvent) => {
      pointerPos.current = { x: event.clientX, y: event.clientY };
    };
    window.addEventListener("pointermove", onPointerMove, { capture: true, passive: true });
    return () => {
      window.removeEventListener("pointermove", onPointerMove, true);
    };
  }, []);
  return pointerPos;
}

function useEditableEscape(
  active: boolean,
  layer: number,
  manageFocus: boolean,
  close: () => void,
) {
  return useOverlayRegistration({
    active,
    layer,
    keys: ["Escape"],
    manageFocus,
    onKeyDown(event) {
      if (event.key !== "Escape") return false;
      event.preventDefault();
      close();
      return true;
    },
  });
}

function PickingHint({ visible, layer }: { visible: boolean; layer: number }) {
  const { t } = useTranslation();
  const hintStyle = useMemo(
    () =>
      ({
        ...pillStyle,
        position: "fixed",
        right: 12,
        bottom: 52,
        zIndex: layer,
        pointerEvents: "none",
      }) as const,
    [layer],
  );
  if (!visible) return null;
  return (
    <div role="status" data-ed-overlay="true" style={hintStyle}>
      {t("editable.pickHint")}
    </div>
  );
}

function shouldRenderOverlay({
  active,
  enabled,
  hasBridge,
  editing,
}: {
  active: boolean;
  enabled: boolean;
  hasBridge: boolean;
  editing: boolean;
}): boolean {
  if (!isWeb || typeof document === "undefined") return false;
  return active || enabled || hasBridge || editing;
}

function workshopStatusTextKey(prompt: ReturnType<typeof useEditablePrompt>): string {
  if (prompt.startingWorkshop) return "editable.workshopStarting";
  if (prompt.workshopDaemon?.status === "running") {
    return prompt.isConnected ? "editable.workshopConnected" : "editable.workshopConnecting";
  }
  return "editable.workshopAutoStart";
}

function buildDraftControls(
  prompt: ReturnType<typeof useEditablePrompt>,
  t: (key: string) => string,
  onSubmitDraft: () => void,
  availableTargets: ReadonlyArray<string>,
  lastActiveChatSlug: string | null,
): EditableChatDraftControls {
  return {
    draft: prompt.draft,
    setDraft: prompt.setDraft,
    canSend: prompt.canSend,
    sending: prompt.sending,
    error: prompt.error,
    loadedWipSlug: prompt.loadedWipSlug,
    selectedTargetSlug: prompt.selectedTargetSlug,
    setSelectedTargetSlug: prompt.setSelectedTargetSlug,
    availableTargets,
    lastActiveChatSlug,
    targetNewBranch: prompt.targetNewBranch,
    setTargetNewBranch: prompt.setTargetNewBranch,
    managedWorkshop: prompt.managedWorkshop,
    choosingHost: prompt.choosingHost,
    setChoosingHost: prompt.setChoosingHost,
    hosts: prompt.hosts,
    host: prompt.host,
    chooseHost: prompt.chooseHost,
    saving: prompt.saving,
    cwd: prompt.cwd,
    setCwd: prompt.setCwd,
    defaultCwd: prompt.defaultCwd,
    workshopStatusText: t(workshopStatusTextKey(prompt)),
    onSubmitDraft,
  };
}

function formatTargetLabel(target: EditableTarget, fallback: string): string {
  const { componentName, file, line } = target.context;
  const shortFile = file ? file.split("/").pop() : null;
  const suffix = shortFile ? `${shortFile}${line ? `:${line}` : ""}` : null;
  if (componentName && suffix) return `${componentName} · ${suffix}`;
  return componentName || suffix || fallback;
}

function referenceKey(locator: EditableTarget["context"]): string {
  return `${locator.file}:${locator.line ?? ""}:${locator.column ?? ""}:${locator.componentName ?? ""}`;
}

function appendReferencedElement(
  prev: EditableReferencedElement[],
  nextRef: EditableReferencedElement,
): EditableReferencedElement[] {
  const nextKey = referenceKey(nextRef.locator);
  const filtered = prev.filter((item) => referenceKey(item.locator) !== nextKey);
  return [...filtered, nextRef].slice(-5);
}

interface SendReferencedInput {
  targetSlug: string | null;
  text: string;
  references: ReadonlyArray<EditableReferencedElement>;
}

function buildInlineLiveProps(
  isLive: boolean,
  input: {
    referencedElements: ReadonlyArray<EditableReferencedElement>;
    pickingReference: boolean;
    onRemoveReference: (id: string) => void;
    onClearReferences: () => void;
    onStartPickReference: () => void;
    onSendReferencedToTarget: (payload: SendReferencedInput) => Promise<boolean>;
  },
) {
  if (!isLive) return {};
  return {
    referencedElements: input.referencedElements,
    onRemoveReference: input.onRemoveReference,
    onClearReferences: input.onClearReferences,
    onStartPickReference: input.onStartPickReference,
    pickingReference: input.pickingReference,
    onSendReferencedToTarget: input.onSendReferencedToTarget,
  };
}

function resolveInlineHeaderMeta(
  inlineChat: { slug: string; agentId: string } | null,
  inlineBranch: { title?: string | null; icon?: string | null } | null,
  prompt: ReturnType<typeof useEditablePrompt>,
  selectedLabel: string,
): { title: string; icon: string | null } {
  if (!inlineChat) return { title: selectedLabel, icon: null };
  const slug = inlineChat.slug;
  return {
    title: prompt.agentTitles?.[slug] ?? inlineBranch?.title ?? slug,
    icon: prompt.agentIcons?.[slug] ?? inlineBranch?.icon ?? null,
  };
}

function SelectedElementChat({
  selected,
  inlineChat,
  rect,
  layer,
  setScope,
  prompt,
  bridge,
  branches,
  availableTargets,
  lastActiveChatSlug,
  referencedElements,
  pickingReference,
  suppressDismiss,
  refresh,
  onClose,
  onSubmitDraft,
  onPopOutChat,
  onRemoveReference,
  onClearReferences,
  onStartPickReference,
  onSendReferencedToTarget,
}: {
  selected: EditableTarget;
  inlineChat: { slug: string; agentId: string } | null;
  rect: DOMRect | null;
  layer: number;
  setScope: (node: unknown) => void;
  prompt: ReturnType<typeof useEditablePrompt>;
  bridge: ReturnType<typeof useEditableDesktop>["bridge"];
  branches: ReturnType<typeof useEditableDesktop>["branches"];
  availableTargets: ReadonlyArray<string>;
  lastActiveChatSlug: string | null;
  referencedElements: ReadonlyArray<EditableReferencedElement>;
  pickingReference: boolean;
  suppressDismiss: boolean;
  refresh: () => Promise<void>;
  onClose: () => void;
  onSubmitDraft: () => void;
  onPopOutChat: (agentId: string) => void;
  onRemoveReference: (id: string) => void;
  onClearReferences: () => void;
  onStartPickReference: () => void;
  onSendReferencedToTarget: (input: SendReferencedInput) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const onLoadInlineBranch = useStableEvent((channel: string) => {
    if (!bridge?.loadBranch) return;
    void (async () => {
      await bridge.loadBranch!(channel);
      await refresh();
    })();
  });
  const onShipInlineBranch = useStableEvent((slug: string) => {
    if (!bridge?.shipBranch) return;
    void (async () => {
      const res = await bridge.shipBranch!(slug);
      if (res.ok) prompt.clearBranchAgent?.(slug);
      await refresh();
    })();
  });
  const onInlineTurnFinished = useStableEvent(() => {
    void bridge?.syncNow?.().finally(() => void refresh());
  });

  const inlineBranch = inlineChat
    ? (branches?.branches.find((b) => b.slug === inlineChat.slug) ?? null)
    : null;
  const draftControls = buildDraftControls(
    prompt,
    t,
    onSubmitDraft,
    availableTargets,
    lastActiveChatSlug,
  );
  const selectedLabel = formatTargetLabel(selected, t("editable.component"));
  const liveProps = buildInlineLiveProps(Boolean(inlineChat), {
    referencedElements,
    pickingReference,
    onRemoveReference,
    onClearReferences,
    onStartPickReference,
    onSendReferencedToTarget,
  });

  const { title: inlineTitle, icon: inlineIcon } = resolveInlineHeaderMeta(
    inlineChat,
    inlineBranch,
    prompt,
    selectedLabel,
  );

  return (
    <InlinePopover
      rect={rect}
      layer={layer}
      width={inlineChat ? CHAT_POPOVER_WIDTH : DRAFT_POPOVER_WIDTH}
      setScope={setScope}
      onDismiss={onClose}
      suppressDismiss={suppressDismiss}
      keepOpenOnAltClick={Boolean(inlineChat)}
      label={inlineChat ? inlineTitle : t("editable.placeholder")}
    >
      <EditableChatView
        serverId={prompt.hostId}
        agentId={inlineChat?.agentId ?? null}
        slug={inlineChat?.slug ?? null}
        title={inlineTitle}
        icon={inlineIcon}
        locatorChip={inlineChat ? selectedLabel : null}
        branch={inlineBranch}
        draftControls={draftControls}
        loadedWipSlug={prompt.loadedWipSlug}
        {...liveProps}
        compact
        onClose={onClose}
        onPopOut={prompt.hostId ? onPopOutChat : undefined}
        onLoadBranch={bridge?.loadBranch ? onLoadInlineBranch : undefined}
        onShipBranch={bridge?.shipBranch ? onShipInlineBranch : undefined}
        onTurnFinished={onInlineTurnFinished}
      />
    </InlinePopover>
  );
}

function useEditableInspectorLifecycle(enabled: boolean, route: string) {
  useEffect(() => {
    if (!isWeb || !enabled) return;
    return installEditableInspector();
  }, [enabled]);

  useEffect(() => {
    if (!isWeb || !enabled) return;
    recordEditableRoute(route);
  }, [enabled, route]);
}

function captureElementClickContext(
  target: EditableTarget,
  bridge: ReturnType<typeof useEditableDesktop>["bridge"],
  onReady: (
    snapshot: EditableElementSnapshot | null,
    screenshot: EditableScreenshotAttachment | null,
  ) => void,
) {
  const snapshot = captureEditableElementSnapshot(target.element);
  if (!bridge?.captureScreenshot) {
    onReady(snapshot, null);
    return;
  }
  const bounds = target.element.getBoundingClientRect();
  void (async () => {
    try {
      const shot = await bridge.captureScreenshot!({
        rect: { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height },
        padding: 140,
      });
      const image: EditableScreenshotAttachment | null =
        shot.ok && shot.dataBase64 && shot.mimeType
          ? { data: shot.dataBase64, mimeType: shot.mimeType }
          : null;
      onReady(snapshot, image);
    } catch {
      onReady(snapshot, null);
    }
  })();
}

function useEditablePickState({
  canPick,
  bridge,
  prompt,
  route,
  hasOpenStatusChat,
  componentFallback,
  onChatActivated,
  onAttachReference,
}: {
  canPick: boolean;
  bridge: ReturnType<typeof useEditableDesktop>["bridge"];
  prompt: ReturnType<typeof useEditablePrompt>;
  route: string;
  hasOpenStatusChat: boolean;
  componentFallback: string;
  onChatActivated: (slug: string) => void;
  onAttachReference: (reference: EditableReferencedElement) => void;
}) {
  const [picking, setPicking] = useState(false);
  const [selected, setSelected] = useState<EditableTarget | null>(null);
  const [inlineChat, setInlineChat] = useState<{ slug: string; agentId: string } | null>(null);
  const selectedSnapshotRef = useRef<EditableElementSnapshot | null>(null);
  const selectedScreenshotRef = useRef<EditableScreenshotAttachment | null>(null);
  const [altPicking, clearAltPicking] = useOptionHoldPicking(
    canPick && (!selected || Boolean(inlineChat)),
  );
  const currentRoute = useRef(route);
  currentRoute.current = route;
  const hasOpenLiveChatRef = useRef(false);
  hasOpenLiveChatRef.current = Boolean(inlineChat) || hasOpenStatusChat;

  const clearSelection = useCallback(() => {
    setSelected(null);
    setInlineChat(null);
    selectedSnapshotRef.current = null;
    selectedScreenshotRef.current = null;
  }, []);

  const cancelPicking = useCallback(() => {
    setPicking(false);
    clearAltPicking();
  }, [clearAltPicking]);

  const close = useCallback(() => {
    clearSelection();
    cancelPicking();
  }, [cancelPicking, clearSelection]);
  useEffect(close, [route, close]);

  const handleEscape = useCallback(() => {
    if (picking && hasOpenLiveChatRef.current) {
      cancelPicking();
      return;
    }
    close();
  }, [cancelPicking, close, picking]);

  const startPick = useCallback(() => {
    if (!canPick) return;
    prompt.reset();
    clearSelection();
    clearAltPicking();
    setPicking(true);
  }, [canPick, clearAltPicking, clearSelection, prompt]);

  const startPickReference = useCallback(() => {
    if (!canPick) return;
    clearAltPicking();
    setPicking((prev) => !prev);
  }, [canPick, clearAltPicking]);

  const onPick = useCallback(
    (target: EditableTarget) => {
      setPicking(false);
      clearAltPicking();
      if (hasOpenLiveChatRef.current) {
        captureElementClickContext(target, bridge, (snapshot, screenshot) => {
          onAttachReference({
            id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
            label: formatTargetLabel(target, componentFallback),
            locator: target.context,
            snapshot,
            screenshot,
          });
        });
        return;
      }
      setInlineChat(null);
      captureElementClickContext(target, bridge, (snapshot, screenshot) => {
        selectedSnapshotRef.current = snapshot;
        selectedScreenshotRef.current = screenshot;
        setSelected(target);
      });
    },
    [bridge, clearAltPicking, componentFallback, onAttachReference],
  );

  const onSubmitDraft = useStableEvent(() => {
    if (!selected) return;
    const snapshot = selectedSnapshotRef.current;
    const screenshot = selectedScreenshotRef.current;
    void (async () => {
      const sent = await prompt.submitInPlace(selected.context, {
        snapshot,
        images: screenshot ? [screenshot] : undefined,
      });
      if (sent && currentRoute.current === route) {
        setInlineChat(sent);
        onChatActivated(sent.slug);
      }
    })();
  });

  const isPickingMode = picking || altPicking;
  const active = isPickingMode || !!selected;
  const togglePick = useCallback(() => {
    if (hasOpenLiveChatRef.current) {
      startPickReference();
      return true;
    }
    if (active) close();
    else startPick();
    return true;
  }, [active, close, startPick, startPickReference]);

  return {
    picking,
    altPicking,
    isPickingMode,
    active,
    selected,
    inlineChat,
    setInlineChat,
    close,
    handleEscape,
    startPick,
    startPickReference,
    togglePick,
    onPick,
    onSubmitDraft,
  };
}

function collectAvailableTargets(
  branches: ReturnType<typeof useEditableDesktop>["branches"],
  prompt: ReturnType<typeof useEditablePrompt>,
): string[] {
  const slugs: string[] = [];
  const push = (slug: string | null | undefined) => {
    if (slug && !slugs.includes(slug)) slugs.push(slug);
  };
  for (const b of branches?.branches ?? []) push(b.slug);
  for (const rec of Object.values(prompt.branchAgents ?? {})) {
    const st = prompt.agentStatuses?.[rec.slug];
    if (st !== "closed" && st !== "archived") push(rec.slug);
  }
  for (const pending of Object.values(prompt.pendingBranches ?? {})) push(pending.slug);
  return slugs;
}

function useChatReferencesState() {
  const [statusPopoverOpen, setStatusPopoverOpen] = useState(false);
  const [statusActiveChatSlug, setStatusActiveChatSlug] = useState<string | null>(null);
  const [lastActiveChatSlug, setLastActiveChatSlug] = useState<string | null>(null);
  const [chatReferences, setChatReferences] = useState<EditableReferencedElement[]>([]);

  const attachReference = useCallback((reference: EditableReferencedElement) => {
    setChatReferences((prev) => appendReferencedElement(prev, reference));
  }, []);
  const removeReference = useCallback((id: string) => {
    setChatReferences((prev) => prev.filter((item) => item.id !== id));
  }, []);
  const clearReferences = useCallback(() => setChatReferences([]), []);

  const handleStatusPopoverOpenChange = useStableEvent((nextOpen: boolean) => {
    setStatusPopoverOpen(nextOpen);
    if (!nextOpen) clearReferences();
  });
  const handleStatusActiveChatChange = useStableEvent((nextSlug: string | null) => {
    setStatusActiveChatSlug(nextSlug);
    if (nextSlug) setLastActiveChatSlug(nextSlug);
    clearReferences();
  });

  return {
    statusPopoverOpen,
    statusActiveChatSlug,
    setStatusActiveChatSlug,
    lastActiveChatSlug,
    setLastActiveChatSlug,
    hasOpenStatusChat: statusPopoverOpen && Boolean(statusActiveChatSlug),
    chatReferences,
    attachReference,
    removeReference,
    clearReferences,
    handleStatusPopoverOpenChange,
    handleStatusActiveChatChange,
  };
}

async function submitReferencedToTarget(
  prompt: ReturnType<typeof useEditablePrompt>,
  input: SendReferencedInput,
): Promise<{ agentId: string; slug: string } | null> {
  const [primary, ...rest] = input.references;
  if (!primary) return null;
  const images = input.references
    .map((ref) => ref.screenshot)
    .filter((img): img is NonNullable<typeof img> => Boolean(img));
  return prompt.submitInPlace(primary.locator, {
    targetSlug: input.targetSlug,
    overrideText: input.text,
    snapshot: primary.snapshot,
    extraReferences: rest,
    images: images.length > 0 ? images : undefined,
  });
}

function useOverlayReferenceRouting(
  prompt: ReturnType<typeof useEditablePrompt>,
  chatState: ReturnType<typeof useChatReferencesState>,
  setInlineChat: (chat: { slug: string; agentId: string } | null) => void,
) {
  const sendInline = useStableEvent(async (input: SendReferencedInput) => {
    const sent = await submitReferencedToTarget(prompt, input);
    if (!sent) return false;
    chatState.setLastActiveChatSlug(sent.slug);
    setInlineChat(sent);
    return true;
  });
  const sendStatus = useStableEvent(async (input: SendReferencedInput) => {
    const sent = await submitReferencedToTarget(prompt, input);
    if (!sent) return false;
    chatState.setLastActiveChatSlug(sent.slug);
    chatState.setStatusActiveChatSlug(sent.slug);
    return true;
  });
  return { sendInline, sendStatus };
}

function resolveStatusChatRefProps(
  chatState: ReturnType<typeof useChatReferencesState>,
  pick: ReturnType<typeof useEditablePickState>,
  loadedWipSlug: string | null,
  onSendReferencedToTarget: (input: SendReferencedInput) => Promise<boolean>,
) {
  return {
    popoverOpen: chatState.statusPopoverOpen,
    onPopoverOpenChange: chatState.handleStatusPopoverOpenChange,
    activeChatSlug: chatState.statusActiveChatSlug,
    onActiveChatSlugChange: chatState.handleStatusActiveChatChange,
    suppressDismiss: pick.isPickingMode && chatState.hasOpenStatusChat,
    referencedElements: chatState.hasOpenStatusChat ? chatState.chatReferences : undefined,
    onRemoveReference: chatState.removeReference,
    onClearReferences: chatState.clearReferences,
    onStartPickReference: pick.startPickReference,
    pickingReference: Boolean(chatState.hasOpenStatusChat && pick.picking),
    loadedWipSlug,
    onSendReferencedToTarget,
  };
}

export function EditableOverlay() {
  const { t } = useTranslation();
  const route = usePathname();
  const router = useRouter();
  const { bridge, status, workshopDaemon, branches, refresh } = useEditableDesktop();
  const loadedChannel = branches?.loadedChannel ?? status?.activeChannel ?? "prod";
  const prompt = useEditablePrompt({
    bridge,
    workshopDaemon,
    branches,
    loadedChannel,
    refreshDesktop: refresh,
  });
  const chatState = useChatReferencesState();
  const pointerPos = usePointerPositionRef();
  const enabled = prompt.config?.enabled === true;
  useEditableInspectorLifecycle(enabled || Boolean(bridge), route);
  const canPick = isWeb && enabled && !prompt.sending;

  const pick = useEditablePickState({
    canPick,
    bridge,
    prompt,
    route,
    hasOpenStatusChat: chatState.hasOpenStatusChat,
    componentFallback: t("editable.component"),
    onChatActivated: chatState.setLastActiveChatSlug,
    onAttachReference: chatState.attachReference,
  });
  const layer = useGlobalOverlayLayer("floating", pick.active);
  const routing = useOverlayReferenceRouting(prompt, chatState, pick.setInlineChat);

  const availableTargets = useMemo(
    () => collectAvailableTargets(branches, prompt),
    [branches, prompt],
  );

  useKeyboardActionHandler({
    handlerId: "editable.pick",
    actions: ["editable.pick"],
    enabled: canPick,
    priority: 100,
    handle: pick.togglePick,
  });

  const setScope = useEditableEscape(pick.active, layer, Boolean(pick.selected), pick.handleEscape);
  const hover = useHoveredTarget({
    picking: pick.picking,
    altPicking: pick.altPicking,
    pointerPos,
    route,
    releaseDigest: status?.releaseDigest ?? null,
    onPick: pick.onPick,
  });
  const selectedRect = useTargetRect(pick.selected?.element);
  const highlightTarget = pick.isPickingMode ? hover : pick.selected;
  const highlightRect = useTargetRect(highlightTarget?.element);

  const onCloseSelected = useStableEvent(() => {
    chatState.clearReferences();
    pick.close();
  });
  const onPopOutChat = useStableEvent((agentId: string) => {
    if (!prompt.hostId) return;
    chatState.clearReferences();
    pick.close();
    router.push(buildHostAgentDetailRoute(prompt.hostId, agentId) as never);
  });

  if (
    !shouldRenderOverlay({
      active: pick.active,
      enabled,
      hasBridge: Boolean(bridge),
      editing: prompt.editing,
    })
  ) {
    return null;
  }

  const statusChatProps = resolveStatusChatRefProps(
    chatState,
    pick,
    prompt.loadedWipSlug,
    routing.sendStatus,
  );

  return createPortal(
    <>
      <PickingHint visible={pick.isPickingMode} layer={layer} />
      {highlightTarget && highlightRect ? (
        <PickerHighlight rect={highlightRect} target={highlightTarget} layer={layer} />
      ) : null}
      {pick.selected ? (
        <SelectedElementChat
          selected={pick.selected}
          inlineChat={pick.inlineChat}
          rect={selectedRect}
          layer={layer}
          setScope={setScope}
          prompt={prompt}
          bridge={bridge}
          branches={branches}
          availableTargets={availableTargets}
          lastActiveChatSlug={chatState.lastActiveChatSlug}
          referencedElements={chatState.chatReferences}
          pickingReference={pick.picking}
          suppressDismiss={pick.isPickingMode}
          refresh={refresh}
          onClose={onCloseSelected}
          onSubmitDraft={pick.onSubmitDraft}
          onPopOutChat={onPopOutChat}
          onRemoveReference={chatState.removeReference}
          onClearReferences={chatState.clearReferences}
          onStartPickReference={pick.startPickReference}
          onSendReferencedToTarget={routing.sendInline}
        />
      ) : null}
      <EditableStatusPill
        bridge={bridge}
        status={status}
        workshopDaemon={workshopDaemon}
        branches={branches}
        workshop={prompt}
        onPick={pick.startPick}
        onRefresh={refresh}
        layer={layer}
        {...statusChatProps}
      />
    </>,
    getOverlayRoot(),
  );
}

function useHoveredTarget({
  picking,
  altPicking,
  pointerPos,
  route,
  releaseDigest,
  onPick,
}: {
  picking: boolean;
  altPicking: boolean;
  pointerPos: React.RefObject<{ x: number; y: number } | null>;
  route: string;
  releaseDigest: string | null;
  onPick: (target: EditableTarget) => void;
}) {
  const [hover, setHover] = useState<EditableTarget | null>(null);
  const active = picking || altPicking;

  useEffect(() => {
    if (!isWeb || !active) return;
    const context: EditableRouteContext = {
      route,
      releaseDigest,
      platform: getIsElectron() ? "electron" : "web",
    };

    // Immediately highlight whatever sits under the cursor when Option is pressed.
    const pos = pointerPos.current;
    if (pos && typeof document.elementFromPoint === "function") {
      const under = document.elementFromPoint(pos.x, pos.y);
      if (under && !under.closest('[data-ed-overlay="true"]')) {
        const initial = locateEditableTarget(under, context);
        if (initial) setHover(initial);
      }
    }

    const onMove = (event: PointerEvent) => {
      const candidate = locateEditableTarget(event.target, context);
      setHover((previous) => (previous?.element === candidate?.element ? previous : candidate));
    };
    const clearHover = () => setHover(null);
    const isPageTarget = (event: MouseEvent) =>
      event.target instanceof Element && !event.target.closest('[data-ed-overlay="true"]');
    const matchesClickMode = (event: MouseEvent) => picking || (altPicking && event.altKey);
    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0 || !isPageTarget(event) || !matchesClickMode(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    const onClick = (event: MouseEvent) => {
      if (!isPageTarget(event) || !matchesClickMode(event)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const target = locateEditableTarget(event.target, context);
      if (target) onPick(target);
    };
    window.addEventListener("pointermove", onMove, true);
    window.addEventListener("blur", clearHover);
    document.documentElement.addEventListener("pointerleave", clearHover);
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("click", onClick, true);
    return () => {
      window.removeEventListener("pointermove", onMove, true);
      window.removeEventListener("blur", clearHover);
      document.documentElement.removeEventListener("pointerleave", clearHover);
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("click", onClick, true);
      clearHover();
    };
  }, [active, picking, altPicking, pointerPos, route, releaseDigest, onPick]);

  return active ? hover : null;
}

function PickerHighlight({
  rect,
  target,
  layer,
}: {
  rect: DOMRect;
  target: EditableTarget;
  layer: number;
}) {
  const { t } = useTranslation();
  const frameStyle = useMemo(
    () =>
      ({
        position: "fixed",
        pointerEvents: "none",
        zIndex: layer,
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        border: "1px solid #4191fb",
        background: "rgba(65, 145, 251, 0.16)",
        boxSizing: "border-box",
      }) as const,
    [rect, layer],
  );
  const labelStyle = useMemo(
    () =>
      ({
        ...pillStyle,
        position: "absolute",
        top: rect.top > 22 ? -23 : 0,
        left: 0,
      }) as const,
    [rect.top],
  );
  return (
    <div aria-hidden data-ed-overlay="true" style={frameStyle}>
      <span style={labelStyle}>
        {target.context.componentName ?? t("editable.component")} ·{" "}
        {target.context.file.split("/").at(-1)}:{target.context.line}
      </span>
    </div>
  );
}

function InlinePopover({
  rect,
  layer,
  width: preferredWidth,
  setScope,
  onDismiss,
  suppressDismiss = false,
  keepOpenOnAltClick = false,
  label,
  children,
}: {
  rect: DOMRect | null;
  layer: number;
  width: number;
  setScope: (node: unknown) => void;
  onDismiss: () => void;
  suppressDismiss?: boolean;
  keepOpenOnAltClick?: boolean;
  label: string;
  children: React.ReactNode;
}) {
  const [frame, setFrame] = useState<HTMLDivElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [style, setStyle] = useState<React.CSSProperties>();

  const attachRef = useCallback(
    (node: HTMLDivElement | null) => {
      containerRef.current = node;
      setScope(node);
    },
    [setScope],
  );

  useEffect(() => {
    if (!isWeb) return;
    const onPointerDown = (event: PointerEvent) => {
      if (suppressDismiss || (keepOpenOnAltClick && event.altKey)) return;
      if (
        containerRef.current &&
        event.target instanceof Node &&
        !containerRef.current.contains(event.target)
      ) {
        onDismiss();
      }
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [onDismiss, suppressDismiss, keepOpenOnAltClick]);

  useLayoutEffect(() => {
    if (!isWeb || !frame) return;
    const measure = () => {
      const { height } = frame.getBoundingClientRect();
      const width = Math.max(0, Math.min(preferredWidth, window.innerWidth - FRAME_GAP * 2));
      const edge = rect?.bottom ?? FRAME_GAP;
      const fitsBelow = edge + height + FRAME_GAP * 2 <= window.innerHeight;
      const top = fitsBelow ? edge + FRAME_GAP : (rect?.top ?? edge) - height - FRAME_GAP;
      setStyle({
        zIndex: layer,
        position: "fixed",
        width,
        pointerEvents: "auto",
        maxHeight: Math.max(0, window.innerHeight - FRAME_GAP * 2),
        overflow: "visible",
        top: Math.max(FRAME_GAP, Math.min(top, window.innerHeight - height - FRAME_GAP)),
        left: Math.max(
          FRAME_GAP,
          Math.min(rect?.left ?? FRAME_GAP, window.innerWidth - width - FRAME_GAP),
        ),
        borderRadius: 10,
      });
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(frame);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [frame, layer, preferredWidth, rect]);

  return (
    <div
      ref={attachRef}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      data-ed-overlay="true"
      style={style}
    >
      <div ref={setFrame}>{children}</div>
    </div>
  );
}

function useTargetRect(element: Element | undefined) {
  const [rect, setRect] = useState<{ element: Element; bounds: DOMRect } | null>(null);
  useEffect(() => {
    if (!isWeb || !element) return;
    const measure = () => {
      if (element.isConnected) setRect({ element, bounds: element.getBoundingClientRect() });
      else setRect(null);
    };
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    measure();
    return () => {
      observer?.disconnect();
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [element]);
  return rect && rect.element === element ? rect.bounds : null;
}
