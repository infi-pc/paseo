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
import type { EditableReleaseStore, RendererRelease } from "./release-store.js";
import { wipIndexSchema, type WipBranchPointer } from "./schema.js";

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
  generation: number | null;
  sourceSha: string | null;
  hasChanges: boolean;
  behindMain: boolean;
  canFastForward: boolean;
  requiresDaemon: boolean;
  hasUpdate: boolean;
  loaded: boolean;
  remoteOnly: boolean;
  agentId: string | null;
  error: string | null;
  updatedAt: string | null;
}

export interface EditableBranchesSnapshot {
  loadedChannel: string;
  loadedDigest: string | null;
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
  generation?: number;
  shouldAutoLoad?: boolean;
  error?: string;
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
  userHome?: string;
  cliBin?: string;
  fetchImpl?: typeof fetch;
  execCli?: (args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
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

  private buildMainEntry(
    baseBranch: string,
    input: { loadedChannel: string; loadedDigest: string | null; safeRenderer: boolean },
  ): EditableBranchEntry {
    const prodPtr = this.deps.store.getChannelPointer("prod");
    const loaded = !input.safeRenderer && input.loadedChannel === "prod";
    return {
      slug: "main",
      channel: "prod",
      branch: baseBranch,
      isMain: true,
      status: "ready",
      summary: prodPtr?.summary ?? null,
      releaseDigest: prodPtr?.digest ?? null,
      generation: prodPtr?.generation ?? null,
      sourceSha: prodPtr?.sourceSha ?? null,
      hasChanges: false,
      behindMain: false,
      canFastForward: false,
      requiresDaemon: false,
      hasUpdate: this.hasDigestUpdate(loaded, prodPtr?.digest ?? null, input.loadedDigest),
      loaded,
      remoteOnly: false,
      agentId: null,
      error: null,
      updatedAt: prodPtr?.updatedAt ?? null,
    };
  }

  private buildIndexedWipEntry(
    ptr: WipBranchPointer,
    input: { loadedChannel: string; loadedDigest: string | null; safeRenderer: boolean },
  ): EditableBranchEntry {
    const channelPtr = this.deps.store.getChannelPointer(ptr.channel);
    const digest = channelPtr?.digest ?? ptr.releaseDigest;
    const loaded = !input.safeRenderer && input.loadedChannel === ptr.channel;
    let status: EditableBranchEntry["status"] = digest ? "ready" : "idle";
    if (this.shippingSlugs.has(ptr.slug)) status = "shipping";
    return {
      slug: ptr.slug,
      channel: ptr.channel,
      branch: ptr.branch,
      isMain: false,
      status,
      summary: channelPtr?.summary ?? (ptr.summary || null),
      releaseDigest: digest,
      generation: channelPtr?.generation ?? null,
      sourceSha: channelPtr?.sourceSha ?? ptr.sourceSha,
      hasChanges: Boolean(digest),
      behindMain: false,
      canFastForward: false,
      requiresDaemon: ptr.requiresDaemon,
      hasUpdate: this.hasDigestUpdate(loaded, digest, input.loadedDigest),
      loaded,
      remoteOnly: true,
      agentId: null,
      error: this.shipErrors.get(ptr.slug) ?? null,
      updatedAt: channelPtr?.updatedAt ?? ptr.updatedAt,
    };
  }

  private extractMetaDefaults(slug: string, meta: LocalBranchMeta | null) {
    if (!meta) {
      return {
        channel: `wip-${slug}`,
        digest: null as string | null,
        sha: null as string | null,
        branch: `ed/wip/${slug}`,
        summary: null as string | null,
        generation: null as number | null,
        requiresDaemon: false,
        agentId: null as string | null,
        error: null as string | null,
        updatedAt: null as string | null,
      };
    }
    return {
      channel: meta.channel,
      digest: meta.releaseDigest,
      sha: meta.sourceSha,
      branch: meta.branch,
      summary: meta.summary || null,
      generation: meta.generation,
      requiresDaemon: meta.requiresDaemon,
      agentId: meta.agentId,
      error: meta.error,
      updatedAt: meta.updatedAt || null,
    };
  }

  private mergeChannelRelease(
    channelPtr: ReturnType<EditableReleaseStore["getChannelPointer"]>,
    defaults: ReturnType<EditableBranchManager["extractMetaDefaults"]>,
  ) {
    if (!channelPtr) {
      return {
        releaseDigest: defaults.digest,
        releaseSha: defaults.sha,
        summary: defaults.summary,
        generation: defaults.generation,
        updatedAt: defaults.updatedAt,
      };
    }
    return {
      releaseDigest: channelPtr.digest,
      releaseSha: channelPtr.sourceSha,
      summary: channelPtr.summary ?? defaults.summary,
      generation: channelPtr.generation,
      updatedAt: channelPtr.updatedAt,
    };
  }

  private resolveLocalWipStatus(
    slug: string,
    meta: LocalBranchMeta | null,
    hasChanges: boolean,
    releaseMatchesHead: boolean,
    releaseDigest: string | null,
    shipErr: string | null,
  ): EditableBranchEntry["status"] {
    if (this.shippingSlugs.has(slug)) return "shipping";
    if (shipErr || meta?.status === "failed") return "failed";
    if (hasChanges && (releaseMatchesHead || (meta?.status === "ready" && releaseDigest))) {
      return "ready";
    }
    if (hasChanges) return "draft";
    return "idle";
  }

  private buildLocalWipEntry(
    info: GitWorktreeInspection,
    hasRemote: boolean,
    input: { loadedChannel: string; loadedDigest: string | null; safeRenderer: boolean },
  ): EditableBranchEntry | null {
    const meta = readLocalBranchMeta(this.deps.configHome, info.slug);
    const hasChanges = info.aheadOfMain > 0 || info.dirty;
    if (!hasChanges && !meta && !hasRemote) return null;

    const defaults = this.extractMetaDefaults(info.slug, meta);
    const channelPtr = this.deps.store.getChannelPointer(defaults.channel);
    const release = this.mergeChannelRelease(channelPtr, defaults);
    const releaseMatchesHead = Boolean(
      hasChanges && release.releaseDigest && release.releaseSha === info.headSha && !info.dirty,
    );
    const loaded = !input.safeRenderer && input.loadedChannel === defaults.channel;
    const shipErr = this.shipErrors.get(info.slug) ?? null;

    return {
      slug: info.slug,
      channel: defaults.channel,
      branch: defaults.branch,
      isMain: false,
      status: this.resolveLocalWipStatus(
        info.slug,
        meta,
        hasChanges,
        releaseMatchesHead,
        release.releaseDigest,
        shipErr,
      ),
      summary: release.summary,
      releaseDigest: hasChanges ? release.releaseDigest : null,
      generation: hasChanges ? release.generation : null,
      sourceSha: info.headSha,
      hasChanges,
      behindMain: info.behindMain > 0,
      canFastForward: hasChanges && info.behindMain === 0 && !info.dirty && releaseMatchesHead,
      requiresDaemon: defaults.requiresDaemon,
      hasUpdate: this.hasDigestUpdate(
        loaded,
        hasChanges ? release.releaseDigest : null,
        input.loadedDigest,
      ),
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
    const main = this.buildMainEntry(config.baseBranch, input);
    const bySlug = new Map<string, EditableBranchEntry>();

    const indexed = readVerifiedWipIndex([this.deps.home, this.deps.configHome], () =>
      this.deps.store.publicKey(),
    );
    for (const ptr of indexed) {
      bySlug.set(ptr.slug, this.buildIndexedWipEntry(ptr, input));
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
      const entry = this.buildLocalWipEntry(info, bySlug.has(info.slug), input);
      if (entry) bySlug.set(info.slug, entry);
    }

    const branches = Array.from(bySlug.values()).sort((a, b) => {
      if (a.loaded !== b.loaded) return a.loaded ? -1 : 1;
      return (b.updatedAt ?? "").localeCompare(a.updatedAt ?? "") || a.slug.localeCompare(b.slug);
    });

    return {
      loadedChannel: input.loadedChannel,
      loadedDigest: input.loadedDigest,
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

  private async runSyncAll(loadedChannel: string): Promise<{ updated: boolean }> {
    let anyUpdated = false;
    const common = {
      home: this.deps.home,
      configHome: this.deps.configHome,
      publicKey: () => this.deps.store.publicKey(),
      isQuarantined: (digest: string) => this.deps.store.isQuarantined(digest),
      hasInstalledRelease: (digest: string) => this.deps.store.hasInstalledRelease(digest),
      fetchImpl: this.deps.fetchImpl,
    };

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
      if (ptr.releaseDigest) channelsToSync.add(ptr.channel);
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

  async loadBranch(channel: string): Promise<{ release: RendererRelease; channel: string }> {
    if (!CHANNEL_RE.test(channel)) {
      throw new Error(`Invalid branch channel: ${channel}`);
    }
    let ptr = this.deps.store.getChannelPointer(channel);
    if (!ptr || !this.deps.store.hasInstalledRelease(ptr.digest)) {
      await syncChannelFromCloudShelf({
        home: this.deps.home,
        configHome: this.deps.configHome,
        channel,
        publicKey: () => this.deps.store.publicKey(),
        isQuarantined: (d) => this.deps.store.isQuarantined(d),
        hasInstalledRelease: (d) => this.deps.store.hasInstalledRelease(d),
        fetchImpl: this.deps.fetchImpl,
      }).catch(() => null);
      ptr = this.deps.store.getChannelPointer(channel);
    }
    if (!ptr) {
      if (channel === "prod") {
        const release = this.deps.store.switchToChannel("prod", null);
        return { release, channel: "prod" };
      }
      throw new Error(`No signed UI build is ready for ${channel} yet`);
    }
    const release = this.deps.store.switchToChannel(channel, ptr.digest, ptr.generation);
    return { release, channel };
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
      };
      if (!parsed.ok) {
        throw new Error("Ship verification failed");
      }

      // Sync prod channel cache locally so main immediately reflects the new generation
      await syncChannelFromCloudShelf({
        home: this.deps.home,
        configHome: this.deps.configHome,
        channel: "prod",
        publicKey: () => this.deps.store.publicKey(),
        isQuarantined: (d) => this.deps.store.isQuarantined(d),
        hasInstalledRelease: (d) => this.deps.store.hasInstalledRelease(d),
        fetchImpl: this.deps.fetchImpl,
      }).catch(() => null);

      const fastForwarded = parsed.fastForwarded === true;
      const shouldAutoLoad =
        fastForwarded &&
        (options.loadedChannel === "prod" || options.loadedChannel === `wip-${slug}`);

      return {
        ok: true,
        fastForwarded,
        releaseDigest: parsed.electronPublish?.releaseDigest ?? null,
        generation: parsed.electronPublish?.generation,
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
