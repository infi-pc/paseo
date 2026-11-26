import { canonicalGitHubPullRequestUrl } from "@getpaseo/protocol/git-remote";
import { ForgeSearchItemSchema, type ForgeSearchItem } from "@getpaseo/protocol/messages";
import { useFetchQuery } from "@/data/query";
import { CircleDashed, CircleAlert, GitPullRequestDraft } from "lucide-react-native";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { forwardRef, useCallback, useEffect, useMemo, useState, type ComponentProps } from "react";
import type {
  CodeBlockRendererProps,
  LinkRendererProps,
  MarkdownRenderers,
} from "react-native-enriched-markdown";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { useAssistantFileLinkEnvironment, useFileLink } from "@/assistant-file-links";
import { MARKDOWN_COPY_RECOGNIZED_LINK_ATTRIBUTE } from "@/assistant-selection-copy/markup";
import { PullRequestStateIcon } from "@/git/pull-request-state-icon";
import { classifyCheck, countCheckPresentations } from "@/git/check-presentation";
import { CheckPresentationIcon } from "@/git/check-presentation.view";
import { mapCheckStatus } from "@/git/pull-request-panel/check-status";
import { useHostFeature } from "@/runtime/host-features";
import { useForgeShorthand } from "@/git/forge-shorthand";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { Tooltip, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import type { Theme } from "@/styles/theme";
import { MermaidFence } from "./fence/mermaid";
import { observePrLink } from "./pr-link-visibility.web";
import { readCachedPrPreview, writeCachedPrPreview } from "./pr-preview-cache.web";
import { isRecognizedLink, markdownLinkSource } from "./source";

const ThemedCircleDashed = withUnistyles(CircleDashed);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const mutedIcon = (theme: Theme) => ({ color: theme.colors.foregroundMuted });

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
  height: 13,
  marginInlineEnd: 4,
  verticalAlign: "middle",
} as const;

const PR_LINK_STYLE = { whiteSpace: "nowrap", overflowWrap: "normal" } as const;
const WRAPPING_LINK_STYLE = { overflowWrap: "anywhere" } as const;

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
  const [anchorNode, setAnchorNode] = useState<HTMLAnchorElement | null>(null);
  const [visible, setVisible] = useState(false);
  const panelActive = useRetainedPanelActive();
  useEffect(() => {
    if (prUrl && anchorNode) return observePrLink(anchorNode, setVisible);
  }, [anchorNode, prUrl]);
  const preview = usePullRequestPreview(
    prUrl,
    panelActive && (visible || previewOpen),
    environment,
  );
  const originalRef = anchorProps.ref;
  const trackAnchor = useCallback(
    (node: HTMLAnchorElement | null) => {
      setAnchorNode(node);
      if (typeof originalRef === "function") return originalRef(node);
      if (originalRef) originalRef.current = node;
    },
    [originalRef],
  );
  const [hovered, setHovered] = useState(false);
  const handleMouseEnter = useCallback(() => setHovered(true), []);
  const handleMouseLeave = useCallback(() => setHovered(false), []);
  const anchorStyle = useMemo(
    () => ({
      ...anchorProps.style,
      ...(prUrl ? PR_LINK_STYLE : WRAPPING_LINK_STYLE),
      ...(hovered ? LINK_HOVER_STYLE : null),
    }),
    [anchorProps.style, hovered, prUrl],
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
      ref={prUrl ? trackAnchor : originalRef}
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
      {prUrl ? (
        <TooltipContent side="top" align="start" maxWidth={380} style={styles.prSurface}>
          <PullRequestDetails {...preview} url={prUrl} />
        </TooltipContent>
      ) : null}
      {!prUrl && tooltip ? (
        <TooltipContent side="top" align="start" maxWidth={520}>
          <Text selectable={false} style={styles.tooltipPath}>
            {tooltip}
            {absolutePath ? `\n${absolutePath}` : ""}
          </Text>
        </TooltipContent>
      ) : null}
    </Tooltip>
  );
}
function usePullRequestPreview(
  prUrl: string | null,
  active: boolean,
  { client, serverId, workspaceRoot }: ReturnType<typeof useAssistantFileLinkEnvironment>,
) {
  const supported = useHostFeature(prUrl ? serverId : undefined, "githubPullRequestLinkPreview");
  const cacheKey = serverId && prUrl ? JSON.stringify([serverId, prUrl]) : null;
  const cached = useMemo(
    () => (supported && cacheKey ? readCachedPrPreview(cacheKey) : undefined),
    [supported, cacheKey],
  );
  const enabled = Boolean(active && supported && client?.searchForge && workspaceRoot && prUrl);
  const query = useFetchQuery({
    queryKey: ["github-pull-request-link-preview", serverId, prUrl],
    enabled,
    initialData: cached?.data,
    initialDataUpdatedAt: cached?.updatedAt,
    refetchOnMount: true,
    refetchOnReconnect: true,
    refetchOnWindowFocus: true,
    queryFn: () => fetchPullRequestPreview(client, workspaceRoot, prUrl, cacheKey),
    dataShape: "value",
    staleTimeMs: 30_000,
    retry: false,
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
  });
  const pr = supported ? (query.data ?? cached?.data) : undefined;
  const iconState = parsePrState(pr?.state);
  const checkStatus = useMemo(() => summarizeCheckStatus(pr?.checks), [pr?.checks]);
  return {
    pr,
    checkStatus,
    iconState,
    isDraft: iconState === "open" && pr?.isDraft,
    query,
    supported,
    loading: query.isLoading,
  };
}

function parsePrState(
  value: string | undefined,
): ComponentProps<typeof PullRequestStateIcon>["state"] | null {
  const state = value?.toLowerCase();
  return state === "open" || state === "closed" || state === "merged" ? state : null;
}

async function fetchPullRequestPreview(
  client: ReturnType<typeof useAssistantFileLinkEnvironment>["client"],
  cwd: string | undefined,
  prUrl: string | null,
  cacheKey: string | null,
) {
  if (!client?.searchForge || !cwd || !prUrl) throw new Error("PR lookup unavailable");
  const result = await client.searchForge({
    cwd,
    query: prUrl,
    kinds: ["change_request"],
    limit: 1,
  });
  if (result.error || result.authState !== "authenticated") throw new Error("PR lookup failed");
  for (const item of result.items) {
    const parsed = ForgeSearchItemSchema.safeParse(item);
    if (!parsed.success) continue;
    const pr = parsed.data;
    if (pr.kind === "change_request" && canonicalGitHubPullRequestUrl(pr.url) === prUrl) {
      if (cacheKey) writeCachedPrPreview(cacheKey, pr);
      return pr;
    }
  }
  throw new Error("PR lookup returned no matching pull request");
}

type PullRequestPreview = ReturnType<typeof usePullRequestPreview>;

function InlinePullRequestStatus({
  iconState,
  isDraft,
  checkStatus,
  loading,
  pr,
}: PullRequestPreview) {
  const { t } = useTranslation();
  const placeholder = loading ? (
    <ThemedCircleDashed size={13} uniProps={mutedIcon} />
  ) : (
    <ThemedCircleAlert size={13} uniProps={mutedIcon} />
  );
  let icon = placeholder;
  if (isDraft) icon = <GitPullRequestDraft size={13} />;
  else if (iconState) icon = <PullRequestStateIcon state={iconState} size={13} />;
  const prLabel = loading ? t("common.linkPreview.loadingPr") : t("common.linkPreview.unavailable");
  let ciLabel = t("common.linkPreview.unknownCi");
  if (loading) ciLabel = t("common.linkPreview.loadingCi");
  else if (pr?.checks?.length === 0) ciLabel = t("workspace.git.pr.checksOverview.headline.none");
  return (
    <>
      <span
        aria-label={
          iconState ? t(`workspace.git.pr.states.${isDraft ? "draft" : iconState}`) : prLabel
        }
        role="img"
        style={INLINE_STATUS_STYLE}
      >
        {icon}
      </span>
      <span
        aria-label={checkStatus ? t(`common.linkPreview.ci.${checkStatus}`) : ciLabel}
        role="img"
        style={INLINE_STATUS_STYLE}
      >
        {checkStatus ? <CheckPresentationIcon presentation={checkStatus} size={13} /> : placeholder}
      </span>
    </>
  );
}

function summarizeCheckStatus(
  checks: ForgeSearchItem["checks"],
): "failure" | "pending" | "success" | "ignored" | null {
  if (!checks?.length) return null;
  const counts = countCheckPresentations(checks);
  if (counts.failure) return "failure";
  if (counts.pending) return "pending";
  if (counts.success) return "success";
  return "ignored";
}

function PullRequestDetails({
  pr,
  iconState,
  isDraft,
  query,
  supported,
  checkStatus,
  url,
}: PullRequestPreview & { url: string }) {
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
  const [, owner, repo, , number] = new URL(url).pathname.split("/");
  return (
    <View style={styles.prDetails}>
      <Text style={styles.secondary} numberOfLines={1}>{`${owner}/${repo} #${number}`}</Text>
      <Text style={styles.prTitle} numberOfLines={3}>
        {title}
      </Text>
      {status ? <Text style={styles.secondary}>{status}</Text> : null}
      {checkStatus && pr?.checks ? (
        <PullRequestChecks checks={pr.checks} status={checkStatus} />
      ) : null}
    </View>
  );
}

function PullRequestChecks({
  checks,
  status,
}: {
  checks: NonNullable<ForgeSearchItem["checks"]>;
  status: NonNullable<PullRequestPreview["checkStatus"]>;
}) {
  const { t } = useTranslation();
  const order = {
    failure: 0,
    pending: 1,
    success: 2,
    ignored: 3,
    manual: 1,
    warning: 0,
    actionRequired: 0,
  };
  const visibleChecks = [...checks]
    .sort((a, b) => order[classifyCheck(a)] - order[classifyCheck(b)])
    .slice(0, 5);
  return (
    <View style={styles.checks}>
      <View style={styles.checkRow}>
        <CheckPresentationIcon presentation={status} size={14} />
        <Text style={styles.prTitle}>{t(`common.linkPreview.ci.${status}`)}</Text>
      </View>
      {visibleChecks.map((check) => (
        <View key={`${check.workflow}:${check.name}:${check.url}`} style={styles.checkRow}>
          <CheckPresentationIcon presentation={classifyCheck(check)} size={12} />
          <Text style={styles.secondary} numberOfLines={1}>
            {t("common.linkPreview.check", {
              name: check.name,
              status: t(
                `workspace.git.pr.accessibility.checkStatus.${CHECK_LABELS[mapCheckStatus(check.status)]}`,
              ),
            })}
          </Text>
        </View>
      ))}
      {checks.length > visibleChecks.length ? (
        <Text style={styles.secondary}>
          {t("common.linkPreview.moreChecks", { count: checks.length - visibleChecks.length })}
        </Text>
      ) : null}
    </View>
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
  prSurface: {
    backgroundColor: theme.colors.surface2,
    padding: theme.spacing[3],
    borderRadius: theme.borderRadius.lg,
  },
  prDetails: { gap: theme.spacing[1] },
  prTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.semibold,
  },
  secondary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  checks: {
    borderTopWidth: theme.borderWidth[1],
    borderTopColor: theme.colors.border,
    marginTop: theme.spacing[1],
    paddingTop: theme.spacing[2],
    gap: theme.spacing[1],
  },
  checkRow: { flexDirection: "row", alignItems: "center", gap: theme.spacing[2] },
  tooltipPath: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.normal,
  },
}));

export const WEB_RENDERERS: MarkdownRenderers = { codeBlock: WebCodeBlock, link: WebLink };
