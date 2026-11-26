import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { AgentPermissionRequest } from "@getpaseo/protocol/agent-types";
import { Button } from "@/components/ui/button";
import { useStableEvent } from "@/hooks/use-stable-event";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import type { EditableBranchEntry, EditableReferencedElement } from "./types";
import { EditableLoadButton, EditableShipButton } from "./EditableTooltip.web";
import {
  getAssistantDisplayText,
  getLatestRecommendedPrompts,
  getLatestResponseMeta,
  parseWorkshopUserMessage,
  summarizeToolCall,
  useEditableChat,
} from "./use-editable-chat";

export interface EditableChatDraftControls {
  draft: string;
  setDraft: (value: string) => void;
  canSend: boolean;
  sending: boolean;
  error: string;
  loadedWipSlug: string | null;
  selectedTargetSlug: string | null;
  setSelectedTargetSlug: (slug: string | null) => void;
  availableTargets: ReadonlyArray<string>;
  lastActiveChatSlug: string | null;
  targetNewBranch: boolean;
  setTargetNewBranch: (value: boolean) => void;
  managedWorkshop: boolean;
  choosingHost: boolean;
  setChoosingHost: (value: boolean) => void;
  hosts: ReadonlyArray<{ serverId: string; label: string }>;
  host?: { serverId: string; label: string };
  chooseHost: (serverId: string) => Promise<void>;
  saving: boolean;
  cwd: string;
  setCwd: (value: string) => void;
  defaultCwd: string;
  workshopStatusText: string;
  onSubmitDraft: () => void;
}

export interface EditableChatViewProps {
  serverId: string | null | undefined;
  agentId: string | null | undefined;
  slug?: string | null;
  title: string;
  locatorChip?: string | null;
  branch?: EditableBranchEntry | null;
  draftControls?: EditableChatDraftControls;
  referencedElements?: ReadonlyArray<EditableReferencedElement>;
  onRemoveReference?: (id: string) => void;
  onClearReferences?: () => void;
  onStartPickReference?: () => void;
  pickingReference?: boolean;
  loadedWipSlug?: string | null;
  onSendReferencedToTarget?: (input: {
    targetSlug: string | null;
    text: string;
    references: ReadonlyArray<EditableReferencedElement>;
  }) => Promise<boolean>;
  compact?: boolean;
  busy?: boolean;
  onBack?: () => void;
  onClose?: () => void;
  onPopOut?: (agentId: string) => void;
  onLoadBranch?: (channel: string) => void;
  onShipBranch?: (slug: string) => void;
  onTurnFinished?: () => void;
}

type RefTargetMode = "current" | "loaded" | "new";

interface MarkdownSpan {
  key: string;
  kind: "code" | "bold" | "text";
  text: string;
}

interface MarkdownBlock {
  key: string;
  kind: "code" | "paragraph";
  text: string;
  lines?: Array<{ key: string; text: string; isList: boolean }>;
}

function tokenizeInline(line: string, lineKey: string): MarkdownSpan[] {
  const parts = line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  let offset = 0;
  const spans: MarkdownSpan[] = [];
  for (const part of parts) {
    const key = `${lineKey}:s${offset}`;
    offset += part.length;
    if (!part) continue;
    if (part.startsWith("`") && part.endsWith("`") && part.length > 2) {
      spans.push({ key, kind: "code", text: part.slice(1, -1) });
    } else if (part.startsWith("**") && part.endsWith("**") && part.length > 4) {
      spans.push({ key, kind: "bold", text: part.slice(2, -2) });
    } else {
      spans.push({ key, kind: "text", text: part });
    }
  }
  return spans;
}

function parseMarkdownBlocks(text: string): MarkdownBlock[] {
  const parts = text.split(/(```[\s\S]*?```)/g);
  let offset = 0;
  const blocks: MarkdownBlock[] = [];
  for (const raw of parts) {
    const key = `b${offset}`;
    offset += raw.length;
    if (raw.startsWith("```") && raw.endsWith("```")) {
      const inner = raw.slice(3, -3).replace(/^[a-z0-9_-]*\n/i, "");
      blocks.push({ key, kind: "code", text: inner });
      continue;
    }
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let lineOffset = 0;
    const lines = trimmed.split("\n").map((line) => {
      const lineKey = `${key}:l${lineOffset}`;
      lineOffset += line.length + 1;
      return { key: lineKey, text: line, isList: line.startsWith("- ") };
    });
    blocks.push({ key, kind: "paragraph", text: trimmed, lines });
  }
  return blocks;
}

function SimpleMarkdown({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  return (
    <div style={markdownWrapStyle}>
      {blocks.map((block) =>
        block.kind === "code" ? (
          <pre key={block.key} style={codeBlockStyle}>
            <code>{block.text}</code>
          </pre>
        ) : (
          <div key={block.key} style={paragraphBlockStyle}>
            {(block.lines ?? []).map((line) => (
              <div key={line.key} style={line.isList ? listLineStyle : undefined}>
                {tokenizeInline(line.text, line.key).map((span) => {
                  if (span.kind === "code") {
                    return (
                      <code key={span.key} style={inlineCodeStyle}>
                        {span.text}
                      </code>
                    );
                  }
                  if (span.kind === "bold") return <strong key={span.key}>{span.text}</strong>;
                  return <span key={span.key}>{span.text}</span>;
                })}
              </div>
            ))}
          </div>
        ),
      )}
    </div>
  );
}

const TOOL_MARKER_STYLES = {
  done: { color: "#4ade80", fontSize: 10 },
  running: { color: "#60a5fa", fontSize: 10 },
  failed: { color: "#f87171", fontSize: 10 },
} as const;

function ToolCallRow({ item }: { item: ToolCallItem }) {
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => summarizeToolCall(item), [item]);
  const running = summary.status === "running" || summary.status === "executing";
  const failed = summary.status === "failed";
  const toggle = useStableEvent(() => {
    if (summary.body) setExpanded((prev) => !prev);
  });

  let marker = "✓";
  let markerStyle: React.CSSProperties = TOOL_MARKER_STYLES.done;
  if (running) {
    marker = "●";
    markerStyle = TOOL_MARKER_STYLES.running;
  } else if (failed) {
    marker = "!";
    markerStyle = TOOL_MARKER_STYLES.failed;
  }

  return (
    <div style={toolRowStyle}>
      <button type="button" onClick={toggle} style={toolButtonStyle}>
        <span style={markerStyle}>{marker}</span>
        <span style={toolTitleStyle}>{summary.title}</span>
      </button>
      {expanded && summary.body ? <pre style={toolBodyStyle}>{summary.body}</pre> : null}
    </div>
  );
}

function ThoughtRow({ text, active }: { text: string; active: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const toggle = useStableEvent(() => setExpanded((prev) => !prev));
  return (
    <div style={thoughtRowStyle}>
      <button type="button" onClick={toggle} style={thoughtToggleStyle}>
        <span>{active ? "Thinking…" : "Thought"}</span>
      </button>
      {expanded && text.trim() ? <div style={thoughtBodyStyle}>{text.trim()}</div> : null}
    </div>
  );
}

function StreamItemRow({ item, displayText }: { item: StreamItem; displayText: string | null }) {
  if (item.kind === "user_message") {
    const parsed = parseWorkshopUserMessage(item.text);
    const uniqueLabels = Array.from(new Set(parsed.locatorLabels));
    return (
      <div style={userRowWrapStyle}>
        <div style={userBubbleStyle}>
          {uniqueLabels.length > 0 ? (
            <div style={locatorListStyle}>
              {uniqueLabels.map((label) => (
                <div key={label} style={locatorPillStyle}>
                  {label}
                </div>
              ))}
            </div>
          ) : null}
          <div style={userTextStyle}>{parsed.text}</div>
        </div>
      </div>
    );
  }
  if (item.kind === "assistant_message") {
    const text = displayText ?? item.text;
    if (!text.trim()) return null;
    return (
      <div style={assistantBubbleStyle}>
        <SimpleMarkdown text={text} />
      </div>
    );
  }
  if (item.kind === "tool_call") return <ToolCallRow item={item} />;
  if (item.kind === "thought") {
    return <ThoughtRow text={item.text} active={item.status === "loading"} />;
  }
  if (item.kind === "notification") {
    return (
      <div style={item.level === "error" ? errorBannerStyle : notificationStyle}>
        {item.message}
      </div>
    );
  }
  return null;
}

function resolveRecommendedSendStyle(hovered: boolean, sending: boolean): React.CSSProperties {
  if (sending && hovered) return recommendedSendHoveredPendingStyle;
  if (sending) return recommendedSendPendingStyle;
  if (hovered) return recommendedSendHoveredStyle;
  return recommendedSendStyle;
}

function RecommendedPromptRow({
  prompt,
  disabled,
  onSend,
  onUseEdited,
}: {
  prompt: string;
  disabled: boolean;
  onSend: (prompt: string) => Promise<void>;
  onUseEdited: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const [hovered, setHovered] = useState(false);
  const [sending, setSending] = useState(false);
  const isDisabled = disabled || sending;

  const sendLabel = t("responseControl.recommendedPrompts.send") || "Send prompt";
  const editLabel = t("responseControl.recommendedPrompts.useEdited") || "Use edited";

  const handleEnter = useStableEvent(() => setHovered(true));
  const handleLeave = useStableEvent(() => setHovered(false));
  const handleSend = useStableEvent(() => {
    if (isDisabled) return;
    setSending(true);
    void onSend(prompt).finally(() => setSending(false));
  });
  const handleEdit = useStableEvent(() => {
    if (isDisabled) return;
    onUseEdited(prompt);
  });

  return (
    <div
      style={recommendedRowStyle}
      data-testid="editable-recommended-prompt"
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      <button
        type="button"
        disabled={isDisabled}
        aria-label={`${sendLabel}: ${prompt}`}
        onClick={handleSend}
        style={resolveRecommendedSendStyle(hovered, sending)}
      >
        <svg
          width="13"
          height="13"
          viewBox="0 0 24 24"
          fill="none"
          stroke={hovered ? "#f8fafc" : "#94a3b8"}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          style={recommendedIconStyle}
        >
          <polyline points="15 10 20 15 15 20" />
          <path d="M4 4v7a4 4 0 0 0 4 4h12" />
        </svg>
        <span style={hovered ? recommendedTextHoveredStyle : recommendedTextStyle}>{prompt}</span>
      </button>
      <button
        type="button"
        disabled={isDisabled}
        aria-label={`${editLabel}: ${prompt}`}
        title={editLabel}
        onClick={handleEdit}
        style={hovered ? recommendedEditVisibleStyle : recommendedEditHiddenStyle}
      >
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
        </svg>
      </button>
    </div>
  );
}

function RecommendedPromptsList({
  prompts,
  disabled,
  onSend,
  onUseEdited,
}: {
  prompts: readonly string[];
  disabled: boolean;
  onSend: (prompt: string) => Promise<void>;
  onUseEdited: (prompt: string) => void;
}) {
  if (prompts.length === 0) return null;
  return (
    <div style={recommendedListStyle} data-testid="editable-recommended-prompts">
      {prompts.map((prompt) => (
        <RecommendedPromptRow
          key={prompt}
          prompt={prompt}
          disabled={disabled}
          onSend={onSend}
          onUseEdited={onUseEdited}
        />
      ))}
    </div>
  );
}

function PermissionCard({
  request,
  onRespond,
}: {
  request: AgentPermissionRequest;
  onRespond: (requestId: string, behavior: "allow" | "deny") => void;
}) {
  const { t } = useTranslation();
  const allow = useStableEvent(() => onRespond(request.id, "allow"));
  const deny = useStableEvent(() => onRespond(request.id, "deny"));
  return (
    <div style={permissionCardStyle}>
      <div style={permissionTitleStyle}>{request.title || request.name}</div>
      {request.description ? <div style={permissionDescStyle}>{request.description}</div> : null}
      <div style={permissionActionsStyle}>
        <Button size="sm" onPress={allow}>
          {t("editable.allowPermission")}
        </Button>
        <Button size="sm" variant="ghost" onPress={deny}>
          {t("editable.denyPermission")}
        </Button>
      </div>
    </div>
  );
}

function HostOptionButton({
  serverId,
  label,
  disabled,
  onChoose,
}: {
  serverId: string;
  label: string;
  disabled: boolean;
  onChoose: (serverId: string) => Promise<void>;
}) {
  const handlePress = useStableEvent(() => {
    void onChoose(serverId);
  });
  return (
    <Button size="sm" disabled={disabled} onPress={handlePress}>
      {label}
    </Button>
  );
}

function TargetSlugButton({
  slug,
  active,
  onSelect,
}: {
  slug: string;
  active: boolean;
  onSelect: (slug: string) => void;
}) {
  const handlePress = useStableEvent(() => onSelect(slug));
  return (
    <Button size="sm" variant={active ? "default" : "ghost"} onPress={handlePress}>
      {slug}
    </Button>
  );
}

function resolveDraftTargetOptions(controls: EditableChatDraftControls): {
  quickPills: string[];
  overflow: string[];
} {
  const availableSet = new Set(controls.availableTargets);
  const quickPills: string[] = [];
  const pushQuick = (slug: string | null | undefined) => {
    if (slug && !quickPills.includes(slug)) quickPills.push(slug);
  };

  pushQuick(controls.loadedWipSlug);
  if (controls.lastActiveChatSlug && availableSet.has(controls.lastActiveChatSlug)) {
    pushQuick(controls.lastActiveChatSlug);
  }
  pushQuick(controls.selectedTargetSlug);
  if (quickPills.length === 0 && controls.availableTargets.length === 1) {
    pushQuick(controls.availableTargets[0]);
  }

  const overflow = controls.availableTargets.filter((slug) => !quickPills.includes(slug));
  return { quickPills, overflow };
}

function DraftTargetRow({ controls }: { controls: EditableChatDraftControls }) {
  const { t } = useTranslation();
  const { quickPills, overflow } = resolveDraftTargetOptions(controls);
  const selectNew = useStableEvent(() => controls.setSelectedTargetSlug(null));
  const selectSlug = useStableEvent((slug: string) => controls.setSelectedTargetSlug(slug));
  const handleSelectOverflow = useStableEvent((event: React.ChangeEvent<HTMLSelectElement>) => {
    const val = event.target.value;
    if (val) controls.setSelectedTargetSlug(val);
  });

  if (quickPills.length === 0 && overflow.length === 0) return null;

  return (
    <div style={targetToggleRowStyle}>
      <span style={mutedSmallStyle}>{t("editable.targetOn")}</span>
      {quickPills.map((slug) => (
        <TargetSlugButton
          key={slug}
          slug={slug}
          active={controls.selectedTargetSlug === slug}
          onSelect={selectSlug}
        />
      ))}
      <Button
        size="sm"
        variant={controls.selectedTargetSlug === null ? "default" : "ghost"}
        onPress={selectNew}
      >
        {t("editable.newBranch")}
      </Button>
      {overflow.length > 0 ? (
        <select
          aria-label={t("editable.otherThreads")}
          value=""
          onChange={handleSelectOverflow}
          style={targetSelectStyle}
        >
          <option value="">{t("editable.otherThreads")}</option>
          {overflow.map((slug) => (
            <option key={slug} value={slug}>
              {slug}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

function DraftSetupSection({ controls }: { controls: EditableChatDraftControls }) {
  const { t } = useTranslation();
  const showHostPicker = useStableEvent(() => controls.setChoosingHost(true));
  const handleCwdChange = useStableEvent((event: React.ChangeEvent<HTMLInputElement>) => {
    controls.setCwd(event.target.value);
  });

  return (
    <>
      <DraftTargetRow controls={controls} />

      {!controls.managedWorkshop && controls.choosingHost ? (
        <div style={hostSetupStyle}>
          <span style={mutedSmallStyle}>
            {t(controls.hosts.length ? "editable.selectHost" : "editable.noHosts")}
          </span>
          <div style={hostButtonsStyle}>
            {controls.hosts.map((host) => (
              <HostOptionButton
                key={host.serverId}
                serverId={host.serverId}
                label={host.label}
                disabled={controls.saving}
                onChoose={controls.chooseHost}
              />
            ))}
          </div>
        </div>
      ) : null}

      {!controls.managedWorkshop && !controls.choosingHost ? (
        <div style={hostRowStyle}>
          <Button size="sm" variant="ghost" onPress={showHostPicker}>
            {controls.host?.label ?? t("editable.selectHost")}
          </Button>
          <input
            type="text"
            aria-label={t("editable.repoPath")}
            placeholder={controls.defaultCwd}
            value={controls.cwd}
            onChange={handleCwdChange}
            style={pathInputStyle}
          />
        </div>
      ) : null}
    </>
  );
}

function ReferenceChip({
  reference,
  onRemove,
}: {
  reference: EditableReferencedElement;
  onRemove?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const handleRemove = useStableEvent(() => onRemove?.(reference.id));
  return (
    <span style={refChipStyle}>
      <span style={refChipTextStyle}>{reference.label}</span>
      {onRemove ? (
        <button
          type="button"
          aria-label={`${t("editable.removeReference")}: ${reference.label}`}
          onClick={handleRemove}
          style={refChipCloseStyle}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}

function ReferencedElementsSection({
  references,
  currentSlug,
  loadedWipSlug,
  targetMode,
  canRouteToOtherTarget,
  onSelectTargetMode,
  onRemoveReference,
}: {
  references: ReadonlyArray<EditableReferencedElement>;
  currentSlug: string | null | undefined;
  loadedWipSlug: string | null | undefined;
  targetMode: RefTargetMode;
  canRouteToOtherTarget: boolean;
  onSelectTargetMode: (mode: RefTargetMode) => void;
  onRemoveReference?: (id: string) => void;
}) {
  const { t } = useTranslation();
  const selectCurrent = useStableEvent(() => onSelectTargetMode("current"));
  const selectLoaded = useStableEvent(() => onSelectTargetMode("loaded"));
  const selectNew = useStableEvent(() => onSelectTargetMode("new"));
  if (references.length === 0) return null;

  const showLoadedOption = Boolean(
    canRouteToOtherTarget && loadedWipSlug && loadedWipSlug !== currentSlug,
  );

  return (
    <div style={refSectionStyle}>
      <div style={refChipsWrapStyle}>
        {references.map((ref) => (
          <ReferenceChip key={ref.id} reference={ref} onRemove={onRemoveReference} />
        ))}
      </div>
      {canRouteToOtherTarget ? (
        <div style={targetToggleRowStyle}>
          <span style={mutedSmallStyle}>{t("editable.sendToLabel")}</span>
          <Button
            size="sm"
            variant={targetMode === "current" ? "default" : "ghost"}
            onPress={selectCurrent}
          >
            {currentSlug || t("editable.openChatShort")}
          </Button>
          {showLoadedOption ? (
            <Button
              size="sm"
              variant={targetMode === "loaded" ? "default" : "ghost"}
              onPress={selectLoaded}
            >
              {loadedWipSlug}
            </Button>
          ) : null}
          <Button
            size="sm"
            variant={targetMode === "new" ? "default" : "ghost"}
            onPress={selectNew}
          >
            {t("editable.newBranch")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}

const statusDotBase = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  flexShrink: 0,
} as const;

const HEADER_DOT_STYLES = {
  amber: { ...statusDotBase, background: "#f59e0b" },
  blue: { ...statusDotBase, background: "#4191fb" },
  red: { ...statusDotBase, background: "#ef4444" },
  green: { ...statusDotBase, background: "#22c55e" },
  gray: { ...statusDotBase, background: "#64748b" },
} as const;

function resolveHeaderDotStyle(
  branch: EditableBranchEntry | null | undefined,
  isRunning: boolean,
): React.CSSProperties {
  if (branch?.hasUpdate) return HEADER_DOT_STYLES.amber;
  if (isRunning || branch?.status === "shipping") return HEADER_DOT_STYLES.blue;
  if (branch?.status === "failed") return HEADER_DOT_STYLES.red;
  if (branch?.loaded || branch?.status === "ready") return HEADER_DOT_STYLES.green;
  return HEADER_DOT_STYLES.gray;
}

function resolveBranchActionFlags(
  branch: EditableBranchEntry | null | undefined,
  hasLoad: boolean,
  hasShip: boolean,
) {
  if (!branch) {
    return {
      canLoad: false,
      canShip: false,
      hasUpdate: false,
      canFastForward: false,
      restartsDaemon: false,
    };
  }
  const hasChanges = Boolean(
    branch.hasChanges ?? (branch.releaseDigest || branch.daemonReleaseDigest),
  );
  const hasLoadableBuild = Boolean(branch.releaseDigest || branch.daemonReleaseDigest);
  return {
    canLoad: hasLoad && hasChanges && hasLoadableBuild && (!branch.loaded || branch.hasUpdate),
    canShip: hasShip && hasChanges && branch.status === "ready",
    hasUpdate: branch.hasUpdate,
    canFastForward: branch.canFastForward,
    restartsDaemon: Boolean(branch.requiresDaemonRestartOnLoad),
  };
}

function ChatHeaderActions({
  branch,
  agentId,
  busy,
  onClose,
  onPopOut,
  onLoadBranch,
  onShipBranch,
}: {
  branch?: EditableBranchEntry | null;
  agentId: string | null | undefined;
  busy: boolean;
  onClose?: () => void;
  onPopOut?: (agentId: string) => void;
  onLoadBranch?: (channel: string) => void;
  onShipBranch?: (slug: string) => void;
}) {
  const { t } = useTranslation();
  const handleLoad = useStableEvent(() => {
    if (branch && onLoadBranch) onLoadBranch(branch.channel);
  });
  const handleShip = useStableEvent(() => {
    if (branch && onShipBranch) onShipBranch(branch.slug);
  });
  const handlePopOut = useStableEvent(() => {
    if (agentId && onPopOut) onPopOut(agentId);
  });

  const flags = resolveBranchActionFlags(branch, Boolean(onLoadBranch), Boolean(onShipBranch));

  return (
    <div style={headerActionsStyle}>
      {flags.canLoad ? (
        <EditableLoadButton
          label={flags.hasUpdate ? t("editable.reloadRelease") : t("editable.loadBranch")}
          variant={flags.hasUpdate ? "default" : "ghost"}
          disabled={busy}
          restartsRunningDaemon={flags.restartsDaemon}
          onPress={handleLoad}
        />
      ) : null}
      {flags.canShip ? (
        <EditableShipButton
          canFastForward={flags.canFastForward}
          hasUiBuild={Boolean(branch?.releaseDigest)}
          hasDaemonBuild={Boolean(branch?.daemonReleaseDigest || branch?.requiresDaemon)}
          disabled={busy}
          onPress={handleShip}
        />
      ) : null}
      {agentId && onPopOut ? (
        <button
          type="button"
          aria-label={t("editable.openFullChat")}
          title={t("editable.openFullChat")}
          onClick={handlePopOut}
          style={iconButtonStyle}
        >
          ↗
        </button>
      ) : null}
      {onClose ? (
        <button
          type="button"
          aria-label={t("editable.cancel")}
          onClick={onClose}
          style={iconButtonStyle}
        >
          ×
        </button>
      ) : null}
    </div>
  );
}

function ChatHeaderBar({
  title,
  icon,
  subtitle,
  branch,
  agentId,
  isRunning,
  busy,
  onBack,
  onClose,
  onPopOut,
  onLoadBranch,
  onShipBranch,
}: {
  title: string;
  icon?: string | null;
  subtitle?: string | null;
  branch?: EditableBranchEntry | null;
  agentId: string | null | undefined;
  isRunning: boolean;
  busy: boolean;
  onBack?: () => void;
  onClose?: () => void;
  onPopOut?: (agentId: string) => void;
  onLoadBranch?: (channel: string) => void;
  onShipBranch?: (slug: string) => void;
}) {
  const { t } = useTranslation();
  const dotStyle = resolveHeaderDotStyle(branch, isRunning);

  return (
    <div style={headerStyle}>
      <div style={headerLeftStyle}>
        {onBack ? (
          <button
            type="button"
            aria-label={t("editable.backToBranches")}
            onClick={onBack}
            style={iconButtonStyle}
          >
            ←
          </button>
        ) : null}
        <span style={dotStyle} />
        <div style={headerTitlesStyle}>
          <span style={headerTitleStyle}>
            {icon ? `${icon} ` : ""}
            {title}
          </span>
          {subtitle ? <span style={headerSubStyle}>{subtitle}</span> : null}
        </div>
      </div>
      <ChatHeaderActions
        branch={branch}
        agentId={agentId}
        busy={busy}
        onClose={onClose}
        onPopOut={onPopOut}
        onLoadBranch={onLoadBranch}
        onShipBranch={onShipBranch}
      />
    </div>
  );
}

function ChatMessagesPanel({
  items,
  pendingPermissions,
  recommendedPrompts,
  loading,
  isRunning,
  sendingFollowUp,
  onRespondPermission,
  onSendRecommendedPrompt,
  onUseEditedRecommendedPrompt,
}: {
  items: StreamItem[];
  pendingPermissions: AgentPermissionRequest[];
  recommendedPrompts: readonly string[];
  loading: boolean;
  isRunning: boolean;
  sendingFollowUp: boolean;
  onRespondPermission: (requestId: string, behavior: "allow" | "deny") => void;
  onSendRecommendedPrompt: (prompt: string) => Promise<void>;
  onUseEditedRecommendedPrompt: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, pendingPermissions, recommendedPrompts, isRunning]);

  return (
    <div ref={scrollRef} style={messagesScrollStyle}>
      {loading && items.length === 0 ? (
        <div style={mutedSmallStyle}>{t("editable.chatLoading")}</div>
      ) : null}
      {items.map((item, index) => (
        <StreamItemRow
          key={item.id}
          item={item}
          displayText={
            item.kind === "assistant_message"
              ? getAssistantDisplayText(items, index, isRunning)
              : null
          }
        />
      ))}
      {pendingPermissions.map((req) => (
        <PermissionCard key={req.id} request={req} onRespond={onRespondPermission} />
      ))}
      {isRunning ? <div style={thinkingIndicatorStyle}>{t("editable.workingBadge")}</div> : null}
      <RecommendedPromptsList
        prompts={recommendedPrompts}
        disabled={sendingFollowUp || isRunning}
        onSend={onSendRecommendedPrompt}
        onUseEdited={onUseEditedRecommendedPrompt}
      />
    </div>
  );
}

function ChatComposerPanel({
  isDraftMode,
  draftControls,
  currentSlug,
  loadedWipSlug,
  referencedElements,
  refTargetMode,
  canRouteToOtherTarget,
  pickingReference,
  value,
  placeholder,
  error,
  canSend,
  showStop,
  inputRef,
  onChangeValue,
  onKeyDown,
  onSelectRefTargetMode,
  onRemoveReference,
  onStartPickReference,
  onStop,
  onSubmit,
}: {
  isDraftMode: boolean;
  draftControls?: EditableChatDraftControls;
  currentSlug?: string | null;
  loadedWipSlug?: string | null;
  referencedElements: ReadonlyArray<EditableReferencedElement>;
  refTargetMode: RefTargetMode;
  canRouteToOtherTarget: boolean;
  pickingReference: boolean;
  value: string;
  placeholder: string;
  error: string | null;
  canSend: boolean;
  showStop: boolean;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  onChangeValue: (next: string) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onSelectRefTargetMode: (mode: RefTargetMode) => void;
  onRemoveReference?: (id: string) => void;
  onStartPickReference?: () => void;
  onStop: () => void;
  onSubmit: () => void;
}) {
  const { t } = useTranslation();
  const handleChange = useStableEvent((event: React.ChangeEvent<HTMLTextAreaElement>) => {
    onChangeValue(event.target.value);
  });
  const hint =
    isDraftMode && draftControls?.managedWorkshop
      ? draftControls.workshopStatusText
      : t("editable.chatEnterHint");

  return (
    <div style={composerBoxStyle}>
      {isDraftMode && draftControls ? <DraftSetupSection controls={draftControls} /> : null}
      {!isDraftMode ? (
        <ReferencedElementsSection
          references={referencedElements}
          currentSlug={currentSlug}
          loadedWipSlug={loadedWipSlug}
          targetMode={refTargetMode}
          canRouteToOtherTarget={canRouteToOtherTarget}
          onSelectTargetMode={onSelectRefTargetMode}
          onRemoveReference={onRemoveReference}
        />
      ) : null}
      {error ? (
        <div role="alert" style={errorBannerStyle}>
          {error}
        </div>
      ) : null}
      <textarea
        ref={inputRef}
        aria-label={placeholder}
        placeholder={placeholder}
        value={value}
        rows={isDraftMode ? 2 : 1}
        onChange={handleChange}
        onKeyDown={onKeyDown}
        style={textareaStyle}
      />
      <div style={composerFooterStyle}>
        <div style={composerLeftStyle}>
          {!isDraftMode && onStartPickReference ? (
            <button
              type="button"
              aria-label={t("editable.referenceElementHint")}
              title={t("editable.referenceElementHint")}
              onClick={onStartPickReference}
              style={pickingReference ? pickElementActiveStyle : pickElementButtonStyle}
            >
              <span>⌖</span>
              <span>
                {pickingReference ? t("editable.pickingElement") : t("editable.pickElementShort")}
              </span>
            </button>
          ) : (
            <span style={mutedSmallStyle}>{hint}</span>
          )}
        </div>
        <div style={composerActionsStyle}>
          {showStop ? (
            <Button size="sm" variant="ghost" onPress={onStop}>
              {t("editable.stopChat")}
            </Button>
          ) : null}
          <Button size="sm" variant="default" disabled={!canSend} onPress={onSubmit}>
            {t("editable.send")}
          </Button>
        </div>
      </div>
    </div>
  );
}

const EMPTY_REFERENCES: ReadonlyArray<EditableReferencedElement> = [];

function resolveHeaderSubtitle(
  locatorChip: string | null | undefined,
  metaTitle: string | undefined,
  title: string,
): string | null {
  if (locatorChip) return locatorChip;
  return metaTitle && metaTitle !== title ? metaTitle : null;
}

function useLiveChatSubmission({
  referencedElements,
  refTargetMode,
  loadedWipSlug,
  onSendReferencedToTarget,
  onClearReferences,
  setRefTargetMode,
  sendFollowUp,
}: {
  referencedElements: ReadonlyArray<EditableReferencedElement>;
  refTargetMode: RefTargetMode;
  loadedWipSlug: string | null | undefined;
  onSendReferencedToTarget?: EditableChatViewProps["onSendReferencedToTarget"];
  onClearReferences?: () => void;
  setRefTargetMode: (mode: RefTargetMode) => void;
  sendFollowUp: ReturnType<typeof useEditableChat>["sendFollowUp"];
}) {
  const [routingReferenced, setRoutingReferenced] = useState(false);

  const sendLiveMessage = useStableEvent(async (text: string) => {
    const refs = referencedElements;
    if (refs.length > 0 && refTargetMode !== "current" && onSendReferencedToTarget) {
      const targetSlug = refTargetMode === "loaded" ? (loadedWipSlug ?? null) : null;
      setRoutingReferenced(true);
      try {
        const ok = await onSendReferencedToTarget({ targetSlug, text, references: refs });
        if (ok) {
          onClearReferences?.();
          setRefTargetMode("current");
        }
      } finally {
        setRoutingReferenced(false);
      }
      return;
    }
    onClearReferences?.();
    setRefTargetMode("current");
    await sendFollowUp(text, refs.length > 0 ? { references: refs } : undefined);
  });

  return { routingReferenced, sendLiveMessage };
}

function resolveChatComposerState(input: {
  isDraftMode: boolean;
  draftControls?: EditableChatDraftControls;
  followUpDraft: string;
  setFollowUpDraft: (value: string) => void;
  sendingFollowUp: boolean;
  routingReferenced: boolean;
  chatError: string | null;
  chatIsRunning: boolean;
}) {
  if (input.isDraftMode && input.draftControls) {
    return {
      value: input.draftControls.draft,
      setValue: input.draftControls.setDraft,
      canSend: input.draftControls.canSend,
      error: input.draftControls.error || null,
      isRunning: input.draftControls.sending,
    };
  }
  return {
    value: input.followUpDraft,
    setValue: input.setFollowUpDraft,
    canSend:
      Boolean(input.followUpDraft.trim()) && !input.sendingFollowUp && !input.routingReferenced,
    error: input.chatError,
    isRunning: input.chatIsRunning,
  };
}

export function EditableChatView({
  serverId,
  agentId,
  slug,
  title,
  locatorChip,
  branch,
  draftControls,
  referencedElements = EMPTY_REFERENCES,
  onRemoveReference,
  onClearReferences,
  onStartPickReference,
  pickingReference = false,
  loadedWipSlug,
  onSendReferencedToTarget,
  compact = false,
  busy = false,
  onBack,
  onClose,
  onPopOut,
  onLoadBranch,
  onShipBranch,
  onTurnFinished,
}: EditableChatViewProps) {
  const { t } = useTranslation();
  const isDraftMode = !agentId && Boolean(draftControls);
  const chat = useEditableChat({ serverId, agentId, onTurnFinished });
  const [followUpDraft, setFollowUpDraft] = useState("");
  const [refTargetMode, setRefTargetMode] = useState<RefTargetMode>("current");
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const prevRefCount = useRef(referencedElements.length);

  const { routingReferenced, sendLiveMessage } = useLiveChatSubmission({
    referencedElements,
    refTargetMode,
    loadedWipSlug,
    onSendReferencedToTarget,
    onClearReferences,
    setRefTargetMode,
    sendFollowUp: chat.sendFollowUp,
  });

  const composer = resolveChatComposerState({
    isDraftMode,
    draftControls,
    followUpDraft,
    setFollowUpDraft,
    sendingFollowUp: chat.sendingFollowUp,
    routingReferenced,
    chatError: chat.error,
    chatIsRunning: chat.isRunning,
  });

  useEffect(() => {
    inputRef.current?.focus();
    setRefTargetMode("current");
  }, [agentId]);

  useEffect(() => {
    if (referencedElements.length === 0) setRefTargetMode("current");
    else if (referencedElements.length > prevRefCount.current) inputRef.current?.focus();
    prevRefCount.current = referencedElements.length;
  }, [referencedElements.length]);

  const recommendedPrompts = useMemo(
    () => (isDraftMode ? [] : getLatestRecommendedPrompts(chat.items, chat.isRunning)),
    [isDraftMode, chat.items, chat.isRunning],
  );
  const latestMeta = useMemo(
    () => (isDraftMode ? null : getLatestResponseMeta(chat.items)),
    [isDraftMode, chat.items],
  );

  const submitCurrent = useStableEvent(() => {
    if (!composer.canSend) return;
    if (isDraftMode) {
      draftControls!.onSubmitDraft();
      return;
    }
    const text = followUpDraft;
    setFollowUpDraft("");
    void sendLiveMessage(text);
  });

  const handleUseEditedRecommended = useStableEvent((promptText: string) => {
    setFollowUpDraft((current) =>
      current.trim() ? `${current.trimEnd()}\n\n${promptText}` : promptText,
    );
    inputRef.current?.focus();
  });

  const handleKeyDown = useStableEvent((event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      if (pickingReference && onStartPickReference) onStartPickReference();
      else onClose?.();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submitCurrent();
    }
  });

  const handleStop = useStableEvent(() => {
    void chat.cancel();
  });

  const placeholder = isDraftMode ? t("editable.placeholder") : t("editable.chatReplyPlaceholder");

  return (
    <div style={compact && isDraftMode ? containerCompactStyle : containerStyle}>
      <ChatHeaderBar
        title={title}
        icon={latestMeta?.icon ?? null}
        subtitle={resolveHeaderSubtitle(locatorChip, latestMeta?.title, title)}
        branch={branch}
        agentId={agentId}
        isRunning={composer.isRunning}
        busy={busy}
        onBack={onBack}
        onClose={onClose}
        onPopOut={onPopOut}
        onLoadBranch={onLoadBranch}
        onShipBranch={onShipBranch}
      />
      {!isDraftMode ? (
        <ChatMessagesPanel
          items={chat.items}
          pendingPermissions={chat.pendingPermissions}
          recommendedPrompts={recommendedPrompts}
          loading={chat.loading}
          isRunning={chat.isRunning}
          sendingFollowUp={chat.sendingFollowUp || routingReferenced}
          onRespondPermission={chat.respondPermission}
          onSendRecommendedPrompt={sendLiveMessage}
          onUseEditedRecommendedPrompt={handleUseEditedRecommended}
        />
      ) : null}
      <ChatComposerPanel
        isDraftMode={isDraftMode}
        draftControls={draftControls}
        currentSlug={slug}
        loadedWipSlug={loadedWipSlug}
        referencedElements={referencedElements}
        refTargetMode={refTargetMode}
        canRouteToOtherTarget={Boolean(onSendReferencedToTarget)}
        pickingReference={pickingReference}
        value={composer.value}
        placeholder={placeholder}
        error={composer.error}
        canSend={composer.canSend}
        showStop={!isDraftMode && chat.isRunning}
        inputRef={inputRef}
        onChangeValue={composer.setValue}
        onKeyDown={handleKeyDown}
        onSelectRefTargetMode={setRefTargetMode}
        onRemoveReference={onRemoveReference}
        onStartPickReference={onStartPickReference}
        onStop={handleStop}
        onSubmit={submitCurrent}
      />
    </div>
  );
}

const containerStyle = {
  display: "flex",
  flexDirection: "column",
  background: "#161a22",
  color: "#f8fafc",
  border: "1px solid rgba(255, 255, 255, 0.16)",
  borderRadius: 10,
  boxShadow: "0 14px 36px rgba(0, 0, 0, 0.58)",
  font: "400 12px/17px system-ui, -apple-system, sans-serif",
  overflow: "hidden",
  maxHeight: 500,
} as const;

const containerCompactStyle = {
  ...containerStyle,
  maxHeight: 340,
} as const;

const headerStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  padding: "8px 10px",
  borderBottom: "1px solid rgba(255, 255, 255, 0.09)",
  background: "#1b202b",
  flexShrink: 0,
} as const;

const headerLeftStyle = {
  display: "flex",
  alignItems: "center",
  gap: 7,
  minWidth: 0,
  flex: 1,
} as const;

const headerTitlesStyle = {
  display: "flex",
  flexDirection: "column",
  minWidth: 0,
} as const;

const headerTitleStyle = {
  fontWeight: 600,
  fontSize: 12,
  color: "#f8fafc",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

const headerSubStyle = {
  fontSize: 10,
  color: "#94a3b8",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

const headerActionsStyle = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexShrink: 0,
} as const;

const iconButtonStyle = {
  background: "transparent",
  border: "none",
  color: "#cbd5e1",
  cursor: "pointer",
  fontSize: 13,
  lineHeight: "16px",
  padding: "2px 5px",
  borderRadius: 4,
} as const;

const messagesScrollStyle = {
  flex: 1,
  minHeight: 140,
  maxHeight: 320,
  overflowY: "auto",
  padding: "10px",
  display: "flex",
  flexDirection: "column",
  gap: 8,
} as const;

const userRowWrapStyle = {
  display: "flex",
  justifyContent: "flex-end",
} as const;

const userBubbleStyle = {
  maxWidth: "88%",
  background: "#1d3354",
  border: "1px solid rgba(65, 145, 251, 0.35)",
  color: "#f8fafc",
  borderRadius: 8,
  padding: "6px 9px",
  display: "flex",
  flexDirection: "column",
  gap: 4,
} as const;

const locatorListStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
} as const;

const locatorPillStyle = {
  fontSize: 10,
  color: "#93c5fd",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

const userTextStyle = {
  fontSize: 12,
  lineHeight: "17px",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
} as const;

const assistantBubbleStyle = {
  color: "#e2e8f0",
  fontSize: 12,
  lineHeight: "18px",
  wordBreak: "break-word",
  userSelect: "text",
} as const;

const recommendedListStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
  marginTop: 2,
} as const;

const recommendedRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 2,
} as const;

const recommendedSendStyle = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  alignItems: "center",
  gap: 7,
  padding: "4px 6px",
  borderRadius: 6,
  border: "none",
  background: "transparent",
  cursor: "pointer",
  textAlign: "left",
} as const;

const recommendedSendHoveredStyle = {
  ...recommendedSendStyle,
  background: "rgba(255, 255, 255, 0.08)",
} as const;

const recommendedSendPendingStyle = {
  ...recommendedSendStyle,
  opacity: 0.5,
} as const;

const recommendedSendHoveredPendingStyle = {
  ...recommendedSendHoveredStyle,
  opacity: 0.5,
} as const;

const recommendedIconStyle = {
  flexShrink: 0,
} as const;

const recommendedTextStyle = {
  flex: 1,
  color: "#94a3b8",
  fontSize: 11.5,
  lineHeight: "16px",
} as const;

const recommendedTextHoveredStyle = {
  ...recommendedTextStyle,
  color: "#f8fafc",
} as const;

const recommendedEditStyle = {
  width: 24,
  height: 24,
  flexShrink: 0,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  border: "none",
  borderRadius: 6,
  background: "transparent",
  color: "#94a3b8",
  cursor: "pointer",
  padding: 0,
} as const;

const recommendedEditVisibleStyle = {
  ...recommendedEditStyle,
  opacity: 1,
  pointerEvents: "auto",
} as const;

const recommendedEditHiddenStyle = {
  ...recommendedEditStyle,
  opacity: 0,
  pointerEvents: "none",
} as const;

const markdownWrapStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 6,
} as const;

const paragraphBlockStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
} as const;

const listLineStyle = {
  paddingLeft: 8,
} as const;

const inlineCodeStyle = {
  background: "rgba(255, 255, 255, 0.1)",
  borderRadius: 4,
  padding: "0 4px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
} as const;

const codeBlockStyle = {
  margin: 0,
  padding: "6px 8px",
  borderRadius: 6,
  background: "#0f131a",
  border: "1px solid rgba(255, 255, 255, 0.08)",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 11,
  overflowX: "auto",
  whiteSpace: "pre-wrap",
} as const;

const toolRowStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
} as const;

const toolButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  alignSelf: "flex-start",
  maxWidth: "100%",
  background: "#1d222d",
  border: "1px solid rgba(255, 255, 255, 0.08)",
  borderRadius: 6,
  padding: "3px 7px",
  color: "#94a3b8",
  fontSize: 11,
  cursor: "pointer",
  textAlign: "left",
} as const;

const toolTitleStyle = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

const toolBodyStyle = {
  margin: 0,
  padding: "6px 8px",
  borderRadius: 6,
  background: "#0f131a",
  color: "#cbd5e1",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: 10,
  maxHeight: 140,
  overflowY: "auto",
  whiteSpace: "pre-wrap",
} as const;

const thoughtRowStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 3,
} as const;

const thoughtToggleStyle = {
  alignSelf: "flex-start",
  background: "transparent",
  border: "none",
  padding: 0,
  color: "#64748b",
  fontSize: 11,
  fontStyle: "italic",
  cursor: "pointer",
} as const;

const thoughtBodyStyle = {
  color: "#94a3b8",
  fontSize: 11,
  borderLeft: "2px solid rgba(148, 163, 184, 0.3)",
  paddingLeft: 8,
  whiteSpace: "pre-wrap",
} as const;

const permissionCardStyle = {
  padding: "8px 9px",
  borderRadius: 8,
  background: "rgba(245, 158, 11, 0.14)",
  border: "1px solid rgba(245, 158, 11, 0.4)",
  display: "flex",
  flexDirection: "column",
  gap: 5,
} as const;

const permissionTitleStyle = {
  color: "#fde68a",
  fontWeight: 600,
  fontSize: 11,
} as const;

const permissionDescStyle = {
  color: "#fef3c7",
  fontSize: 11,
  whiteSpace: "pre-wrap",
} as const;

const permissionActionsStyle = {
  display: "flex",
  gap: 6,
} as const;

const thinkingIndicatorStyle = {
  color: "#93c5fd",
  fontSize: 11,
} as const;

const notificationStyle = {
  color: "#cbd5e1",
  fontSize: 11,
  padding: "4px 6px",
  borderRadius: 6,
  background: "rgba(148, 163, 184, 0.12)",
} as const;

const errorBannerStyle = {
  color: "#fca5a5",
  fontSize: 11,
  padding: "5px 7px",
  borderRadius: 6,
  background: "rgba(239, 68, 68, 0.14)",
  border: "1px solid rgba(239, 68, 68, 0.35)",
} as const;

const composerBoxStyle = {
  padding: "8px 10px",
  borderTop: "1px solid rgba(255, 255, 255, 0.09)",
  background: "#1a1f29",
  display: "flex",
  flexDirection: "column",
  gap: 6,
  flexShrink: 0,
} as const;

const refSectionStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 5,
} as const;

const refChipsWrapStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
} as const;

const refChipStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  maxWidth: "100%",
  padding: "2px 6px",
  borderRadius: 5,
  background: "rgba(65, 145, 251, 0.18)",
  border: "1px solid rgba(65, 145, 251, 0.45)",
  color: "#bfdbfe",
  fontSize: 10.5,
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
} as const;

const refChipTextStyle = {
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
} as const;

const refChipCloseStyle = {
  background: "transparent",
  border: "none",
  color: "#93c5fd",
  cursor: "pointer",
  fontSize: 12,
  lineHeight: "12px",
  padding: 0,
} as const;

const textareaStyle = {
  width: "100%",
  boxSizing: "border-box",
  resize: "none",
  borderRadius: 6,
  border: "1px solid rgba(255, 255, 255, 0.14)",
  background: "#0f131a",
  color: "#f8fafc",
  padding: "7px 9px",
  font: "400 12px/17px system-ui, -apple-system, sans-serif",
  outline: "none",
} as const;

const composerFooterStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
} as const;

const composerLeftStyle = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
} as const;

const composerActionsStyle = {
  display: "flex",
  alignItems: "center",
  gap: 4,
} as const;

const pickElementButtonStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "3px 7px",
  borderRadius: 5,
  border: "1px solid rgba(255, 255, 255, 0.12)",
  background: "rgba(255, 255, 255, 0.04)",
  color: "#cbd5e1",
  fontSize: 11,
  cursor: "pointer",
} as const;

const pickElementActiveStyle = {
  ...pickElementButtonStyle,
  border: "1px solid rgba(65, 145, 251, 0.65)",
  background: "rgba(65, 145, 251, 0.22)",
  color: "#bfdbfe",
} as const;

const mutedSmallStyle = {
  color: "#94a3b8",
  fontSize: 11,
} as const;

const targetToggleRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 4,
  flexWrap: "wrap",
} as const;

const targetSelectStyle = {
  maxWidth: 150,
  borderRadius: 5,
  border: "1px solid rgba(255, 255, 255, 0.14)",
  background: "#0f131a",
  color: "#cbd5e1",
  fontSize: 11,
  padding: "3px 6px",
  outline: "none",
} as const;

const hostSetupStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
} as const;

const hostButtonsStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: 4,
} as const;

const hostRowStyle = {
  display: "flex",
  alignItems: "center",
  gap: 6,
} as const;

const pathInputStyle = {
  flex: 1,
  minWidth: 0,
  borderRadius: 5,
  border: "1px solid rgba(255, 255, 255, 0.12)",
  background: "#0f131a",
  color: "#f8fafc",
  padding: "4px 6px",
  fontSize: 11,
  outline: "none",
} as const;
