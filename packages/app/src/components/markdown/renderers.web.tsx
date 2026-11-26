import { canonicalGitHubPullRequestUrl } from "@getpaseo/protocol/git-remote";
import { ForgeSearchItemSchema } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { GitPullRequestDraft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text } from "react-native";
import { forwardRef, useCallback, useMemo, useState, type ComponentProps } from "react";
import type {
  CodeBlockRendererProps,
  LinkRendererProps,
  MarkdownRenderers,
} from "react-native-enriched-markdown";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useAssistantFileLinkEnvironment, useFileLink } from "@/assistant-file-links";
import { MARKDOWN_COPY_RECOGNIZED_LINK_ATTRIBUTE } from "@/assistant-selection-copy/markup";
import { PullRequestStateIcon } from "@/git/pull-request-state-icon";
import { mapCheckStatus } from "@/git/pull-request-panel/check-status";
import { useHostFeature } from "@/runtime/host-features";
import { useForgeShorthand } from "@/git/forge-shorthand";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { Theme } from "@/styles/theme";
import { MermaidFence } from "./fence/mermaid";
import { isRecognizedLink, markdownLinkSource } from "./source";

const ThemedCodeBlock = withUnistyles(HighlightedCodeBlock);
const codeStyle = (theme: Theme) => ({
  inheritedStyles: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.code,
  },
  textStyle: { backgroundColor: theme.colors.surface2, padding: 12, borderRadius: 8 },
});
function WebCodeBlock({ code, language }: CodeBlockRendererProps) {
  if (language?.toLowerCase() === "mermaid") return <MermaidFence code={code} />;
  return <ThemedCodeBlock code={code} language={language} uniProps={codeStyle} />;
}

// The library styles links inline, so a stylesheet :hover rule cannot underline them.
const LINK_HOVER_STYLE = { textDecoration: "underline" } as const;
const INLINE_STATUS_STYLE = {
  display: "inline-flex",
  width: 13,
  marginInlineEnd: 4,
  verticalAlign: "text-bottom",
} as const;

function WebLink({ link, anchorProps, children }: LinkRendererProps) {
  const forgeShorthand = useForgeShorthand();
  // A forge reference like `#12` carries its web URL so hover, copy and new-tab opens work.
  const forgeUrl = link.sourceType === "text" ? forgeShorthand?.resolve(link.url) : null;
  const { target, tooltipPath, onHoverIn } = useFileLink(
    forgeUrl ? markdownLinkSource(forgeUrl) : markdownLinkSource(link.url, link.sourceType),
  );
  const destination = forgeUrl ?? link.url;
  const tooltip = tooltipPath ?? (/^https?:\/\//i.test(destination) ? destination : null);
  const absolutePath =
    target && tooltipPath && !tooltipPath.startsWith(target.path) ? target.path : null;
  const [previewOpen, setPreviewOpen] = useState(false);
  const environment = useAssistantFileLinkEnvironment();
  const prUrl = environment.enablePullRequestLinkPreviews
    ? canonicalGitHubPullRequestUrl(destination)
    : null;
  const preview = usePullRequestPreview(prUrl, previewOpen, environment);
  const [hovered, setHovered] = useState(false);
  const handleMouseEnter = useCallback(() => setHovered(true), []);
  const handleMouseLeave = useCallback(() => setHovered(false), []);
  const anchorStyle = useMemo(
    () => ({
      ...anchorProps.style,
      overflowWrap: "anywhere" as const,
      ...(hovered ? LINK_HOVER_STYLE : null),
    }),
    [anchorProps.style, hovered],
  );
  // Selection copy pastes a link Paseo recognized as the text the reply showed.
  const recognized = isRecognizedLink(link);
  const copyAnchorProps = useMemo(
    () =>
      recognized
        ? { ...anchorProps, [MARKDOWN_COPY_RECOGNIZED_LINK_ATTRIBUTE]: "true" }
        : anchorProps,
    [anchorProps, recognized],
  );
  const anchor = (
    <a
      {...copyAnchorProps}
      href={forgeUrl ?? anchorProps.href}
      style={anchorStyle}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {prUrl ? <InlinePullRequestStatus {...preview} /> : null}
      {children}
    </a>
  );
  return (
    <Tooltip delayDuration={400} onOpenChange={setPreviewOpen}>
      <TooltipTrigger asChild onHoverIn={onHoverIn} onFocus={onHoverIn}>
        <InlineLinkTrigger>{anchor}</InlineLinkTrigger>
      </TooltipTrigger>
      {tooltip ? (
        <TooltipContent side="top" align="start" maxWidth={520}>
          <Text selectable={false} style={styles.tooltipPath}>
            {tooltip}
            {absolutePath ? `\n${absolutePath}` : ""}
          </Text>
          {prUrl ? <PullRequestDetails {...preview} /> : null}
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}
function usePullRequestPreview(
  prUrl: string | null,
  open: boolean,
  { client, serverId, workspaceRoot }: ReturnType<typeof useAssistantFileLinkEnvironment>,
) {
  const supported = useHostFeature(prUrl ? serverId : undefined, "githubPullRequestLinkPreview");
  const query = useFetchQuery({
    queryKey: ["github-pull-request-link-preview", serverId, prUrl],
    enabled: Boolean(open && supported && client?.searchForge && workspaceRoot && prUrl),
    queryFn: async () => {
      if (!client?.searchForge || !workspaceRoot || !prUrl) return null;
      const result = await client.searchForge({
        cwd: workspaceRoot,
        query: prUrl,
        kinds: ["change_request"],
        limit: 1,
      });
      for (const item of result.items) {
        const parsed = ForgeSearchItemSchema.safeParse(item);
        if (!parsed.success) continue;
        const pr = parsed.data;
        if (pr.kind === "change_request" && canonicalGitHubPullRequestUrl(pr.url) === prUrl) {
          return pr;
        }
      }
      return null;
    },
    dataShape: "value",
    staleTimeMs: 30_000,
    retry: false,
    refetchInterval: 60_000,
  });
  const pr = prUrl && supported ? query.data : null;
  const state = pr?.state.toLowerCase();
  const iconState: ComponentProps<typeof PullRequestStateIcon>["state"] | null =
    state === "open" || state === "closed" || state === "merged" ? state : null;
  return { pr, iconState, isDraft: iconState === "open" && pr?.isDraft, query, supported };
}

type PullRequestPreview = ReturnType<typeof usePullRequestPreview>;

function InlinePullRequestStatus({ iconState, isDraft }: PullRequestPreview) {
  const { t } = useTranslation();
  let icon = null;
  if (isDraft) icon = <GitPullRequestDraft size={13} />;
  else if (iconState) icon = <PullRequestStateIcon state={iconState} size={13} />;
  return (
    <span
      aria-label={
        iconState ? t(`workspace.git.pr.states.${isDraft ? "draft" : iconState}`) : undefined
      }
      role={iconState ? "img" : undefined}
      style={INLINE_STATUS_STYLE}
    >
      {icon}
    </span>
  );
}

function PullRequestDetails({ pr, iconState, isDraft, query, supported }: PullRequestPreview) {
  const { t } = useTranslation();
  let title = pr?.title || t("common.linkPreview.unavailable");
  if (!supported) title = t("common.linkPreview.unsupportedHost");
  else if (!pr && query.isFetching) title = t("common.loading");
  const decision = pr?.reviewDecision ?? "";
  const reviewKey = Object.hasOwn(REVIEW_LABELS, decision) ? REVIEW_LABELS[decision] : undefined;
  const stateLabel = iconState
    ? t(`workspace.git.pr.states.${isDraft ? "draft" : iconState}`)
    : null;
  const status = [stateLabel, reviewKey ? t(reviewKey) : null].filter(Boolean).join(" · ");
  const checks = pr?.checks?.slice(0, 5).map((check) =>
    t("common.linkPreview.check", {
      name: check.name,
      status: t(
        `workspace.git.pr.accessibility.checkStatus.${CHECK_LABELS[mapCheckStatus(check.status)]}`,
      ),
    }),
  );
  return (
    <Text selectable={false} style={styles.tooltipPath}>
      {[title, status, ...(checks ?? [])].filter(Boolean).join("\n")}
    </Text>
  );
}

const REVIEW_LABELS: Partial<
  Record<
    string,
    | "common.linkPreview.approved"
    | "common.linkPreview.changesRequested"
    | "common.linkPreview.reviewRequired"
  >
> = {
  APPROVED: "common.linkPreview.approved",
  CHANGES_REQUESTED: "common.linkPreview.changesRequested",
  REVIEW_REQUIRED: "common.linkPreview.reviewRequired",
};

// TooltipTrigger also supplies native Pressable handlers; forward only DOM events.
// A View renders a div, which is invalid inside the library's prose paragraphs.
const InlineLinkTrigger = forwardRef<HTMLSpanElement, ComponentProps<"span">>(
  function InlineLinkTrigger({ children, onMouseEnter, onMouseLeave, onFocus, onBlur }, ref) {
    return (
      <span
        ref={ref}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onFocus={onFocus}
        onBlur={onBlur}
      >
        {children}
      </span>
    );
  },
);
const CHECK_LABELS = {
  success: "passed",
  failure: "failed",
  pending: "pending",
  skipped: "skipped",
  cancelled: "cancelled",
} as const;

const styles = StyleSheet.create((theme) => ({
  tooltipPath: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));

export const WEB_RENDERERS: MarkdownRenderers = { codeBlock: WebCodeBlock, link: WebLink };
