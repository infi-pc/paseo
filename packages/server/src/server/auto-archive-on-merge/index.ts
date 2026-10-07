import { resolve } from "node:path";
import { LRUCache } from "lru-cache";
import type { Logger } from "pino";

import { archiveIfSafe, type AutoArchiveArchiveOptions } from "./archive-if-safe.js";
import type {
  WorkspaceGitRuntimeSnapshot,
  WorkspaceGitSubscription,
} from "../workspace-git-service.js";

export interface AutoArchiveOnMergeOptions extends AutoArchiveArchiveOptions {
  logger: Logger;
}

export interface AutoArchiveOnMergeDependencies {
  archiveIfSafe: typeof archiveIfSafe;
  resolvePath: typeof resolve;
}

const OPEN_PULL_REQUEST_LATCH_MAX = 1_024;

const defaultDependencies: AutoArchiveOnMergeDependencies = {
  archiveIfSafe,
  resolvePath: resolve,
};

export function setupAutoArchiveOnMerge(
  options: AutoArchiveOnMergeOptions,
  deps: AutoArchiveOnMergeDependencies = defaultDependencies,
): WorkspaceGitSubscription & {
  settleForWorkspace: (cwd: string) => Promise<void>;
} {
  const log = options.logger.child({ module: "auto-archive-on-merge" });
  const inFlightCwds = new Map<string, Promise<void>>();
  const openPullRequestUrlsByCwd = new LRUCache<string, string>({
    max: OPEN_PULL_REQUEST_LATCH_MAX,
  });

  const subscription = options.workspaceGitService.onSnapshotUpdated((snapshot) => {
    const snapshotCwd = deps.resolvePath(snapshot.cwd);
    if (options.daemonConfigStore.get().autoArchiveAfterMerge !== true) {
      openPullRequestUrlsByCwd.delete(snapshotCwd);
      return;
    }

    const pullRequest = snapshot.forge.pullRequest;
    if (!pullRequest?.isMerged) {
      if (pullRequest?.state.toLowerCase() === "open") {
        openPullRequestUrlsByCwd.set(snapshotCwd, pullRequest.url);
      } else {
        openPullRequestUrlsByCwd.delete(snapshotCwd);
      }
      return;
    }
    if (openPullRequestUrlsByCwd.get(snapshotCwd) !== pullRequest.url) {
      openPullRequestUrlsByCwd.delete(snapshotCwd);
      return;
    }
    if (inFlightCwds.has(snapshotCwd)) {
      return;
    }
    const task = Promise.resolve()
      .then(async () => {
        let freshSnapshot: WorkspaceGitRuntimeSnapshot | null;
        try {
          freshSnapshot = await options.workspaceGitService.getSnapshot(snapshot.cwd, {
            reason: "auto-archive-on-merge",
          });
        } catch (error) {
          log.warn(
            { err: error, cwd: snapshot.cwd },
            "Failed to read snapshot for auto-archive; skipping",
          );
          return;
        }
        const freshPullRequest = freshSnapshot?.forge.pullRequest;
        if (
          !freshPullRequest?.isMerged ||
          freshPullRequest.url !== pullRequest.url ||
          openPullRequestUrlsByCwd.get(snapshotCwd) !== pullRequest.url
        ) {
          if (openPullRequestUrlsByCwd.get(snapshotCwd) === pullRequest.url) {
            openPullRequestUrlsByCwd.delete(snapshotCwd);
          }
          return;
        }

        const attachedWorkspaces = (await options.listActiveWorkspaces()).filter(
          (workspace) => deps.resolvePath(workspace.cwd) === snapshotCwd,
        );
        for (const workspace of attachedWorkspaces) {
          await deps.archiveIfSafe({
            workspaceId: workspace.workspaceId,
            snapshot: freshSnapshot,
            options,
            log,
          });
        }
        return;
      })
      .catch((error) => {
        log.warn({ err: error, cwd: snapshot.cwd }, "Failed to auto-archive attached workspaces");
      })
      .finally(() => {
        inFlightCwds.delete(snapshotCwd);
      });
    inFlightCwds.set(snapshotCwd, task);
  });
  return {
    ...subscription,
    // FORK(workspace-snooze): let the existing merge policy settle before a status wake.
    // Refreshing may start a fan-out; join the whole operation, including its initial reads.
    settleForWorkspace: async (cwd) => {
      if (options.daemonConfigStore.get().autoArchiveAfterMerge !== true) return;
      await options.workspaceGitService.getSnapshot(cwd, {
        reason: "snooze-wake-archive",
        force: true,
      });
      await inFlightCwds.get(deps.resolvePath(cwd));
    },
  };
}
