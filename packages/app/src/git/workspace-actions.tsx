import { WorkspaceLinearButton } from "@/linear/workspace-button";
import { useCallback, useMemo, type ReactNode } from "react";
import { ActivityIndicator } from "react-native";
import { FileDiff } from "lucide-react-native";
import { withUnistyles } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import type { TerminalProfile } from "@getpaseo/protocol/messages";
import { HeaderToggleButton } from "@/components/headers/header-toggle-button";
import {
  extraMutedIconColorMapping,
  iconButtonChromeGlyphSize,
} from "@/components/ui/icon-button-chrome";
import { GitActionsSplitButton } from "@/git/actions-split-button";
import { GIT_ACTION_ICONS } from "@/git/action-icons";
import { useGitActions } from "@/git/use-actions";
import { WorkspacePullRequestButton } from "@/git/workspace-pull-request-button";

interface WorkspaceActionsProps {
  serverId: string;
  cwd: string;
  onCreateTerminalWithProfile: (profile: TerminalProfile) => void;
  terminalPending: boolean;
  children?: ReactNode;
}

const CodiffIcon = withUnistyles(FileDiff);

export function WorkspaceActions({
  serverId,
  cwd,
  onCreateTerminalWithProfile,
  terminalPending,
  children,
}: WorkspaceActionsProps) {
  const { t } = useTranslation();
  const { gitActions, pullRequestAction, pullRequest, hasPullRequest } = useGitActions({
    serverId,
    cwd,
    icons: GIT_ACTION_ICONS,
  });
  const openCodiff = useCallback(() => {
    if (!pullRequest) return;
    onCreateTerminalWithProfile({
      id: "codiff",
      name: "Codiff",
      command: "codiff",
      args: ["pr", String(pullRequest.number)],
    });
  }, [onCreateTerminalWithProfile, pullRequest]);

  // FORK(pr-toolbar): the dedicated PR button owns viewing and creating pull requests.
  const toolbarActions = useMemo(
    () => ({
      primary: gitActions.primary?.id === "pr" ? null : gitActions.primary,
      secondary: gitActions.secondary.filter((action) => action.id !== "pr"),
      menu: gitActions.menu.filter((action) => action.id !== "pr"),
    }),
    [gitActions],
  );

  return (
    <>
      {pullRequestAction ? (
        <WorkspacePullRequestButton
          action={pullRequestAction}
          hasPullRequest={hasPullRequest}
          pullRequest={pullRequest}
        />
      ) : null}
      {/* FORK(linear-toolbar): Linear follows the checkout's current PR. */}
      <WorkspaceLinearButton serverId={serverId} cwd={cwd} prUrl={pullRequest?.url ?? null} />
      {/* FORK(codiff-toolbar): launch the discovered PR in Codiff on the workspace host. */}
      {pullRequest ? (
        <HeaderToggleButton
          testID="workspace-codiff-button"
          accessibilityRole="button"
          accessibilityLabel={t("workspace.codiff.open", { number: pullRequest.number })}
          tooltipLabel={t("workspace.codiff.open", { number: pullRequest.number })}
          tooltipKeys={[]}
          tooltipSide="bottom"
          disabled={terminalPending}
          onPress={openCodiff}
        >
          {terminalPending ? (
            <ActivityIndicator size="small" />
          ) : (
            <CodiffIcon
              size={iconButtonChromeGlyphSize("large")}
              uniProps={extraMutedIconColorMapping}
            />
          )}
        </HeaderToggleButton>
      ) : null}
      {children}
      <GitActionsSplitButton gitActions={toolbarActions} menuOnly={!toolbarActions.primary} />
    </>
  );
}
