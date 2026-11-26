import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { syncChannelFromCloudShelf, syncWipIndexFromCloudShelf } from "./cloud-sync.js";
import { resolveRegularFile, verifySignedEnvelope } from "./crypto.js";
import type { EditableDaemonController, EditableDaemonRuntimeState } from "./daemon-swap.js";
import type { EditableReleaseStore, RendererRelease } from "./release-store.js";
import {
  editableServiceSchema,
  wipIndexSchema,
  type EditableService,
  type WipBranchPointer,
} from "./schema.js";

const execFileAsync = promisify(execFile);

const SLUG_RE = /^[a-z0-9][a-z0-9-_]{0,47}$/;
const CHANNEL_RE = /^[a-z0-9][a-z0-9_-]{0,62}$/;

const localBranchMetaSchema = z.object({
  schemaVersion: z.literal(1),
  slug: z.string(),
  branch: z.string(),
  channel: z.string(),
  status: z.enum(["working", "ready", "failed"]),
  summary: z.string().default(""),
  releaseDigest: z.string().nullable().default(null),
  daemonReleaseDigest: z.string().nullable().default(null),
  services: z.array(editableServiceSchema).optional(),
  sourceSha: z.string().default(""),
  generation: z.number().int().nullable().default(null),
  uploadedToCloud: z.boolean().default(false),
  requiresDaemon: z.boolean().default(false),
  requiresNative: z.boolean().default(false),
  agentId: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
  updatedAt: z.string().default(""),
});

type LocalBranchMeta = z.infer<typeof localBranchMetaSchema>;

const editableConfigSchema = z.object({
  baseBranch: z.string().min(1).default("paseo-customizations"),
  channel: z.string().min(1).default("prod"),
});

export interface EditableBranchEntry {
  slug: string;
  channel: string;
  branch: string;
  isMain: boolean;
  status: "ready" | "working" | "draft" | "idle" | "shipping" | "failed";
  summary: string | null;
  releaseDigest: string | null;
  daemonReleaseDigest: string | null;
  services: EditableService[];
  generation: number | null;
  sourceSha: string | null;
  hasChanges: boolean;
  behindMain: boolean;
  canFastForward: boolean;
  requiresDaemon: boolean;
  hasUpdate: boolean;
  hasUiUpdate: boolean;
  hasDaemonUpdate: boolean;
  requiresDaemonRestartOnLoad: boolean;
  loaded: boolean;
  remoteOnly: boolean;
  agentId: string | null;
  error: string | null;
  updatedAt: string | null;
}

export interface EditableBranchesSnapshot {
  loadedChannel: string;
  loadedDigest: string | null;
  loadedDaemonDigest: string | null;
  daemonRunning: boolean;
  daemonListen: string | null;
  mainDaemonGeneration: number | null;
  safeRenderer: boolean;
  main: EditableBranchEntry;
  branches: EditableBranchEntry[];
}

export interface CreateBranchResult {
  ok: boolean;
  slug?: string;
  branch?: string;
  worktreePath?: string;
  error?: string;
}

export interface ShipBranchResult {
  ok: boolean;
  fastForwarded?: boolean;
  releaseDigest?: string | null;
  daemonReleaseDigest?: string | null;
  generation?: number;
  shouldAutoLoad?: boolean;
  error?: string;
}

export interface LoadBranchResult {
  release: RendererRelease;
  channel: string;
  uiChanged: boolean;
  daemonSwapped: boolean;
}

interface GitWorktreeInspection {
  slug: string;
  headSha: string;
  dirty: boolean;
  behindMain: number;
  aheadOfMain: number;
}

function buildCliEnv(configHome: string, userHome: string): NodeJS.ProcessEnv {
  const localBin = path.join(userHome, ".local", "bin");
  const nodeBin = path.dirname(process.execPath);
  const current = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean);
  for (const dir of [nodeBin, localBin]) {
    if (!current.includes(dir)) current.unshift(dir);
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    EDITABLE_PASEO_HOME: configHome,
    PATH: current.join(path.delimiter),
  };
  delete env.PASEO_DEV_INSTANCE;
  return env;
}

async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd, timeout: 10_000 });
  return stdout.trim();
}

async function inspectWorktree(
  repoDir: string,
  worktreeDir: string,
  baseBranch: string,
  slug: string,
): Promise<GitWorktreeInspection | null> {
  try {
    const headSha = await runGit(["rev-parse", "HEAD"], worktreeDir);
    const statusOut = await runGit(["status", "--porcelain"], worktreeDir);
    const counts = await runGit(
      ["rev-list", "--left-right", "--count", `${baseBranch}...${headSha}`],
      repoDir,
    ).catch(() => "0\t0");
    const [behindStr, aheadStr] = counts.split(/\s+/);
    return {
      slug,
      headSha,
      dirty: statusOut.length > 0,
      behindMain: Number(behindStr ?? 0) || 0,
      aheadOfMain: Number(aheadStr ?? 0) || 0,
    };
  } catch {
    return null;
  }
}

function readLocalConfig(configHome: string): { baseBranch: string; channel: string } {
  const file = path.join(configHome, "config.json");
  if (!existsSync(file)) return { baseBranch: "paseo-customizations", channel: "prod" };
  try {
    return editableConfigSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return { baseBranch: "paseo-customizations", channel: "prod" };
  }
}

function readLocalBranchMeta(
  configHome: string,
  slug: string,
): z.infer<typeof localBranchMetaSchema> | null {
  const file = path.join(configHome, "branches", `${slug}.json`);
  if (!existsSync(file)) return null;
  try {
    return localBranchMetaSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function readVerifiedWipIndex(homes: string[], publicKey: () => string): WipBranchPointer[] {
  let key: string;
  try {
    key = publicKey();
  } catch {
    return [];
  }
  let bestGen = 0;
  let best: WipBranchPointer[] = [];
  for (const dir of homes) {
    const file = resolveRegularFile(dir, "releases/electron-web/channels/wip-index.json");
    if (!file) continue;
    try {
      const envelope = JSON.parse(readFileSync(file, "utf8")) as unknown;
      if (!verifySignedEnvelope(envelope, key)) continue;
      const parsed = wipIndexSchema.parse(envelope.payload);
      if (parsed.generation >= bestGen) {
        bestGen = parsed.generation;
        best = parsed.branches;
      }
    } catch {
      // Ignore unreadable or invalid cache
    }
  }
  return best;
}

export interface EditableBranchManagerDeps {
  home: string;
  configHome: string;
  store: EditableReleaseStore;
  daemonController?: EditableDaemonController;
  userHome?: string;
  cliBin?: string;
  fetchImpl?: typeof fetch;
  execCli?: (args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
}

interface SnapshotContext {
  loadedChannel: string;
  loadedDigest: string | null;
  safeRenderer: boolean;
  prodDaemonDigest: string | null;
  daemonState: EditableDaemonRuntimeState;
}

function pickPrimaryPointer(
  uiPtr: ReturnType<EditableReleaseStore["getChannelPointer"]>,
  daemonPtr: ReturnType<EditableReleaseStore["getDaemonChannelPointer"]>,
) {
  return uiPtr ?? daemonPtr;
}

function listPresentServices(hasUi: boolean, hasDaemon: boolean): EditableService[] {
  const services: EditableService[] = [];
  if (hasUi) services.push("ui");
  if (hasDaemon) services.push("daemon");
  return services;
}

function firstNonNull<T>(...values: Array<T | null | undefined>): T | null {
  for (const v of values) {
    if (v !== null && v !== undefined) return v;
  }
  return null;
}

function inferBranchServices(input: {
  explicit?: EditableService[];
  releaseDigest: string | null;
  daemonReleaseDigest: string | null;
  requiresDaemon: boolean;
  requiresNative?: boolean;
}): EditableService[] {
  if (input.explicit && input.explicit.length > 0) return input.explicit;
  const services = listPresentServices(
    Boolean(input.releaseDigest),
    Boolean(input.daemonReleaseDigest || input.requiresDaemon),
  );
  if (input.requiresNative) services.push("desktop");
  return services;
}

export class EditableBranchManager {
  private readonly shippingSlugs = new Set<string>();
  private readonly shipErrors = new Map<string, string>();
  private syncing: Promise<{ updated: boolean }> | null = null;

  constructor(private readonly deps: EditableBranchManagerDeps) {}

  private cliPath(): string {
    return (
      this.deps.cliBin ?? path.join(this.deps.userHome ?? os.homedir(), ".local", "bin", "paseo-ed")
    );
  }

  private async runCli(args: string[]): Promise<string> {
    const env = buildCliEnv(this.deps.configHome, this.deps.userHome ?? os.homedir());
    if (this.deps.execCli) return this.deps.execCli(args, env);
    const { stdout } = await execFileAsync(this.cliPath(), args, {
      env,
      maxBuffer: 32 * 1024 * 1024,
      timeout: 300_000,
    });
    return stdout;
  }

  private hasDigestUpdate(
    loaded: boolean,
    digest: string | null,
    loadedDigest: string | null,
  ): boolean {
    return Boolean(
      loaded && digest && digest !== loadedDigest && !this.deps.store.isQuarantined(digest),
    );
  }

  private hasDaemonDigestUpdate(
    loaded: boolean,
    targetDaemonDigest: string | null,
    daemonState: EditableDaemonRuntimeState,
  ): boolean {
    if (!loaded || !targetDaemonDigest || this.deps.store.isDaemonQuarantined(targetDaemonDigest)) {
      return false;
    }
    const currentDigest = daemonState.running
      ? daemonState.runningDigest
      : this.deps.store.activeDaemonDigest;
    return targetDaemonDigest !== currentDigest;
  }

  private willRestartDaemonOnLoad(
    targetDaemonDigest: string | null,
    daemonState: EditableDaemonRuntimeState,
  ): boolean {
    if (!daemonState.running) return false;
    return daemonState.runningDigest !== targetDaemonDigest;
  }

  private buildMainEntry(baseBranch: string, ctx: SnapshotContext): EditableBranchEntry {
    const prodPtr = this.deps.store.getChannelPointer("prod");
    const prodDaemonPtr = this.deps.store.getDaemonChannelPointer("prod");
    const primary = pickPrimaryPointer(prodPtr, prodDaemonPtr);
    const uiDigest = prodPtr?.digest ?? null;
    const daemonDigest = prodDaemonPtr?.digest ?? null;
    const loaded = !ctx.safeRenderer && ctx.loadedChannel === "prod";
    const hasUiUpdate = this.hasDigestUpdate(loaded, uiDigest, ctx.loadedDigest);
    const hasDaemonUpdate = this.hasDaemonDigestUpdate(loaded, daemonDigest, ctx.daemonState);
    const generation = Math.max(prodPtr?.generation ?? 0, prodDaemonPtr?.generation ?? 0) || null;

    return {
      slug: "main",
      channel: "prod",
      branch: baseBranch,
      isMain: true,
      status: "ready",
      summary: primary?.summary ?? null,
      releaseDigest: uiDigest,
      daemonReleaseDigest: daemonDigest,
      services: listPresentServices(Boolean(uiDigest), Boolean(daemonDigest)),
      generation,
      sourceSha: primary?.sourceSha ?? null,
      hasChanges: false,
      behindMain: false,
      canFastForward: false,
      requiresDaemon: false,
      hasUpdate: hasUiUpdate || hasDaemonUpdate,
      hasUiUpdate,
      hasDaemonUpdate,
      requiresDaemonRestartOnLoad: this.willRestartDaemonOnLoad(daemonDigest, ctx.daemonState),
      loaded,
      remoteOnly: false,
      agentId: null,
      error: null,
      updatedAt: primary?.updatedAt ?? null,
    };
  }

  private buildIndexedWipEntry(ptr: WipBranchPointer, ctx: SnapshotContext): EditableBranchEntry {
    const channelPtr = this.deps.store.getChannelPointer(ptr.channel);
    const channelDaemonPtr = this.deps.store.getDaemonChannelPointer(ptr.channel);
    const primary = pickPrimaryPointer(channelPtr, channelDaemonPtr);
    const digest = channelPtr?.digest ?? ptr.releaseDigest;
    const daemonDigest = firstNonNull(channelDaemonPtr?.digest, ptr.daemonReleaseDigest);
    const loaded = !ctx.safeRenderer && ctx.loadedChannel === ptr.channel;
    const targetDaemon = daemonDigest ?? ctx.prodDaemonDigest;
    const hasUiUpdate = this.hasDigestUpdate(loaded, digest, ctx.loadedDigest);
    const hasDaemonUpdate = this.hasDaemonDigestUpdate(loaded, targetDaemon, ctx.daemonState);
    const hasArtifact = Boolean(digest || daemonDigest);
    let status: EditableBranchEntry["status"] = hasArtifact ? "ready" : "idle";
    if (this.shippingSlugs.has(ptr.slug)) status = "shipping";

    return {
      slug: ptr.slug,
      channel: ptr.channel,
      branch: ptr.branch,
      isMain: false,
      status,
      summary: firstNonNull(primary?.summary, ptr.summary || null),
      releaseDigest: digest,
      daemonReleaseDigest: daemonDigest,
      services: inferBranchServices({
        explicit: ptr.services,
        releaseDigest: digest,
        daemonReleaseDigest: daemonDigest,
        requiresDaemon: ptr.requiresDaemon,
        requiresNative: ptr.requiresNative,
      }),
      generation: primary?.generation ?? null,
      sourceSha: primary?.sourceSha ?? ptr.sourceSha,
      hasChanges: hasArtifact,
      behindMain: false,
      canFastForward: false,
      requiresDaemon: ptr.requiresDaemon || Boolean(daemonDigest),
      hasUpdate: hasUiUpdate || hasDaemonUpdate,
      hasUiUpdate,
      hasDaemonUpdate,
      requiresDaemonRestartOnLoad: this.willRestartDaemonOnLoad(targetDaemon, ctx.daemonState),
      loaded,
      remoteOnly: true,
      agentId: null,
      error: this.shipErrors.get(ptr.slug) ?? null,
      updatedAt: primary?.updatedAt ?? ptr.updatedAt,
    };
  }

  private extractMetaDefaults(slug: string, meta: LocalBranchMeta | null) {
    if (!meta) {
      return {
        channel: `wip-${slug}`,
        digest: null as string | null,
        daemonDigest: null as string | null,
        services: undefined as EditableService[] | undefined,
        sha: null as string | null,
        branch: `ed/wip/${slug}`,
        summary: null as string | null,
        generation: null as number | null,
        requiresDaemon: false,
        requiresNative: false,
        agentId: null as string | null,
        error: null as string | null,
        updatedAt: null as string | null,
      };
    }
    return {
      channel: meta.channel,
      digest: meta.releaseDigest,
      daemonDigest: meta.daemonReleaseDigest,
      services: meta.services,
      sha: meta.sourceSha,
      branch: meta.branch,
      summary: meta.summary || null,
      generation: meta.generation,
      requiresDaemon: meta.requiresDaemon,
      requiresNative: meta.requiresNative,
      agentId: meta.agentId,
      error: meta.error,
      updatedAt: meta.updatedAt || null,
    };
  }

  private mergeChannelRelease(
    channelPtr: ReturnType<EditableReleaseStore["getChannelPointer"]>,
    daemonPtr: ReturnType<EditableReleaseStore["getDaemonChannelPointer"]>,
    defaults: ReturnType<EditableBranchManager["extractMetaDefaults"]>,
  ) {
    const primary = pickPrimaryPointer(channelPtr, daemonPtr);
    return {
      releaseDigest: firstNonNull(channelPtr?.digest, defaults.digest),
      daemonReleaseDigest: firstNonNull(daemonPtr?.digest, defaults.daemonDigest),
      releaseSha: firstNonNull(primary?.sourceSha, defaults.sha),
      summary: firstNonNull(primary?.summary, defaults.summary),
      generation: firstNonNull(primary?.generation, defaults.generation),
      updatedAt: firstNonNull(primary?.updatedAt, defaults.updatedAt),
    };
  }

  private resolveLocalWipStatus(
    slug: string,
    meta: LocalBranchMeta | null,
    hasChanges: boolean,
    stagedMatchesHead: boolean,
    hasAnyRelease: boolean,
    shipErr: string | null,
  ): EditableBranchEntry["status"] {
    if (this.shippingSlugs.has(slug)) return "shipping";
    if (shipErr || meta?.status === "failed") return "failed";
    if (hasChanges && (stagedMatchesHead || (meta?.status === "ready" && hasAnyRelease))) {
      return "ready";
    }
    if (hasChanges) return "draft";
    return "idle";
  }

  private isStagedAtHead(input: {
    hasChanges: boolean;
    dirty: boolean;
    headSha: string;
    requiresDaemon: boolean;
    meta: LocalBranchMeta | null;
    releaseDigest: string | null;
    daemonReleaseDigest: string | null;
    releaseSha: string | null;
  }): boolean {
    if (!input.hasChanges || input.dirty) return false;
    if ((input.releaseDigest || input.daemonReleaseDigest) && input.releaseSha === input.headSha) {
      return true;
    }
    return Boolean(
      input.requiresDaemon &&
      input.meta?.status === "ready" &&
      input.meta.sourceSha === input.headSha,
    );
  }

  private buildLocalWipEntry(
    info: GitWorktreeInspection,
    hasRemote: boolean,
    ctx: SnapshotContext,
  ): EditableBranchEntry | null {
    const meta = readLocalBranchMeta(this.deps.configHome, info.slug);
    const hasChanges = info.aheadOfMain > 0 || info.dirty;
    if (!hasChanges && !meta && !hasRemote) return null;

    const defaults = this.extractMetaDefaults(info.slug, meta);
    const channelPtr = this.deps.store.getChannelPointer(defaults.channel);
    const daemonPtr = this.deps.store.getDaemonChannelPointer(defaults.channel);
    const release = this.mergeChannelRelease(channelPtr, daemonPtr, defaults);
    const stagedMatchesHead = this.isStagedAtHead({
      hasChanges,
      dirty: info.dirty,
      headSha: info.headSha,
      requiresDaemon: defaults.requiresDaemon,
      meta,
      releaseDigest: release.releaseDigest,
      daemonReleaseDigest: release.daemonReleaseDigest,
      releaseSha: release.releaseSha,
    });
    const loaded = !ctx.safeRenderer && ctx.loadedChannel === defaults.channel;
    const shipErr = this.shipErrors.get(info.slug) ?? null;
    const uiDigest = hasChanges ? release.releaseDigest : null;
    const daemonDigest = hasChanges ? release.daemonReleaseDigest : null;
    const targetDaemon = daemonDigest ?? ctx.prodDaemonDigest;
    const hasUiUpdate = this.hasDigestUpdate(loaded, uiDigest, ctx.loadedDigest);
    const hasDaemonUpdate = this.hasDaemonDigestUpdate(loaded, targetDaemon, ctx.daemonState);

    return {
      slug: info.slug,
      channel: defaults.channel,
      branch: defaults.branch,
      isMain: false,
      status: this.resolveLocalWipStatus(
        info.slug,
        meta,
        hasChanges,
        stagedMatchesHead,
        Boolean(release.releaseDigest || release.daemonReleaseDigest),
        shipErr,
      ),
      summary: release.summary,
      releaseDigest: uiDigest,
      daemonReleaseDigest: daemonDigest,
      services: hasChanges
        ? inferBranchServices({
            explicit: defaults.services,
            releaseDigest: uiDigest,
            daemonReleaseDigest: daemonDigest,
            requiresDaemon: defaults.requiresDaemon,
            requiresNative: defaults.requiresNative,
          })
        : [],
      generation: hasChanges ? release.generation : null,
      sourceSha: info.headSha,
      hasChanges,
      behindMain: info.behindMain > 0,
      canFastForward: hasChanges && info.behindMain === 0 && !info.dirty && stagedMatchesHead,
      requiresDaemon: defaults.requiresDaemon || Boolean(daemonDigest),
      hasUpdate: hasUiUpdate || hasDaemonUpdate,
      hasUiUpdate,
      hasDaemonUpdate,
      requiresDaemonRestartOnLoad: this.willRestartDaemonOnLoad(targetDaemon, ctx.daemonState),
      loaded,
      remoteOnly: false,
      agentId: defaults.agentId,
      error: shipErr ?? defaults.error,
      updatedAt: release.updatedAt,
    };
  }

  async getSnapshot(input: {
    loadedChannel: string;
    loadedDigest: string | null;
    safeRenderer: boolean;
  }): Promise<EditableBranchesSnapshot> {
    const config = readLocalConfig(this.deps.configHome);
    const daemonState: EditableDaemonRuntimeState = this.deps.daemonController
      ? await this.deps.daemonController.getRunningState()
      : {
          running: false,
          listen: null,
          pid: null,
          runningDigest: this.deps.store.activeDaemonDigest,
          runningChannel: null,
        };
    const prodDaemonPtr = this.deps.store.getDaemonChannelPointer("prod");
    const ctx: SnapshotContext = {
      ...input,
      prodDaemonDigest: prodDaemonPtr?.digest ?? null,
      daemonState,
    };
    const main = this.buildMainEntry(config.baseBranch, ctx);
    const bySlug = new Map<string, EditableBranchEntry>();

    const indexed = readVerifiedWipIndex([this.deps.home, this.deps.configHome], () =>
      this.deps.store.publicKey(),
    );
    for (const ptr of indexed) {
      bySlug.set(ptr.slug, this.buildIndexedWipEntry(ptr, ctx));
    }

    const worktreesDir = path.join(this.deps.configHome, "worktrees");
    const repoDir = path.join(this.deps.configHome, "repo");
    const wtSlugs = existsSync(worktreesDir)
      ? readdirSync(worktreesDir, { withFileTypes: true })
          .filter((e) => e.isDirectory() && SLUG_RE.test(e.name))
          .map((e) => e.name)
          .sort()
      : [];

    const inspections = await Promise.all(
      wtSlugs.map((slug) =>
        inspectWorktree(repoDir, path.join(worktreesDir, slug), config.baseBranch, slug),
      ),
    );
    for (const info of inspections) {
      if (!info) continue;
      const entry = this.buildLocalWipEntry(info, bySlug.has(info.slug), ctx);
      if (entry) bySlug.set(info.slug, entry);
    }

    const branches = Array.from(bySlug.values()).sort((a, b) => {
      if (a.loaded !== b.loaded) return a.loaded ? -1 : 1;
      return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.slug.localeCompare(b.slug);
    });

    return {
      loadedChannel: input.loadedChannel,
      loadedDigest: input.loadedDigest,
      loadedDaemonDigest: daemonState.running
        ? daemonState.runningDigest
        : this.deps.store.activeDaemonDigest,
      daemonRunning: daemonState.running,
      daemonListen: daemonState.listen,
      mainDaemonGeneration: prodDaemonPtr?.generation ?? null,
      safeRenderer: input.safeRenderer,
      main,
      branches,
    };
  }

  async syncAll(options: { loadedChannel: string }): Promise<{ updated: boolean }> {
    if (this.deps.store.safe) return { updated: false };
    this.syncing ??= this.runSyncAll(options.loadedChannel).finally(() => {
      this.syncing = null;
    });
    return this.syncing;
  }

  private syncOptions() {
    return {
      home: this.deps.home,
      configHome: this.deps.configHome,
      publicKey: () => this.deps.store.publicKey(),
      isQuarantined: (digest: string) => this.deps.store.isQuarantined(digest),
      hasInstalledRelease: (digest: string) => this.deps.store.hasInstalledRelease(digest),
      isDaemonQuarantined: (digest: string) => this.deps.store.isDaemonQuarantined(digest),
      hasInstalledDaemonRelease: (digest: string) =>
        this.deps.store.hasInstalledDaemonRelease(digest),
      fetchImpl: this.deps.fetchImpl,
    };
  }

  private async runSyncAll(loadedChannel: string): Promise<{ updated: boolean }> {
    let anyUpdated = false;
    const common = this.syncOptions();

    try {
      const prodRes = await syncChannelFromCloudShelf({ ...common, channel: "prod" });
      if (prodRes?.updated) anyUpdated = true;
    } catch {
      // Offline or unconfigured Cloud Shelf — local releases still work
    }

    let wipPointers: WipBranchPointer[] = [];
    try {
      wipPointers = await syncWipIndexFromCloudShelf({
        home: this.deps.home,
        configHome: this.deps.configHome,
        publicKey: common.publicKey,
        fetchImpl: this.deps.fetchImpl,
      });
    } catch {
      wipPointers = [];
    }

    const channelsToSync = new Set<string>();
    if (loadedChannel !== "prod" && CHANNEL_RE.test(loadedChannel)) {
      channelsToSync.add(loadedChannel);
    }
    for (const ptr of wipPointers) {
      if (ptr.releaseDigest || ptr.daemonReleaseDigest) channelsToSync.add(ptr.channel);
    }

    for (const channel of channelsToSync) {
      try {
        const res = await syncChannelFromCloudShelf({ ...common, channel });
        if (res?.updated) anyUpdated = true;
      } catch {
        // Ignore individual WIP channel fetch failures
      }
    }

    return { updated: anyUpdated };
  }

  private async ensureChannelSynced(channel: string): Promise<void> {
    const uiPtr = this.deps.store.getChannelPointer(channel);
    const daemonPtr = this.deps.store.getDaemonChannelPointer(channel);
    const missingUi = uiPtr && !this.deps.store.hasInstalledRelease(uiPtr.digest);
    const missingDaemon = daemonPtr && !this.deps.store.hasInstalledDaemonRelease(daemonPtr.digest);
    if (!uiPtr || !daemonPtr || missingUi || missingDaemon) {
      await syncChannelFromCloudShelf({ ...this.syncOptions(), channel }).catch(() => null);
    }
  }

  private async applyTargetDaemon(
    targetDaemonDigest: string | null,
    channel: string,
    generation?: number,
  ): Promise<boolean> {
    if (this.deps.daemonController) {
      const swapRes = await this.deps.daemonController.applyDaemonTarget({
        targetDigest: targetDaemonDigest,
        channel,
        generation,
      });
      if (!swapRes.ok) {
        throw new Error(swapRes.error ?? "Failed to swap dev daemon");
      }
      return swapRes.swapped;
    }
    if (targetDaemonDigest !== this.deps.store.activeDaemonDigest) {
      this.deps.store.switchDaemonRelease(targetDaemonDigest, generation, channel);
    }
    return false;
  }

  async loadBranch(
    channel: string,
    options?: { currentLoadedDigest?: string | null },
  ): Promise<LoadBranchResult> {
    if (!CHANNEL_RE.test(channel)) {
      throw new Error(`Invalid branch channel: ${channel}`);
    }
    await this.ensureChannelSynced(channel);
    if (channel !== "prod") {
      await this.ensureChannelSynced("prod");
    }

    const channelUiPtr = this.deps.store.getChannelPointer(channel);
    const channelDaemonPtr = this.deps.store.getDaemonChannelPointer(channel);
    if (channel !== "prod" && !channelUiPtr && !channelDaemonPtr) {
      throw new Error(`No signed UI or Daemon build is ready for ${channel} yet`);
    }

    const prodUiPtr = this.deps.store.getChannelPointer("prod");
    const prodDaemonPtr = this.deps.store.getDaemonChannelPointer("prod");
    const targetUiPtr = channelUiPtr ?? prodUiPtr;
    const targetDaemonDigest = (channelDaemonPtr ?? prodDaemonPtr)?.digest ?? null;
    const daemonSwapped = await this.applyTargetDaemon(
      targetDaemonDigest,
      channel,
      channel === "prod" ? prodDaemonPtr?.generation : undefined,
    );

    const prevUiDigest =
      options?.currentLoadedDigest !== undefined
        ? options.currentLoadedDigest
        : this.deps.store.activeRelease.releaseDigest;
    const release = this.deps.store.switchToChannel(
      channel,
      targetUiPtr?.digest ?? null,
      channel === "prod" ? prodUiPtr?.generation : undefined,
    );
    return {
      release,
      channel,
      uiChanged: release.releaseDigest !== prevUiDigest,
      daemonSwapped,
    };
  }

  private async shouldAutoLoadAfterShip(input: {
    slug: string;
    loadedChannel: string;
    fastForwarded: boolean;
    publishedUiDigest: string | null;
    publishedDaemonDigest: string | null;
  }): Promise<boolean> {
    if (!input.fastForwarded) return false;
    const onWip = input.loadedChannel === `wip-${input.slug}`;
    if (input.loadedChannel !== "prod" && !onWip) return false;
    if (input.publishedDaemonDigest && this.deps.daemonController) {
      const runningState = await this.deps.daemonController.getRunningState();
      if (runningState.running && runningState.runningDigest !== input.publishedDaemonDigest) {
        return false;
      }
    }
    return Boolean(input.publishedUiDigest || (input.publishedDaemonDigest && onWip));
  }

  async shipBranch(slug: string, options: { loadedChannel: string }): Promise<ShipBranchResult> {
    if (!SLUG_RE.test(slug)) {
      return { ok: false, error: `Invalid branch slug: ${slug}` };
    }
    if (this.shippingSlugs.has(slug)) {
      return { ok: false, error: `${slug} is already shipping` };
    }
    this.shippingSlugs.add(slug);
    this.shipErrors.delete(slug);
    try {
      const stdout = await this.runCli(["ship", slug, "--upload", "--json"]);
      const parsed = JSON.parse(stdout) as {
        ok?: boolean;
        fastForwarded?: boolean;
        electronPublish?: { releaseDigest?: string; generation?: number } | null;
        daemonPublish?: { releaseDigest?: string; generation?: number } | null;
      };
      if (!parsed.ok) {
        throw new Error("Ship verification failed");
      }

      await syncChannelFromCloudShelf({ ...this.syncOptions(), channel: "prod" }).catch(() => null);

      const fastForwarded = parsed.fastForwarded === true;
      const publishedUiDigest = parsed.electronPublish?.releaseDigest ?? null;
      const publishedDaemonDigest = parsed.daemonPublish?.releaseDigest ?? null;
      const shouldAutoLoad = await this.shouldAutoLoadAfterShip({
        slug,
        loadedChannel: options.loadedChannel,
        fastForwarded,
        publishedUiDigest,
        publishedDaemonDigest,
      });

      return {
        ok: true,
        fastForwarded,
        releaseDigest: publishedUiDigest,
        daemonReleaseDigest: publishedDaemonDigest,
        generation: parsed.electronPublish?.generation ?? parsed.daemonPublish?.generation,
        shouldAutoLoad,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.shipErrors.set(slug, message);
      return { ok: false, error: message };
    } finally {
      this.shippingSlugs.delete(slug);
    }
  }

  async createBranch(input: {
    slug: string;
    summary?: string;
    agentId?: string;
  }): Promise<CreateBranchResult> {
    if (!SLUG_RE.test(input.slug)) {
      return { ok: false, error: `Invalid branch slug: ${input.slug}` };
    }
    const worktreePath = path.join(this.deps.configHome, "worktrees", input.slug);
    if (existsSync(worktreePath)) {
      return {
        ok: true,
        slug: input.slug,
        branch: `ed/wip/${input.slug}`,
        worktreePath,
      };
    }
    const args = ["wip", "create", input.slug];
    if (input.summary) args.push("--summary", input.summary.slice(0, 120));
    if (input.agentId) args.push("--agent-id", input.agentId);
    args.push("--json");
    try {
      const stdout = await this.runCli(args);
      const parsed = JSON.parse(stdout) as {
        slug?: string;
        branch?: string;
        worktreeDir?: string;
      };
      return {
        ok: true,
        slug: parsed.slug ?? input.slug,
        branch: parsed.branch ?? `ed/wip/${input.slug}`,
        worktreePath: parsed.worktreeDir ?? worktreePath,
      };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  attachBranchAgent(slug: string, agentId: string): { ok: boolean; error?: string } {
    if (!SLUG_RE.test(slug) || !agentId.trim()) {
      return { ok: false, error: "Invalid branch slug or agentId" };
    }
    try {
      const existing = readLocalBranchMeta(this.deps.configHome, slug);
      const now = new Date().toISOString();
      const next: LocalBranchMeta = existing
        ? { ...existing, agentId, updatedAt: now }
        : {
            schemaVersion: 1,
            slug,
            branch: `ed/wip/${slug}`,
            channel: `wip-${slug}`,
            status: "working",
            summary: "",
            releaseDigest: null,
            daemonReleaseDigest: null,
            sourceSha: "",
            generation: null,
            uploadedToCloud: false,
            requiresDaemon: false,
            requiresNative: false,
            agentId,
            error: null,
            updatedAt: now,
          };
      const dir = path.join(this.deps.configHome, "branches");
      mkdirSync(dir, { recursive: true });
      const filePath = path.join(dir, `${slug}.json`);
      const tmp = `${filePath}.${randomUUID()}.tmp`;
      writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      renameSync(tmp, filePath);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async discardBranch(slug: string): Promise<{ ok: boolean; error?: string }> {
    if (!SLUG_RE.test(slug)) {
      return { ok: false, error: `Invalid branch slug: ${slug}` };
    }
    try {
      await this.runCli(["wip", "rm", slug, "--delete-branch", "--upload", "--json"]);
      await rm(
        path.join(this.deps.home, "releases", "electron-web", "channels", `wip-${slug}.json`),
        { force: true },
      ).catch(() => undefined);
      this.shipErrors.delete(slug);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
