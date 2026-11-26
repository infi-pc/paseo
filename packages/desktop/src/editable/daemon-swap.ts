import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  readDaemonInstance,
  resolvePaseoHome,
  type DaemonInstance,
} from "@getpaseo/server/daemon-control";
import {
  startDesktopDaemon,
  stopDesktopDaemon,
  type DesktopDaemonStatus,
} from "../daemon/daemon-manager.js";
import type { EditableDaemonLaunchOverride } from "../daemon/runtime-paths.js";
import { isDevInstance } from "./dev-profile.js";
import type { DaemonRelease, EditableReleaseStore } from "./release-store.js";

const RUNNING_STATE_FILENAME = "editable-daemon-running.json";

interface RunningDaemonRecord {
  pid: number;
  startedAt: string;
  releaseDigest: string | null;
  channel: string;
  updatedAt: string;
}

export interface EditableDaemonRuntimeState {
  running: boolean;
  listen: string | null;
  pid: number | null;
  runningDigest: string | null;
  runningChannel: string | null;
}

export interface EditableDaemonSwapResult {
  ok: boolean;
  swapped: boolean;
  daemonRunning: boolean;
  activeDigest: string | null;
  rolledBackTo?: string | null;
  error?: string;
}

export interface EditableDaemonControllerDeps {
  store: EditableReleaseStore;
  paseoHome?: () => string;
  paseoListen?: () => string | undefined;
  userHome?: string;
  isDevProfile?: () => boolean;
  readInstance?: (home: string) => Promise<DaemonInstance | null>;
  isProcessAlive?: (pid: number) => boolean;
  stopDaemon?: () => Promise<DesktopDaemonStatus>;
  startDaemon?: (override: EditableDaemonLaunchOverride | null) => Promise<DesktopDaemonStatus>;
  warn?: (error: unknown) => void;
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return typeof err === "object" && err !== null && "code" in err && err.code === "EPERM";
  }
}

function canonicalPath(candidate: string): string {
  try {
    return realpathSync(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

export function assertIsolatedDevDaemonHome(input: {
  isDev: boolean;
  paseoHome: string;
  paseoListen?: string;
  userHome?: string;
}): void {
  if (!input.isDev) {
    throw new Error("Daemon hot-swap is only allowed inside the isolated Paseo Dev sandbox");
  }
  const userHome = input.userHome ?? os.homedir();
  const normalizedHome = canonicalPath(input.paseoHome).toLowerCase();
  const forbiddenDirs = [
    path.join(userHome, ".paseo"),
    path.join(userHome, ".paseo-workshop"),
    path.join(userHome, ".editable-paseo"),
  ].map((dir) => canonicalPath(dir).toLowerCase());
  for (const forbidden of forbiddenDirs) {
    if (normalizedHome === forbidden || normalizedHome.startsWith(`${forbidden}${path.sep}`)) {
      throw new Error(
        "Refusing daemon hot-swap against protected production or workshop Paseo home",
      );
    }
  }
  const listen = input.paseoListen?.trim() ?? "";
  if (listen.endsWith(":6767") || listen.endsWith(":6769")) {
    throw new Error(`Refusing daemon hot-swap on protected port (${listen})`);
  }
}

function readRunningRecord(home: string): RunningDaemonRecord | null {
  const file = path.join(home, RUNNING_STATE_FILENAME);
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<RunningDaemonRecord>;
    if (typeof parsed.pid !== "number" || typeof parsed.startedAt !== "string") return null;
    return {
      pid: parsed.pid,
      startedAt: parsed.startedAt,
      releaseDigest: typeof parsed.releaseDigest === "string" ? parsed.releaseDigest : null,
      channel: typeof parsed.channel === "string" ? parsed.channel : "prod",
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
    };
  } catch {
    return null;
  }
}

function writeRunningRecord(home: string, record: RunningDaemonRecord): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const file = path.join(home, RUNNING_STATE_FILENAME);
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function toLaunchOverride(
  release: DaemonRelease,
  channel: string,
): EditableDaemonLaunchOverride | null {
  if (!release.releaseDigest || !release.releaseDir || !release.entryPath) return null;
  return {
    releaseDir: release.releaseDir,
    entryPath: release.entryPath,
    digest: release.releaseDigest,
    channel,
  };
}

export class EditableDaemonController {
  private inFlightSwap: Promise<EditableDaemonSwapResult> | null = null;

  constructor(private readonly deps: EditableDaemonControllerDeps) {}

  private getHome(): string {
    return this.deps.paseoHome ? this.deps.paseoHome() : resolvePaseoHome(process.env);
  }

  private assertIsolated(): string {
    const home = this.getHome();
    assertIsolatedDevDaemonHome({
      isDev: this.deps.isDevProfile ? this.deps.isDevProfile() : isDevInstance(),
      paseoHome: home,
      paseoListen: this.deps.paseoListen ? this.deps.paseoListen() : process.env.PASEO_LISTEN,
      userHome: this.deps.userHome,
    });
    return home;
  }

  resolveLaunchOverride(): EditableDaemonLaunchOverride | null {
    if (this.deps.store.safe) return null;
    const active = this.deps.store.activeDaemonRelease;
    if (!active.releaseDigest) return null;
    try {
      this.assertIsolated();
      const verified = this.deps.store.loadDaemonRelease(active.releaseDigest);
      return toLaunchOverride(verified, this.deps.store.activeChannel);
    } catch (error) {
      this.deps.warn?.(error);
      return null;
    }
  }

  recordStarted(info: {
    home: string;
    instance: DaemonInstance;
    digest: string | null;
    channel: string;
  }): void {
    try {
      writeRunningRecord(info.home, {
        pid: info.instance.pid,
        startedAt: info.instance.startedAt,
        releaseDigest: info.digest,
        channel: info.channel,
        updatedAt: new Date().toISOString(),
      });
      if (info.digest) {
        this.deps.store.reportDaemonHealthy(info.digest);
      }
    } catch (error) {
      this.deps.warn?.(error);
    }
  }

  async getRunningState(): Promise<EditableDaemonRuntimeState> {
    const home = this.getHome();
    const readInst = this.deps.readInstance ?? readDaemonInstance;
    const isAlive = this.deps.isProcessAlive ?? defaultIsProcessAlive;
    try {
      const instance = await readInst(home);
      if (!instance || !isAlive(instance.pid)) {
        return {
          running: false,
          listen: null,
          pid: null,
          runningDigest: null,
          runningChannel: null,
        };
      }
      const record = readRunningRecord(home);
      const matched =
        record && record.pid === instance.pid && record.startedAt === instance.startedAt;
      return {
        running: true,
        listen: instance.listen ?? null,
        pid: instance.pid,
        runningDigest: matched ? record.releaseDigest : null,
        runningChannel: matched ? record.channel : null,
      };
    } catch {
      return {
        running: false,
        listen: null,
        pid: null,
        runningDigest: null,
        runningChannel: null,
      };
    }
  }

  async applyDaemonTarget(input: {
    targetDigest: string | null;
    channel: string;
    generation?: number;
  }): Promise<EditableDaemonSwapResult> {
    if (this.inFlightSwap) {
      return {
        ok: false,
        swapped: false,
        daemonRunning: true,
        activeDigest: this.deps.store.activeDaemonDigest,
        error: "A daemon swap is already in progress",
      };
    }
    this.inFlightSwap = this.runApplyDaemonTarget(input).finally(() => {
      this.inFlightSwap = null;
    });
    return this.inFlightSwap;
  }

  private async runApplyDaemonTarget(input: {
    targetDigest: string | null;
    channel: string;
    generation?: number;
  }): Promise<EditableDaemonSwapResult> {
    const home = this.assertIsolated();

    // Verify signed daemon directory BEFORE touching any running daemon process.
    const targetRelease =
      input.targetDigest === null
        ? { releaseDigest: null, releaseDir: null, entryPath: null }
        : this.deps.store.loadDaemonRelease(input.targetDigest);

    const before = await this.getRunningState();
    this.deps.store.switchDaemonRelease(
      targetRelease.releaseDigest,
      input.generation,
      input.channel,
    );

    if (!before.running) {
      return {
        ok: true,
        swapped: false,
        daemonRunning: false,
        activeDigest: targetRelease.releaseDigest,
      };
    }

    if (before.runningDigest === targetRelease.releaseDigest) {
      const readInst = this.deps.readInstance ?? readDaemonInstance;
      const inst = await readInst(home).catch(() => null);
      if (inst) {
        writeRunningRecord(home, {
          pid: inst.pid,
          startedAt: inst.startedAt,
          releaseDigest: targetRelease.releaseDigest,
          channel: input.channel,
          updatedAt: new Date().toISOString(),
        });
      }
      return {
        ok: true,
        swapped: false,
        daemonRunning: true,
        activeDigest: targetRelease.releaseDigest,
      };
    }

    return this.restartWithRollback(home, targetRelease, input.channel);
  }

  private async restartWithRollback(
    home: string,
    targetRelease: DaemonRelease,
    channel: string,
  ): Promise<EditableDaemonSwapResult> {
    const stopFn = this.deps.stopDaemon ?? (() => stopDesktopDaemon("editable_swap"));
    const startFn =
      this.deps.startDaemon ??
      ((override: EditableDaemonLaunchOverride | null) =>
        startDesktopDaemon({
          override,
          skipVersionMismatchCheck: true,
          timeoutMs: 20_000,
        }));

    try {
      await stopFn();
      const started = await startFn(toLaunchOverride(targetRelease, channel));
      if (started.status !== "running") {
        throw new Error(started.error ?? `Swapped daemon ended in state "${started.status}"`);
      }
      if (targetRelease.releaseDigest) {
        this.deps.store.reportDaemonHealthy(targetRelease.releaseDigest);
      }
      const readInst = this.deps.readInstance ?? readDaemonInstance;
      const inst = await readInst(home).catch(() => null);
      if (inst) {
        writeRunningRecord(home, {
          pid: inst.pid,
          startedAt: inst.startedAt,
          releaseDigest: targetRelease.releaseDigest,
          channel,
          updatedAt: new Date().toISOString(),
        });
      }
      return {
        ok: true,
        swapped: true,
        daemonRunning: true,
        activeDigest: targetRelease.releaseDigest,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!targetRelease.releaseDigest) {
        return {
          ok: false,
          swapped: false,
          daemonRunning: false,
          activeDigest: null,
          error: message,
        };
      }

      const fallback = this.deps.store.quarantineDaemon(targetRelease.releaseDigest);
      try {
        await stopFn().catch(() => undefined);
        const recovered = await startFn(toLaunchOverride(fallback, "prod"));
        if (recovered.status === "running") {
          const readInst = this.deps.readInstance ?? readDaemonInstance;
          const inst = await readInst(home).catch(() => null);
          if (inst) {
            writeRunningRecord(home, {
              pid: inst.pid,
              startedAt: inst.startedAt,
              releaseDigest: fallback.releaseDigest,
              channel: "prod",
              updatedAt: new Date().toISOString(),
            });
          }
        }
      } catch (rollbackError) {
        this.deps.warn?.(rollbackError);
      }
      return {
        ok: false,
        swapped: false,
        daemonRunning: (await this.getRunningState()).running,
        activeDigest: fallback.releaseDigest,
        rolledBackTo: fallback.releaseDigest,
        error: `Daemon swap failed and rolled back: ${message}`,
      };
    }
  }

  async resetToBuiltIn(): Promise<EditableDaemonSwapResult> {
    const before = await this.getRunningState();
    this.deps.store.useRecoveryDaemon();
    if (!before.running || before.runningDigest === null) {
      return {
        ok: true,
        swapped: false,
        daemonRunning: before.running,
        activeDigest: null,
      };
    }
    const home = this.assertIsolated();
    return this.restartWithRollback(
      home,
      { releaseDigest: null, releaseDir: null, entryPath: null },
      "builtin",
    );
  }
}
