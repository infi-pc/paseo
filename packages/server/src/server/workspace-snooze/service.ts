import {
  StatusSnoozeInputSchema,
  type StatusSnoozeInput,
  type StatusSnooze,
} from "@getpaseo/protocol/workspace-status-snooze";
import type { WorkspaceStatusSnoozeChecker } from "./status.js";
import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import {
  WorkspaceSnoozeInputSchema,
  type WorkspaceSnoozeInput,
  type WorkspaceSnoozeResult,
} from "@getpaseo/protocol/workspace-snooze";
import type { WorkspaceRegistry, PersistedWorkspaceRecord } from "../workspace-registry.js";

interface Options {
  registry: WorkspaceRegistry;
  statusChecker?: Pick<WorkspaceStatusSnoozeChecker, "discover" | "capture" | "check">;
  logger: Logger;
  check: (
    workspace: PersistedWorkspaceRecord,
    signal: AbortSignal,
  ) => Promise<WorkspaceSnoozeResult>;
  wake: (workspace: PersistedWorkspaceRecord, reason: string, snoozeId: string) => Promise<void>;
  now?: () => number;
}

/** The registry is authoritative; helper sessions and timers are disposable. */
export class WorkspaceSnoozeService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | undefined;
  private active: {
    workspaceId: string;
    snoozeId: string;
    controller: AbortController;
    task: Promise<void>;
  } | null = null;
  private readonly statusChecks = new Map<
    string,
    { controller: AbortController; task: Promise<void>; snoozeId: string }
  >();
  private stopped = false;
  private readonly now: () => number;

  constructor(private readonly options: Options) {
    this.now = options.now ?? Date.now;
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.unsubscribe = this.options.registry.subscribeToMutations?.((mutation) => {
      const checks = [
        this.active?.workspaceId === mutation.workspaceId ? this.active : null,
        this.statusChecks.get(mutation.workspaceId),
      ];
      for (const active of checks) {
        if (
          active &&
          (mutation.workspace?.archivedAt || mutation.workspace?.snooze?.id !== active.snoozeId)
        )
          active.controller.abort();
      }
    });
    this.timer = setInterval(() => this.runInBackground(), 10_000);
    this.timer.unref();
    this.runInBackground();
  }

  private runInBackground(): void {
    if (!this.timer) return;
    void this.runDue().catch((error: unknown) =>
      this.options.logger.error({ err: error }, "Workspace snooze scheduler failed"),
    );
  }

  async set(workspaceId: string, input: WorkspaceSnoozeInput | null): Promise<void> {
    const config = input === null ? null : WorkspaceSnoozeInputSchema.parse(input);
    const now = this.now();
    if (config?.mode === "time" && Date.parse(config.wakeAt) <= now)
      throw new Error("Choose a future date and time");
    if (config?.mode === "ai" && !config.prompt.trim())
      throw new Error("Enter an unsnooze condition");
    const stamp = new Date(now).toISOString();
    const snooze = config
      ? {
          id: randomUUID(),
          createdAt: stamp,
          config,
          nextCheckAt: config.mode === "time" ? config.wakeAt : stamp,
          lastCheck: null,
        }
      : null;
    const updated = await this.options.registry.update(workspaceId, (workspace) => {
      if (workspace.archivedAt) throw new Error("Archived workspaces cannot be snoozed");
      return { ...workspace, snooze, updatedAt: stamp };
    });
    if (!updated) throw new Error("Workspace not found");
    if (this.active?.workspaceId === workspaceId) this.active.controller.abort();
    this.runInBackground();
  }

  async discoverStatus(workspaceId: string) {
    const workspace = await this.options.registry.get(workspaceId);
    if (!workspace || workspace.archivedAt) throw new Error("Workspace is unavailable");
    if (!this.options.statusChecker) throw new Error("Status snoozing unavailable");
    return this.options.statusChecker.discover(workspace);
  }

  async setStatus(workspaceId: string, input: StatusSnoozeInput): Promise<void> {
    const config = StatusSnoozeInputSchema.parse(input);
    const workspace = await this.options.registry.get(workspaceId);
    if (!workspace || workspace.archivedAt) throw new Error("Workspace is unavailable");
    if (!this.options.statusChecker) throw new Error("Status snoozing unavailable");
    const baseline = await this.options.statusChecker.capture(workspace, config);
    const stamp = new Date(this.now()).toISOString();
    const snooze: StatusSnooze = {
      id: randomUUID(),
      createdAt: stamp,
      config,
      baseline,
      lastCheck: null,
      nextCheckAt: new Date(this.now() + config.intervalMinutes * 60_000).toISOString(),
    };
    const updated = await this.options.registry.update(workspaceId, (current) => {
      if (
        current.archivedAt ||
        current.cwd !== workspace.cwd ||
        current.snooze?.id !== workspace.snooze?.id
      )
        throw new Error("Workspace changed while capturing statuses; try again");
      return { ...current, snooze, updatedAt: stamp };
    });
    if (!updated) throw new Error("Workspace not found");
    this.runInBackground();
  }

  async checkNow(workspaceId: string): Promise<void> {
    if (this.active?.workspaceId === workspaceId || this.statusChecks.has(workspaceId))
      throw new Error("A check is already running");
    const stamp = new Date(this.now()).toISOString();
    const updated = await this.options.registry.update(workspaceId, (workspace) => {
      if (workspace.archivedAt || !workspace.snooze || workspace.snooze.config.mode === "time")
        throw new Error("Workspace has no recurring snooze");
      return {
        ...workspace,
        snooze: { ...workspace.snooze, nextCheckAt: stamp },
        updatedAt: stamp,
      };
    });
    if (!updated) throw new Error("Workspace not found");
    this.runInBackground();
  }

  async runDue(): Promise<void> {
    if (this.stopped) return;
    const workspaces = await this.options.registry.list();
    const due = workspaces.filter(
      (workspace) =>
        !workspace.archivedAt &&
        workspace.snooze &&
        Date.parse(workspace.snooze.nextCheckAt) <= this.now(),
    );
    due.sort((a, b) => Date.parse(a.snooze!.nextCheckAt) - Date.parse(b.snooze!.nextCheckAt));
    for (const workspace of due) {
      if (this.stopped) return;
      if (workspace.snooze?.config.mode === "time")
        await this.finish(workspace, { status: "unblocked", reason: "Snooze time reached" });
    }
    const statusTasks: Promise<void>[] = [];
    for (const workspace of due) {
      if (this.stopped) return;
      if (
        workspace.snooze?.config.mode !== "status" ||
        this.statusChecks.has(workspace.workspaceId) ||
        this.statusChecks.size >= 4
      )
        continue;
      const controller = new AbortController();
      const active = { controller, snoozeId: workspace.snooze.id, task: Promise.resolve() };
      this.statusChecks.set(workspace.workspaceId, active);
      active.task = this.check(workspace, controller).finally(() =>
        this.statusChecks.delete(workspace.workspaceId),
      );
      statusTasks.push(active.task);
    }
    await Promise.all([...statusTasks, this.runDueAI(due)]);
  }

  private async runDueAI(due: PersistedWorkspaceRecord[]): Promise<void> {
    if (this.active || this.stopped) return;
    const candidate = due.find((entry) => entry.snooze?.config.mode === "ai");
    if (!candidate) return;
    const workspace = await this.options.registry.get(candidate.workspaceId);
    if (this.active || this.stopped || !workspace?.snooze || workspace.archivedAt) return;
    if (
      workspace.snooze.config.mode !== "ai" ||
      Date.parse(workspace.snooze.nextCheckAt) > this.now()
    )
      return;
    const controller = new AbortController();
    const active = {
      workspaceId: workspace.workspaceId,
      snoozeId: workspace.snooze.id,
      controller,
      task: Promise.resolve(),
    };
    this.active = active;
    active.task = this.check(workspace, controller).finally(() => {
      if (this.active === active) this.active = null;
    });
    await active.task;
  }

  private async check(
    workspace: PersistedWorkspaceRecord,
    controller: AbortController,
  ): Promise<void> {
    const timeout = setTimeout(
      () => controller.abort(new Error("Snooze check timed out")),
      180_000,
    );
    timeout.unref();
    try {
      let result: WorkspaceSnoozeResult;
      try {
        if (workspace.snooze?.config.mode === "status") {
          if (!this.options.statusChecker) throw new Error("Status checker unavailable");
          result = await this.options.statusChecker.check(workspace, controller.signal);
        } else result = await this.options.check(workspace, controller.signal);
      } catch (error) {
        result = {
          status: "unknown",
          reason: error instanceof Error ? error.message : String(error),
        };
      }
      if (this.stopped) return;
      if (controller.signal.aborted)
        result = { status: "unknown", reason: "Check interrupted or timed out" };
      await this.finish(workspace, result);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async finish(
    workspace: PersistedWorkspaceRecord,
    result: WorkspaceSnoozeResult,
  ): Promise<void> {
    const expected = workspace.snooze;
    if (!expected) return;
    let woke = false;
    const stamp = new Date(this.now()).toISOString();
    const updated = await this.options.registry.update(workspace.workspaceId, (current) => {
      if (current.archivedAt || current.snooze?.id !== expected.id) return current;
      if (result.status === "unblocked") {
        woke = true;
        return { ...current, snooze: null, updatedAt: stamp };
      }
      const delay =
        expected.config.mode === "status"
          ? expected.config.intervalMinutes * 60_000
          : (expected.config.mode === "ai" ? expected.config.intervalHours : 1) * 3_600_000;
      return {
        ...current,
        updatedAt: stamp,
        snooze: {
          ...current.snooze,
          nextCheckAt: new Date(this.now() + delay).toISOString(),
          lastCheck: { ...result, reason: result.reason.slice(0, 2000), checkedAt: stamp },
        },
      };
    });
    if (woke && updated) await this.options.wake(updated, result.reason, expected.id);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.active?.controller.abort();
    for (const check of this.statusChecks.values()) check.controller.abort();
    await Promise.all([
      this.active?.task,
      ...[...this.statusChecks.values()].map((check) => check.task),
    ]);
  }
}
