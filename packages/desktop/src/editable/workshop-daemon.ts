import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DaemonInstanceError,
  readDaemonInstance,
  readLocalCredentialForTarget,
  resolvePaseoHome,
  startDaemonInstance,
  type DaemonInstance,
} from "@getpaseo/server/daemon-control";
import { z } from "zod";
import {
  createNodeEntrypointInvocation,
  resolveDaemonRunnerEntrypoint,
} from "../daemon/runtime-paths.js";
import { getBundledCliShimPath } from "../integrations/cli-install/index.js";

const workshopConfigSchema = z.object({
  workshopHome: z.string().min(1).optional(),
  workshopPort: z.number().int().min(1024).max(65535).optional(),
});

export interface EditableWorkshopDaemonStatus {
  status: "running" | "starting" | "stopped" | "errored";
  serverId: string | null;
  listen: string;
  pid: number | null;
  home: string;
  repoDir: string;
  worktrees: string[];
  error: string | null;
}

export interface WorkshopSettings {
  configHome: string;
  workshopHome: string;
  workshopPort: number;
  listen: string;
  repoDir: string;
  worktreesDir: string;
}

function expandTilde(input: string, userHome: string): string {
  if (input === "~") return userHome;
  if (input.startsWith("~/")) return path.join(userHome, input.slice(2));
  return input;
}

function prependPathDir(currentPath: string | undefined, dir: string): string {
  const parts = (currentPath ?? "").split(path.delimiter).filter(Boolean);
  if (parts.includes(dir)) return parts.join(path.delimiter);
  return [dir, ...parts].join(path.delimiter);
}

export function resolveWorkshopSettings(
  configHome: string,
  options: {
    userHome?: string;
    currentPaseoHome?: string;
    currentListen?: string | null;
  } = {},
): WorkshopSettings {
  const userHome = options.userHome ?? os.homedir();
  const currentPaseoHome = path.resolve(options.currentPaseoHome ?? resolvePaseoHome());
  const currentListen = (options.currentListen ?? process.env.PASEO_LISTEN ?? "").trim();

  let parsed: z.infer<typeof workshopConfigSchema> = {};
  const configFile = path.join(configHome, "config.json");
  if (existsSync(configFile)) {
    try {
      parsed = workshopConfigSchema.parse(JSON.parse(readFileSync(configFile, "utf8")));
    } catch {
      parsed = {};
    }
  }

  const workshopHome = path.resolve(
    expandTilde(parsed.workshopHome ?? path.join(userHome, ".paseo-workshop"), userHome),
  );
  const workshopPort = parsed.workshopPort ?? 6769;
  const listen = `127.0.0.1:${workshopPort}`;

  const prodHome = path.resolve(path.join(userHome, ".paseo"));
  if (workshopHome === prodHome || workshopHome === currentPaseoHome) {
    throw new Error("Workshop daemon home must be isolated from live Paseo homes");
  }
  if (workshopPort === 6767 || (currentListen && listen === currentListen)) {
    throw new Error("Workshop daemon port must be isolated from live Paseo ports");
  }

  return {
    configHome: path.resolve(configHome),
    workshopHome,
    workshopPort,
    listen,
    repoDir: path.join(path.resolve(configHome), "repo"),
    worktreesDir: path.join(path.resolve(configHome), "worktrees"),
  };
}

function listWorktrees(worktreesDir: string): string[] {
  try {
    return readdirSync(worktreesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function readServerId(home: string, instance: DaemonInstance | null): string | null {
  if (instance?.serverId && instance.serverId.trim()) return instance.serverId.trim();
  try {
    const value = readFileSync(path.join(home, "server-id"), "utf8").trim();
    return value || null;
  } catch {
    return null;
  }
}

function ensureWorkshopConfigFile(home: string, listen: string): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const configPath = path.join(home, "config.json");
  try {
    writeFileSync(
      configPath,
      JSON.stringify({ daemon: { listen, relay: { enabled: false } } }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export interface EditableWorkshopDaemonDeps {
  configHome: string;
  userHome?: string;
  currentPaseoHome?: string;
  currentListen?: string | null;
  readInstance?: (home: string) => Promise<DaemonInstance | null>;
  startInstance?: typeof startDaemonInstance;
  readCredential?: (home: string, target: string) => string | null;
  createInvocation?: (
    baseEnv: NodeJS.ProcessEnv,
  ) => ReturnType<typeof createNodeEntrypointInvocation>;
  cliShimPath?: () => string;
}

export class EditableWorkshopDaemonManager {
  private starting: Promise<EditableWorkshopDaemonStatus> | null = null;
  private lastError: string | null = null;

  constructor(private readonly deps: EditableWorkshopDaemonDeps) {}

  private settings(): WorkshopSettings {
    return resolveWorkshopSettings(this.deps.configHome, {
      userHome: this.deps.userHome,
      currentPaseoHome: this.deps.currentPaseoHome,
      currentListen: this.deps.currentListen,
    });
  }

  private readInstance(home: string): Promise<DaemonInstance | null> {
    return (this.deps.readInstance ?? readDaemonInstance)(home);
  }

  async getStatus(): Promise<EditableWorkshopDaemonStatus> {
    let settings: WorkshopSettings;
    try {
      settings = this.settings();
    } catch (error) {
      return {
        status: "errored",
        serverId: null,
        listen: "127.0.0.1:6769",
        pid: null,
        home: path.join(this.deps.userHome ?? os.homedir(), ".paseo-workshop"),
        repoDir: path.join(path.resolve(this.deps.configHome), "repo"),
        worktrees: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }

    const worktrees = listWorktrees(settings.worktreesDir);
    const instance = await this.readInstance(settings.workshopHome);
    const serverId = readServerId(settings.workshopHome, instance);

    if (instance && instance.listen && serverId) {
      this.lastError = null;
      return {
        status: "running",
        serverId,
        listen: instance.listen,
        pid: instance.pid,
        home: settings.workshopHome,
        repoDir: settings.repoDir,
        worktrees,
        error: null,
      };
    }
    if (instance || this.starting) {
      return {
        status: "starting",
        serverId,
        listen: instance?.listen ?? settings.listen,
        pid: instance?.pid ?? null,
        home: settings.workshopHome,
        repoDir: settings.repoDir,
        worktrees,
        error: null,
      };
    }
    return {
      status: this.lastError ? "errored" : "stopped",
      serverId,
      listen: settings.listen,
      pid: null,
      home: settings.workshopHome,
      repoDir: settings.repoDir,
      worktrees,
      error: this.lastError,
    };
  }

  async start(): Promise<EditableWorkshopDaemonStatus> {
    if (this.starting) return this.starting;
    this.starting = this.runStart().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  private async runStart(): Promise<EditableWorkshopDaemonStatus> {
    this.lastError = null;
    const settings = this.settings();
    const existing = await this.getStatus();
    if (existing.status === "running") return existing;

    ensureWorkshopConfigFile(settings.workshopHome, settings.listen);

    const userHome = this.deps.userHome ?? os.homedir();
    const baseEnv: NodeJS.ProcessEnv = { ...process.env };
    delete baseEnv.PASEO_ELECTRON_USER_DATA_DIR;
    delete baseEnv.PASEO_DEV_INSTANCE;
    baseEnv.PASEO_HOME = settings.workshopHome;
    baseEnv.PASEO_LISTEN = settings.listen;
    baseEnv.EDITABLE_PASEO_HOME = settings.configHome;
    baseEnv.PATH = prependPathDir(baseEnv.PATH, path.join(userHome, ".local", "bin"));

    const invocation = (
      this.deps.createInvocation ??
      ((env) =>
        createNodeEntrypointInvocation({
          entrypoint: resolveDaemonRunnerEntrypoint(),
          argvMode: "node-script",
          args: [],
          baseEnv: env,
        }))
    )(baseEnv);

    try {
      await (this.deps.startInstance ?? startDaemonInstance)({
        home: settings.workshopHome,
        timeoutMs: 30_000,
        ...invocation,
        env: {
          ...invocation.env,
          PASEO_HOME: settings.workshopHome,
          PASEO_LISTEN: settings.listen,
          EDITABLE_PASEO_HOME: settings.configHome,
          PASEO_CLI: (this.deps.cliShimPath ?? getBundledCliShimPath)(),
          PATH: prependPathDir(invocation.env.PATH, path.join(userHome, ".local", "bin")),
        },
        mode: "managed",
        desktopManaged: true,
      });
    } catch (error) {
      if (!(error instanceof DaemonInstanceError && error.code === "DAEMON_NOT_READY")) {
        this.lastError = error instanceof Error ? error.message : String(error);
        throw error;
      }
    }

    return this.getStatus();
  }

  async readLocalCredential(listen: string): Promise<string | null> {
    if (!listen.trim()) return null;
    let settings: WorkshopSettings;
    try {
      settings = this.settings();
    } catch {
      return null;
    }
    const instance = await this.readInstance(settings.workshopHome);
    if (!instance) return null;
    return (this.deps.readCredential ?? readLocalCredentialForTarget)(
      settings.workshopHome,
      listen,
    );
  }
}
