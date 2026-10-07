import type {
  StatusWatchTarget,
  StatusWatchSnapshot,
  StatusSnoozeInput,
} from "@getpaseo/protocol/workspace-status-snooze";
import { isStatusSnooze, statusWatchKey } from "@getpaseo/protocol/workspace-status-snooze";
import type { WorkspaceSnoozeResult } from "@getpaseo/protocol/workspace-snooze";
import type { GitHubService } from "../../services/github-service.js";
import type { LinearService } from "../../services/linear-service.js";
import type { WorkspaceGitService } from "../workspace-git-service.js";
import type { PersistedWorkspaceRecord } from "../workspace-registry.js";

interface Options {
  github: Pick<GitHubService, "readFixedPullRequestStatus">;
  linear: Pick<LinearService, "getIssues" | "readIssueStates">;
  git: Pick<WorkspaceGitService, "getSnapshot">;
  autoArchiveAfterMerge: () => boolean;
  beforeWake: (workspace: PersistedWorkspaceRecord) => Promise<void>;
}
export interface StatusDiscovery {
  candidates: StatusWatchSnapshot[];
  errors: string[];
  autoArchiveAfterMerge: boolean;
}
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export class WorkspaceStatusSnoozeChecker {
  constructor(private readonly options: Options) {}

  async discover(workspace: PersistedWorkspaceRecord): Promise<StatusDiscovery> {
    const autoArchiveAfterMerge = this.options.autoArchiveAfterMerge();
    if (isStatusSnooze(workspace.snooze)) {
      const saved = workspace.snooze;
      const result = await this.read(workspace.cwd, saved.config.targets);
      const fresh = new Map(result.snapshots.map((s) => [statusWatchKey(s.target), s]));
      return {
        candidates: saved.baseline.map((s) => fresh.get(statusWatchKey(s.target)) ?? s),
        errors: result.errors,
        autoArchiveAfterMerge,
      };
    }
    const snapshot = await this.options.git.getSnapshot(workspace.cwd, {
      reason: "snooze-status-discovery",
      force: true,
    });
    const pr = snapshot.forge.pullRequest;
    if (!pr)
      return {
        candidates: [],
        errors: snapshot.forge.error ? [snapshot.forge.error.message] : [],
        autoArchiveAfterMerge,
      };
    const targets: StatusWatchTarget[] =
      snapshot.forge.forge === "github"
        ? [
            { kind: "github", url: pr.url, field: "state" },
            { kind: "github", url: pr.url, field: "review" },
          ]
        : [];
    const errors: string[] = [];
    try {
      const issues = await this.options.linear.getIssues({
        cwd: workspace.cwd,
        prUrl: pr.url,
        force: true,
      });
      targets.push(...issues.map((issue) => ({ kind: "linear" as const, issueId: issue.id })));
    } catch (error) {
      errors.push(errorText(error));
    }
    const result = await this.read(workspace.cwd, targets);
    return {
      candidates: result.snapshots,
      errors: [...errors, ...result.errors],
      autoArchiveAfterMerge,
    };
  }

  async capture(
    workspace: PersistedWorkspaceRecord,
    config: StatusSnoozeInput,
  ): Promise<StatusWatchSnapshot[]> {
    if (new Set(config.targets.map(statusWatchKey)).size !== config.targets.length)
      throw new Error("Choose each watched status only once");
    const result = await this.read(workspace.cwd, config.targets);
    if (result.errors.length) throw new Error(result.errors.join("; "));
    if (result.snapshots.length !== config.targets.length)
      throw new Error("Choose each watched status only once");
    return result.snapshots;
  }

  async check(
    workspace: PersistedWorkspaceRecord,
    signal: AbortSignal,
  ): Promise<WorkspaceSnoozeResult> {
    if (!isStatusSnooze(workspace.snooze)) throw new Error("Workspace has no status watch");
    const snooze = workspace.snooze;
    const result = await this.read(workspace.cwd, snooze.config.targets, signal);
    signal.throwIfAborted();
    const changes = compareStatusSnapshots(snooze.baseline, result.snapshots);
    if (changes.length) {
      // Archive policy settles before the scheduler's CAS wake; an archived record never wakes.
      if (this.options.autoArchiveAfterMerge()) await this.options.beforeWake(workspace);
      return { status: "unblocked", reason: changes.join("; ").slice(0, 2000) };
    }
    return result.errors.length
      ? { status: "unknown", reason: result.errors.join("; ").slice(0, 2000) }
      : { status: "blocked", reason: "Watched statuses have not changed" };
  }

  private async read(cwd: string, targets: StatusWatchTarget[], signal?: AbortSignal) {
    const snapshots: StatusWatchSnapshot[] = [];
    const errors: string[] = [];
    const githubUrls = [...new Set(targets.filter((t) => t.kind === "github").map((t) => t.url))];
    const linearIds = targets.filter((t) => t.kind === "linear").map((t) => t.issueId);
    await Promise.all([
      ...githubUrls.map(async (url) => {
        try {
          const pr = await this.options.github.readFixedPullRequestStatus({ cwd, url, signal });
          let state = "Open";
          if (pr.isDraft) state = "Draft";
          if (pr.state.toLowerCase() === "closed") state = "Closed";
          if (pr.isMerged || pr.state.toLowerCase() === "merged") state = "Merged";
          const review = pr.reviewDecision ?? "none";
          const reviewLabel = {
            approved: "Approved",
            changes_requested: "Changes requested",
            pending: "Review required",
            none: "No decision",
          }[review];
          for (const target of targets) {
            if (target.kind !== "github" || target.url !== url) continue;
            snapshots.push({
              target,
              label: `PR #${pr.number} · ${target.field === "state" ? "State" : "Review"}`,
              value: target.field === "state" ? state : review,
              valueLabel: target.field === "state" ? state : reviewLabel,
              capturedAt: new Date().toISOString(),
            });
          }
        } catch (error) {
          errors.push(errorText(error));
        }
      }),
      (async () => {
        if (!linearIds.length) return;
        try {
          const issues = await this.options.linear.readIssueStates(cwd, linearIds);
          for (const { id, issue } of issues) {
            if (!issue) {
              errors.push(`Linear issue ${id} is unavailable`);
              continue;
            }
            snapshots.push({
              target: { kind: "linear", issueId: id },
              label: issue.identifier,
              value: issue.state.id,
              valueLabel: issue.state.name,
              capturedAt: new Date().toISOString(),
            });
          }
        } catch (error) {
          errors.push(errorText(error));
        }
      })(),
    ]);
    return { snapshots, errors };
  }
}

export function compareStatusSnapshots(
  baseline: StatusWatchSnapshot[],
  current: StatusWatchSnapshot[],
): string[] {
  const before = new Map(baseline.map((s) => [statusWatchKey(s.target), s]));
  return current.flatMap((s) => {
    const old = before.get(statusWatchKey(s.target));
    return old && old.value !== s.value
      ? [`${old.label}: ${old.valueLabel} → ${s.valueLabel}`]
      : [];
  });
}
