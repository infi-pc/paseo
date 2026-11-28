#!/usr/bin/env node
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAEMON_RUNTIME_VERSION,
  DESKTOP_RUNTIME_VERSION,
  EDITABLE_READER_VERSION,
  EDITABLE_STATE_SCHEMA_VERSION,
  classifyPaseoImpact,
  computeKeyId,
  generateSigningKeyPair,
  getEditablePaths,
  readAndVerifyChannel,
  readDeviceState,
  readEditableConfig,
  resolveEditableHome,
  wipChannelName,
  writeJsonAtomic,
  type EditableConfig,
  type EditableHomePaths,
} from "@getpaseo/editable-core";
import {
  cancelWorktreeDepsBootstrap,
  commitWorktreeIfDirty,
  createGitRevert,
  createWipWorktree,
  ensureWorktreeDependencies,
  getChangedFiles,
  getHeadSha,
  initDedicatedClone,
  landWipBranch,
  listWipWorktrees,
  refreshBaseRepoDepsIfLockfileChanged,
  removeWipWorktree,
  runGit,
  spawnBackgroundDepsBootstrap,
  syncGitBaseBranch,
  validateSlug,
} from "./git.js";
import {
  claimWarmWorktree,
  invalidateWarmPool,
  spawnBackgroundWarmPool,
  warmWorktreePool,
} from "./warm-pool.js";
import {
  buildDaemonArtifact,
  buildElectronArtifact,
  loadExistingStagedRelease,
  publishChannelSurfaces,
  runConfidenceCheck,
  runScopedVerify,
  signAndPublishElectronLocal,
  signAndStageReleaseLocal,
  startLocalPreviewServer,
  stopLocalPreviewServer,
  type StagedSurfaceRelease,
} from "./runner.js";
import {
  deleteBranchMetadata,
  listBranchesSnapshot,
  publishWipIndex,
  readBranchMetadata,
  writeBranchMetadata,
  type LocalBranchMetadata,
} from "./branches.js";
import { syncElectronFromCloudShelf } from "./cloud-sync.js";
import { ensureExpoCodeSigningKeys, publishIosOtaUpdate } from "./ios-ota.js";
import { runAppInspectorCommand } from "./app-inspector.js";

const BOOLEAN_FLAGS = new Set([
  "json",
  "help",
  "force",
  "upload",
  "push",
  "skip-verify",
  "skip-export",
  "delete-branch",
  "keep-worktree",
  "packaged",
  "target",
  "full",
  "failed",
  "sync-deps",
  "force-electron",
  "force-daemon",
  "no-push",
  "skip-smoke",
]);

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

interface CliContext {
  positionals: string[];
  flags: Record<string, string | boolean>;
  json: boolean;
  paths: EditableHomePaths;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (token.startsWith("--")) {
      const eqIdx = token.indexOf("=");
      if (eqIdx !== -1) {
        flags[token.slice(2, eqIdx)] = token.slice(eqIdx + 1);
      } else {
        const key = token.slice(2);
        const next = argv[i + 1];
        if (!BOOLEAN_FLAGS.has(key) && next && !next.startsWith("--")) {
          flags[key] = next;
          i++;
        } else {
          flags[key] = true;
        }
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

function stringFlag(flags: Record<string, string | boolean>, key: string): string | undefined {
  const v = flags[key];
  return typeof v === "string" ? v : undefined;
}

function boolFlag(flags: Record<string, string | boolean>, key: string): boolean {
  return flags[key] === true || flags[key] === "true" || flags[key] === "1";
}

function emit(result: unknown, json: boolean): void {
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else if (typeof result === "string") {
    process.stdout.write(`${result}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}

function printHelp(): void {
  process.stdout.write(
    [
      "paseo-ed — Editable Paseo CLI",
      "",
      "Commands:",
      "  paseo-ed init [--repo <url-or-path>] [--branch paseo-customizations] [--workshop-port 6769] [--cloud-url <url>]",
      "  paseo-ed keygen [--force]",
      "  paseo-ed keygen-ios [--force]",
      "  paseo-ed status [--json]",
      "  paseo-ed branches [--json]",
      "  paseo-ed app <status|screenshot|dom|react|css|logs|network|perf|store> [--help]",
      "  paseo-ed workshop-setup [--json]",
      "  paseo-ed wip create <slug> [--summary <text>] [--agent-id <id>] [--from <ref>] [--json]",
      "  paseo-ed wip ls [--json]",
      "  paseo-ed wip rm <slug> [--delete-branch] [--upload] [--json]",
      "  paseo-ed impact [--worktree <slug-or-path>] [--base <ref>] [--json]",
      "  paseo-ed preview <slug> [--port 8089] [--json]",
      "  paseo-ed preview stop [--json]",
      "  paseo-ed verify <slug> [--json]",
      "  paseo-ed stage <slug> --summary <text> [--upload] [--skip-verify] [--skip-export] [--json]",
      "  paseo-ed build-electron <slug> --summary <text> [--out <dir>] [--skip-export] [--json]",
      "  paseo-ed build-daemon <slug> --summary <text> [--out <dir>] [--skip-export] [--json]",
      "  paseo-ed sign-publish <archive.tar.gz> --manifest <unsigned.json> [--channel prod] [--upload] [--json]",
      "  paseo-ed publish-ios-ota <slug> --runtime-version <ver> --summary <text> [--skip-export] [--json]",
      "  paseo-ed sync [--cloud-url <url>] [--channel prod] [--json]",
      "  paseo-ed ship <slug> [--summary <text>] [--push] [--upload] [--keep-worktree] [--skip-verify] [--skip-export] [--json]",
      "  paseo-ed rollback-local [--packaged] [--json]",
      "  paseo-ed revert <sha> [--push] [--json]",
    ].join("\n") + "\n",
  );
}

async function loadCloudEnvFile(home: string): Promise<void> {
  try {
    const cloudEnvRaw = await fs.readFile(path.join(home, "cloud.env"), "utf8");
    for (const line of cloudEnvRaw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim();
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {
    // Optional file
  }
}

async function ensureKeyPair(
  paths: EditableHomePaths,
  force = false,
): Promise<{ keyId: string; created: boolean; publicKeyPath: string }> {
  const exists = await fs
    .access(paths.privateKeyPath)
    .then(() => true)
    .catch(() => false);
  if (exists && !force) {
    const pub = await fs.readFile(paths.publicKeyPath, "utf8");
    return { keyId: computeKeyId(pub), created: false, publicKeyPath: paths.publicKeyPath };
  }
  const pair = generateSigningKeyPair();
  await fs.mkdir(paths.keysDir, { recursive: true, mode: 0o700 });
  await fs.writeFile(paths.privateKeyPath, pair.privateKeyPem, { encoding: "utf8", mode: 0o600 });
  await fs.writeFile(paths.publicKeyPath, pair.publicKeyPem, { encoding: "utf8", mode: 0o644 });
  return { keyId: pair.keyId, created: true, publicKeyPath: paths.publicKeyPath };
}

async function resolveWorktreeDir(paths: EditableHomePaths, slugOrPath: string): Promise<string> {
  if (slugOrPath.includes("/") || slugOrPath.startsWith(".")) {
    return path.resolve(slugOrPath);
  }
  const slug = validateSlug(slugOrPath);
  return path.join(paths.worktreesDir, slug);
}

async function ensureWorktreeDepsIfManaged(
  paths: EditableHomePaths,
  worktreeDir: string,
): Promise<void> {
  if (path.dirname(path.resolve(worktreeDir)) === path.resolve(paths.worktreesDir)) {
    await ensureWorktreeDependencies({
      repoDir: paths.repoDir,
      worktreeDir,
      editableHome: paths.home,
      slug: path.basename(worktreeDir),
    });
  }
}

function resolveCloudUploadParams(
  flags: Record<string, string | boolean>,
  config: EditableConfig | null,
): { cloudShelfUrl: string | null; cloudUploadToken: string | null } {
  const upload = boolFlag(flags, "upload");
  return {
    cloudShelfUrl: upload ? (config?.cloudShelfUrl ?? null) : null,
    cloudUploadToken: upload ? (process.env.EDITABLE_CLOUD_UPLOAD_TOKEN ?? null) : null,
  };
}

async function handleSync(ctx: CliContext): Promise<number> {
  const config = await readEditableConfig(ctx.paths.configPath);
  const cloudShelfUrl = stringFlag(ctx.flags, "cloud-url") ?? config?.cloudShelfUrl;
  if (!cloudShelfUrl) {
    throw new Error(
      "No cloudShelfUrl configured. Pass --cloud-url <url> or configure via `ed init`.",
    );
  }
  const channel = stringFlag(ctx.flags, "channel") ?? config?.channel ?? "prod";
  const res = await syncElectronFromCloudShelf({
    paths: ctx.paths,
    cloudShelfUrl,
    channel,
    readToken: process.env.EDITABLE_CLOUD_READ_TOKEN ?? null,
    expectedRuntimeVersion: config?.desktopRuntimeVersion ?? DESKTOP_RUNTIME_VERSION,
    expectedDaemonRuntimeVersion: config?.daemonRuntimeVersion ?? DAEMON_RUNTIME_VERSION,
  });
  emit({ ok: true, ...res }, ctx.json);
  return 0;
}

async function handlePublishIosOta(ctx: CliContext): Promise<number> {
  const target = ctx.positionals[1];
  const runtimeVersion = stringFlag(ctx.flags, "runtime-version");
  const summary = stringFlag(ctx.flags, "summary");
  if (!target || !runtimeVersion || !summary) {
    throw new Error(
      "Usage: ed publish-ios-ota <slug> --runtime-version <ver> --summary <text> [--skip-export]",
    );
  }
  const config = await readEditableConfig(ctx.paths.configPath);
  const cloudShelfUrl = stringFlag(ctx.flags, "cloud-url") ?? config?.cloudShelfUrl;
  const cloudUploadToken = process.env.EDITABLE_CLOUD_UPLOAD_TOKEN;
  if (!cloudShelfUrl || !cloudUploadToken) {
    throw new Error(
      "iOS OTA publish requires --cloud-url (or config.cloudShelfUrl) and EDITABLE_CLOUD_UPLOAD_TOKEN.",
    );
  }
  const worktreeDir = await resolveWorktreeDir(ctx.paths, target);
  const sourceSha = await getHeadSha(worktreeDir);
  const res = await publishIosOtaUpdate({
    paths: ctx.paths,
    worktreeDir,
    sourceSha,
    runtimeVersion,
    summary,
    channel: stringFlag(ctx.flags, "channel") ?? config?.channel ?? "prod",
    cloudShelfUrl,
    cloudUploadToken,
    skipExport: boolFlag(ctx.flags, "skip-export"),
  });
  emit({ ok: true, ...res }, ctx.json);
  return 0;
}

async function handleInit(ctx: CliContext): Promise<number> {
  const sourceRepoUrl = stringFlag(ctx.flags, "repo") ?? path.join(os.homedir(), "www", "paseo");
  const baseBranch = stringFlag(ctx.flags, "branch") ?? "paseo-customizations";
  const workshopPort = Number(stringFlag(ctx.flags, "workshop-port") ?? "6769");
  const workshopHome =
    stringFlag(ctx.flags, "workshop-home") ?? path.join(os.homedir(), ".paseo-workshop");
  const cloudShelfUrl = stringFlag(ctx.flags, "cloud-url") ?? null;
  const channel = stringFlag(ctx.flags, "channel") ?? "prod";

  const keyInfo = await ensureKeyPair(ctx.paths, false);
  const cloneInfo = await initDedicatedClone({
    sourceRepoUrl,
    repoDir: ctx.paths.repoDir,
    baseBranch,
  });

  const config: EditableConfig = {
    schemaVersion: EDITABLE_STATE_SCHEMA_VERSION,
    minReaderVersion: EDITABLE_READER_VERSION,
    sourceRepoUrl,
    baseBranch,
    workshopHome,
    workshopPort,
    desktopRuntimeVersion: DESKTOP_RUNTIME_VERSION,
    daemonRuntimeVersion: DAEMON_RUNTIME_VERSION,
    cloudShelfUrl,
    channel,
  };
  await writeJsonAtomic(ctx.paths.configPath, config);

  const existingState = await readDeviceState(ctx.paths.deviceStatePath);
  await writeJsonAtomic(ctx.paths.deviceStatePath, existingState);

  emit(
    {
      ok: true,
      home: ctx.paths.home,
      repoDir: ctx.paths.repoDir,
      headSha: cloneInfo.headSha,
      cloned: cloneInfo.cloned,
      keyId: keyInfo.keyId,
      keyCreated: keyInfo.created,
      config,
    },
    ctx.json,
  );
  return 0;
}

async function handleWorkshopSetup(ctx: CliContext): Promise<number> {
  const config = await readEditableConfig(ctx.paths.configPath);
  const workshopHome = config?.workshopHome ?? path.join(os.homedir(), ".paseo-workshop");
  const workshopPort = config?.workshopPort ?? 6769;
  await fs.mkdir(workshopHome, { recursive: true, mode: 0o700 });
  const workshopConfigPath = path.join(workshopHome, "config.json");
  const exists = await fs
    .access(workshopConfigPath)
    .then(() => true)
    .catch(() => false);
  if (!exists) {
    await writeJsonAtomic(
      workshopConfigPath,
      {
        daemon: {
          listen: `127.0.0.1:${workshopPort}`,
          relay: { enabled: false },
        },
      },
      0o600,
    );
  }
  emit(
    {
      ok: true,
      workshopHome,
      workshopPort,
      launchCommand: `PASEO_HOME="${workshopHome}" PASEO_LISTEN="127.0.0.1:${workshopPort}" paseo daemon run`,
      note: "Runs completely isolated from live ~/.paseo (:6767). Pair this host in Paseo Desktop as 'Workshop'.",
    },
    ctx.json,
  );
  return 0;
}

async function handleStatus(ctx: CliContext): Promise<number> {
  const config = await readEditableConfig(ctx.paths.configPath);
  const deviceState = await readDeviceState(ctx.paths.deviceStatePath);
  const worktrees = await listWipWorktrees(ctx.paths.repoDir, ctx.paths.worktreesDir);
  const pubKey = await fs.readFile(ctx.paths.publicKeyPath, "utf8").catch(() => null);
  const channelResult = pubKey
    ? await readAndVerifyChannel(ctx.paths.electronChannelPath, pubKey, 0)
    : { ok: false as const, error: "Signing key not initialized" };

  emit(
    {
      home: ctx.paths.home,
      initialized: config !== null,
      keyId: pubKey ? computeKeyId(pubKey) : null,
      config,
      deviceState,
      channel: channelResult.ok ? channelResult.envelope.payload : null,
      channelError: channelResult.ok ? null : channelResult.error,
      worktrees,
    },
    ctx.json,
  );
  return 0;
}

async function handleBranches(ctx: CliContext): Promise<number> {
  const config = await readEditableConfig(ctx.paths.configPath);
  if (!config) {
    throw new Error("Editable home is not initialized. Run `paseo-ed init` first.");
  }
  const snapshot = await listBranchesSnapshot(ctx.paths, config);
  emit(snapshot, ctx.json);
  return 0;
}

async function handleWipCreate(ctx: CliContext, config: EditableConfig): Promise<number> {
  const slug = ctx.positionals[2];
  if (!slug) throw new Error("Usage: paseo-ed wip create <slug>");
  const fromRef = stringFlag(ctx.flags, "from") ?? config.baseBranch;
  const syncDeps = boolFlag(ctx.flags, "sync-deps");
  const cliEntrypoint = fileURLToPath(import.meta.url);

  const claimed = await claimWarmWorktree({
    editableHome: ctx.paths.home,
    repoDir: ctx.paths.repoDir,
    worktreesDir: ctx.paths.worktreesDir,
    slug,
    fromRef,
  });
  const created = claimed
    ? claimed
    : {
        ...(await createWipWorktree({
          repoDir: ctx.paths.repoDir,
          worktreesDir: ctx.paths.worktreesDir,
          slug,
          fromRef,
          skipBootstrapDeps: !syncDeps,
        })),
        claimedWarmSlot: false,
      };

  await writeBranchMetadata(ctx.paths, {
    schemaVersion: 1,
    slug: created.slug,
    branch: created.branch,
    channel: wipChannelName(created.slug),
    title: stringFlag(ctx.flags, "title")?.trim().slice(0, 120) || null,
    icon: stringFlag(ctx.flags, "icon")?.trim().slice(0, 32) || null,
    status: "working",
    summary: stringFlag(ctx.flags, "summary") ?? "",
    releaseDigest: null,
    daemonReleaseDigest: null,
    services: [],
    sourceSha: created.baseSha,
    generation: null,
    uploadedToCloud: false,
    requiresDaemon: false,
    requiresNative: false,
    agentId: stringFlag(ctx.flags, "agent-id") ?? null,
    error: null,
    updatedAt: new Date().toISOString(),
  });

  const depsBootstrapping =
    created.depsBootstrapped || syncDeps
      ? false
      : await spawnBackgroundDepsBootstrap({
          editableHome: ctx.paths.home,
          repoDir: ctx.paths.repoDir,
          slug: created.slug,
          cliEntrypoint,
        }).catch(() => false);

  const warmingNextSlot = await spawnBackgroundWarmPool({
    editableHome: ctx.paths.home,
    cliEntrypoint,
  }).catch(() => false);

  emit({ ...created, depsBootstrapping, warmingNextSlot }, ctx.json);
  return 0;
}

async function handleWip(ctx: CliContext): Promise<number> {
  const sub = ctx.positionals[1];
  const config = await readEditableConfig(ctx.paths.configPath);
  if (!config) {
    throw new Error("Editable home is not initialized. Run `paseo-ed init` first.");
  }
  if (sub === "ls") {
    const worktrees = await listWipWorktrees(ctx.paths.repoDir, ctx.paths.worktreesDir);
    emit({ worktrees }, ctx.json);
    return 0;
  }
  if (sub === "create") {
    return handleWipCreate(ctx, config);
  }
  if (sub === "warm") {
    const fromRef = stringFlag(ctx.flags, "from") ?? config.baseBranch;
    const result = await warmWorktreePool({
      editableHome: ctx.paths.home,
      repoDir: ctx.paths.repoDir,
      fromRef,
    });
    emit({ ok: true, ...result }, ctx.json);
    return 0;
  }
  if (sub === "bootstrap-deps") {
    const slug = ctx.positionals[2];
    if (!slug) throw new Error("Usage: paseo-ed wip bootstrap-deps <slug>");
    const cleanSlug = validateSlug(slug);
    const worktreeDir = await resolveWorktreeDir(ctx.paths, cleanSlug);
    const bootstrapped = await ensureWorktreeDependencies({
      repoDir: ctx.paths.repoDir,
      worktreeDir,
      editableHome: ctx.paths.home,
      slug: cleanSlug,
    });
    emit({ ok: true, slug: cleanSlug, bootstrapped }, ctx.json);
    return 0;
  }
  if (sub === "rm") {
    const slug = ctx.positionals[2];
    if (!slug) throw new Error("Usage: paseo-ed wip rm <slug>");
    const cleanSlug = validateSlug(slug);
    await cancelWorktreeDepsBootstrap(ctx.paths.home, cleanSlug);
    await removeWipWorktree({
      repoDir: ctx.paths.repoDir,
      worktreesDir: ctx.paths.worktreesDir,
      slug: cleanSlug,
      deleteBranch: boolFlag(ctx.flags, "delete-branch"),
    });
    await deleteBranchMetadata(ctx.paths, cleanSlug);
    const { cloudShelfUrl, cloudUploadToken } = resolveCloudUploadParams(ctx.flags, config);
    await publishWipIndex({
      paths: ctx.paths,
      cloudShelfUrl,
      cloudUploadToken,
    }).catch(() => undefined);
    emit({ ok: true, removed: cleanSlug }, ctx.json);
    return 0;
  }
  throw new Error(`Unknown wip subcommand: ${String(sub)}`);
}

async function handleImpact(ctx: CliContext): Promise<number> {
  const config = await readEditableConfig(ctx.paths.configPath);
  const target = stringFlag(ctx.flags, "worktree") ?? ctx.positionals[1];
  if (!target) throw new Error("Usage: ed impact --worktree <slug-or-path>");
  const worktreeDir = await resolveWorktreeDir(ctx.paths, target);
  const baseRef = stringFlag(ctx.flags, "base") ?? config?.baseBranch ?? "paseo-customizations";
  const changed = await getChangedFiles(worktreeDir, baseRef);
  emit(classifyPaseoImpact(changed), ctx.json);
  return 0;
}

async function handlePreview(ctx: CliContext): Promise<number> {
  const sub = ctx.positionals[1];
  if (!sub) throw new Error("Usage: ed preview <slug> | ed preview stop");
  if (sub === "stop") {
    emit(await stopLocalPreviewServer(ctx.paths), ctx.json);
    return 0;
  }
  const worktreeDir = await resolveWorktreeDir(ctx.paths, sub);
  await ensureWorktreeDepsIfManaged(ctx.paths, worktreeDir);
  const port = Number(stringFlag(ctx.flags, "port") ?? "8089");
  emit(await startLocalPreviewServer({ paths: ctx.paths, worktreeDir, port }), ctx.json);
  return 0;
}

async function handleVerify(ctx: CliContext): Promise<number> {
  const config = await readEditableConfig(ctx.paths.configPath);
  const target = ctx.positionals[1];
  if (!target) throw new Error("Usage: ed verify <slug>");
  const worktreeDir = await resolveWorktreeDir(ctx.paths, target);
  await ensureWorktreeDepsIfManaged(ctx.paths, worktreeDir);
  const baseRef = stringFlag(ctx.flags, "base") ?? config?.baseBranch ?? "paseo-customizations";
  const changed = await getChangedFiles(worktreeDir, baseRef);
  const impact = classifyPaseoImpact(changed);
  const result = await runScopedVerify(worktreeDir, impact);
  emit({ impact, ...result }, ctx.json);
  return result.ok ? 0 : 1;
}

async function handleBuildSurface(
  ctx: CliContext,
  surface: "electron-web" | "daemon",
): Promise<number> {
  const target = ctx.positionals[1];
  const usage =
    surface === "daemon"
      ? "Usage: paseo-ed build-daemon <slug> --summary <text>"
      : "Usage: ed build-electron <slug> --summary <text>";
  if (!target) throw new Error(usage);
  const worktreeDir = await resolveWorktreeDir(ctx.paths, target);
  const skipExport = boolFlag(ctx.flags, "skip-export");
  if (!skipExport) {
    await ensureWorktreeDepsIfManaged(ctx.paths, worktreeDir);
  }
  const summary =
    stringFlag(ctx.flags, "summary") ??
    (surface === "daemon"
      ? `Editable daemon build from ${target}`
      : `Editable build from ${target}`);
  const sourceSha = await getHeadSha(worktreeDir);
  const defaultOut = path.join(
    ctx.paths.home,
    "staging",
    surface === "daemon" ? `daemon-${target}-${Date.now()}` : `${target}-${Date.now()}`,
  );
  const outputDir = stringFlag(ctx.flags, "out") ?? defaultOut;
  const built =
    surface === "daemon"
      ? await buildDaemonArtifact({ worktreeDir, sourceSha, summary, outputDir, skipExport })
      : await buildElectronArtifact({ worktreeDir, sourceSha, summary, outputDir, skipExport });
  emit(built, ctx.json);
  return 0;
}

async function handleSignPublish(ctx: CliContext): Promise<number> {
  const archivePath = ctx.positionals[1];
  const manifestPath = stringFlag(ctx.flags, "manifest");
  if (!archivePath || !manifestPath) {
    throw new Error("Usage: ed sign-publish <archive.tar.gz> --manifest <unsigned.json>");
  }
  const config = await readEditableConfig(ctx.paths.configPath);
  const channel = stringFlag(ctx.flags, "channel") ?? config?.channel ?? "prod";
  const rawManifest = JSON.parse(await fs.readFile(path.resolve(manifestPath), "utf8")) as {
    surface?: unknown;
  };
  const expectedRuntimeVersion =
    rawManifest.surface === "daemon"
      ? (config?.daemonRuntimeVersion ?? DAEMON_RUNTIME_VERSION)
      : (config?.desktopRuntimeVersion ?? DESKTOP_RUNTIME_VERSION);
  const { cloudShelfUrl, cloudUploadToken } = resolveCloudUploadParams(ctx.flags, config);
  const res = await signAndPublishElectronLocal({
    paths: ctx.paths,
    archivePath: path.resolve(archivePath),
    unsignedManifestPath: path.resolve(manifestPath),
    channel,
    expectedRuntimeVersion,
    cloudShelfUrl,
    cloudUploadToken,
  });
  emit(
    {
      ok: true,
      surface: res.surface,
      releaseDigest: res.releaseDigest,
      generation: res.generation,
      releaseDir: res.releaseDir,
      channelPath: res.channelPath,
      uploadedToCloud: res.uploadedToCloud,
    },
    ctx.json,
  );
  return 0;
}

async function buildAndStageSurface(input: {
  paths: EditableHomePaths;
  surface: "electron-web" | "daemon";
  worktreeDir: string;
  sourceSha: string;
  summary: string;
  stagingPrefix: string;
  runtimeVersion: string;
  skipExport: boolean;
  cloudShelfUrl: string | null;
  cloudUploadToken: string | null;
}): Promise<StagedSurfaceRelease> {
  const outputDir = path.join(input.paths.home, "staging", `${input.stagingPrefix}-${Date.now()}`);
  const built =
    input.surface === "daemon"
      ? await buildDaemonArtifact({
          worktreeDir: input.worktreeDir,
          sourceSha: input.sourceSha,
          summary: input.summary,
          outputDir,
          runtimeVersion: input.runtimeVersion,
          skipExport: input.skipExport,
        })
      : await buildElectronArtifact({
          worktreeDir: input.worktreeDir,
          sourceSha: input.sourceSha,
          summary: input.summary,
          outputDir,
          runtimeVersion: input.runtimeVersion,
          skipExport: input.skipExport,
        });
  return signAndStageReleaseLocal({
    paths: input.paths,
    archivePath: built.archivePath,
    unsignedManifestPath: built.unsignedManifestPath,
    expectedSurface: input.surface,
    expectedRuntimeVersion: input.runtimeVersion,
    cloudShelfUrl: input.cloudShelfUrl,
    cloudUploadToken: input.cloudUploadToken,
  });
}

async function stageSurfacesForBranch(input: {
  paths: EditableHomePaths;
  config: EditableConfig;
  slug: string;
  worktreeDir: string;
  wipSha: string;
  summary: string;
  wantsElectron: boolean;
  wantsDaemon: boolean;
  skipExport: boolean;
  cloudShelfUrl: string | null;
  cloudUploadToken: string | null;
}): Promise<StagedSurfaceRelease[]> {
  const staged: StagedSurfaceRelease[] = [];
  if (input.wantsElectron) {
    staged.push(
      await buildAndStageSurface({
        paths: input.paths,
        surface: "electron-web",
        worktreeDir: input.worktreeDir,
        sourceSha: input.wipSha,
        summary: input.summary,
        stagingPrefix: `${input.slug}-${input.wipSha.slice(0, 12)}`,
        runtimeVersion: input.config.desktopRuntimeVersion,
        skipExport: input.skipExport,
        cloudShelfUrl: input.cloudShelfUrl,
        cloudUploadToken: input.cloudUploadToken,
      }),
    );
  }
  if (input.wantsDaemon) {
    staged.push(
      await buildAndStageSurface({
        paths: input.paths,
        surface: "daemon",
        worktreeDir: input.worktreeDir,
        sourceSha: input.wipSha,
        summary: input.summary,
        stagingPrefix: `daemon-${input.slug}-${input.wipSha.slice(0, 12)}`,
        runtimeVersion: input.config.daemonRuntimeVersion ?? DAEMON_RUNTIME_VERSION,
        skipExport: input.skipExport,
        cloudShelfUrl: input.cloudShelfUrl,
        cloudUploadToken: input.cloudUploadToken,
      }),
    );
  }
  return staged;
}

function summarizeStagePublish(
  surfaces: StagedSurfaceRelease[],
  published: { generation: number; uploadedToCloud: boolean } | null,
  channel: string,
) {
  const ui = surfaces.find((s) => s.surface === "electron-web");
  const daemon = surfaces.find((s) => s.surface === "daemon");
  const electronPublish =
    ui && published
      ? {
          releaseDigest: ui.releaseDigest,
          generation: published.generation,
          channel,
          uploadedToCloud: published.uploadedToCloud,
        }
      : null;
  const daemonPublish =
    daemon && published
      ? {
          releaseDigest: daemon.releaseDigest,
          generation: published.generation,
          channel,
          uploadedToCloud: published.uploadedToCloud,
        }
      : null;
  return { electronPublish, daemonPublish };
}

function resolveOptionalLabel(
  flags: Record<string, string | boolean>,
  key: string,
  maxLen: number,
  fallback: string | null | undefined,
): string | null {
  const explicit = stringFlag(flags, key)?.trim();
  if (explicit) return explicit.slice(0, maxLen);
  return fallback || null;
}

function buildStageBranchMetadata(input: {
  slug: string;
  channel: string;
  title: string | null;
  icon: string | null;
  status: "ready" | "failed";
  summary: string;
  wipSha: string;
  impact: ReturnType<typeof classifyPaseoImpact>;
  existingMeta: LocalBranchMetadata | null;
  releaseDigest: string | null;
  daemonReleaseDigest: string | null;
  generation: number | null;
  uploadedToCloud: boolean;
  error: string | null;
}): LocalBranchMetadata {
  return {
    schemaVersion: 1,
    slug: input.slug,
    branch: `ed/wip/${input.slug}`,
    channel: input.channel,
    title: input.title,
    icon: input.icon,
    status: input.status,
    summary: input.summary,
    releaseDigest: input.releaseDigest,
    daemonReleaseDigest: input.daemonReleaseDigest,
    services: input.impact.services,
    sourceSha: input.wipSha,
    generation: input.generation,
    uploadedToCloud: input.uploadedToCloud,
    requiresDaemon: input.impact.requiresDaemonRelease,
    requiresNative: input.impact.requiresNativeRebuild,
    agentId: input.existingMeta ? input.existingMeta.agentId : null,
    error: input.error,
    updatedAt: new Date().toISOString(),
  };
}

async function recordStageFailure(input: {
  paths: EditableHomePaths;
  slug: string;
  channel: string;
  title: string | null;
  icon: string | null;
  summary: string;
  wipSha: string;
  impact: ReturnType<typeof classifyPaseoImpact>;
  existingMeta: LocalBranchMetadata | null;
}): Promise<void> {
  await writeBranchMetadata(
    input.paths,
    buildStageBranchMetadata({
      ...input,
      status: "failed",
      releaseDigest: input.existingMeta ? input.existingMeta.releaseDigest : null,
      daemonReleaseDigest: input.existingMeta ? input.existingMeta.daemonReleaseDigest : null,
      generation: input.existingMeta ? input.existingMeta.generation : null,
      uploadedToCloud: input.existingMeta ? input.existingMeta.uploadedToCloud : false,
      error: "Verification failed",
    }),
  );
}

async function recordStageSuccess(input: {
  paths: EditableHomePaths;
  slug: string;
  channel: string;
  title: string | null;
  icon: string | null;
  summary: string;
  wipSha: string;
  impact: ReturnType<typeof classifyPaseoImpact>;
  existingMeta: LocalBranchMetadata | null;
  electronPublish: { releaseDigest: string } | null;
  daemonPublish: { releaseDigest: string } | null;
  published: { generation: number; uploadedToCloud: boolean } | null;
}): Promise<void> {
  await writeBranchMetadata(
    input.paths,
    buildStageBranchMetadata({
      slug: input.slug,
      channel: input.channel,
      title: input.title,
      icon: input.icon,
      status: "ready",
      summary: input.summary,
      wipSha: input.wipSha,
      impact: input.impact,
      existingMeta: input.existingMeta,
      releaseDigest: input.electronPublish?.releaseDigest ?? null,
      daemonReleaseDigest: input.daemonPublish?.releaseDigest ?? null,
      generation: input.published?.generation ?? input.existingMeta?.generation ?? null,
      uploadedToCloud: input.published?.uploadedToCloud ?? false,
      error: null,
    }),
  );
}

async function handleStage(ctx: CliContext): Promise<number> {
  const target = ctx.positionals[1];
  const summary = stringFlag(ctx.flags, "summary");
  if (!target || !summary) {
    throw new Error(
      "Usage: paseo-ed stage <slug> --summary <text> [--upload] [--skip-verify] [--skip-export]",
    );
  }
  const config = await readEditableConfig(ctx.paths.configPath);
  if (!config) throw new Error("Run `paseo-ed init` first.");

  const slug = validateSlug(target);
  const worktreeDir = await resolveWorktreeDir(ctx.paths, slug);
  const channel = wipChannelName(slug);
  const existingMeta = await readBranchMetadata(ctx.paths, slug);
  const title = resolveOptionalLabel(ctx.flags, "title", 120, existingMeta?.title);
  const icon = resolveOptionalLabel(ctx.flags, "icon", 32, existingMeta?.icon);

  const { headSha: wipSha } = await commitWorktreeIfDirty(worktreeDir, summary);
  const changed = await getChangedFiles(worktreeDir, config.baseBranch);
  const impact = classifyPaseoImpact(changed);

  const wantsElectron = impact.canPublishElectronRenderer || boolFlag(ctx.flags, "force-electron");
  const wantsDaemon = impact.canPublishDaemon || boolFlag(ctx.flags, "force-daemon");
  const skipVerify = boolFlag(ctx.flags, "skip-verify");
  const skipExport = boolFlag(ctx.flags, "skip-export");
  if (!skipVerify || (!skipExport && (wantsElectron || wantsDaemon))) {
    await ensureWorktreeDependencies({
      repoDir: ctx.paths.repoDir,
      worktreeDir,
      editableHome: ctx.paths.home,
      slug,
    });
  }

  if (!skipVerify) {
    const verified = await runScopedVerify(worktreeDir, impact);
    if (!verified.ok) {
      await recordStageFailure({
        paths: ctx.paths,
        slug,
        channel,
        title,
        icon,
        summary,
        wipSha,
        impact,
        existingMeta,
      });
      emit({ ok: false, stage: "verify", impact, checks: verified.checks }, ctx.json);
      return 1;
    }
  }

  const { cloudShelfUrl, cloudUploadToken } = resolveCloudUploadParams(ctx.flags, config);
  const stagedSurfaces = await stageSurfacesForBranch({
    paths: ctx.paths,
    config,
    slug,
    worktreeDir,
    wipSha,
    summary,
    wantsElectron,
    wantsDaemon,
    skipExport,
    cloudShelfUrl,
    cloudUploadToken,
  });

  const published =
    stagedSurfaces.length > 0
      ? await publishChannelSurfaces({
          paths: ctx.paths,
          channel,
          defaultChannel: config.channel,
          surfaces: stagedSurfaces,
          preserveExistingSurfaces: false,
          updateDeviceState: false,
          cloudShelfUrl,
          cloudUploadToken,
        })
      : null;

  const { electronPublish, daemonPublish } = summarizeStagePublish(
    stagedSurfaces,
    published,
    channel,
  );
  await recordStageSuccess({
    paths: ctx.paths,
    slug,
    channel,
    title,
    icon,
    summary,
    wipSha,
    impact,
    existingMeta,
    electronPublish,
    daemonPublish,
    published,
  });

  const wipIndex = await publishWipIndex({
    paths: ctx.paths,
    cloudShelfUrl,
    cloudUploadToken,
  });

  emit(
    {
      ok: true,
      slug,
      channel,
      sourceSha: wipSha,
      impact,
      electronPublish,
      daemonPublish,
      wipIndexGeneration: wipIndex.generation,
    },
    ctx.json,
  );
  return 0;
}

async function prepareShipSurface(input: {
  paths: EditableHomePaths;
  surface: "electron-web" | "daemon";
  worktreeDir: string;
  landedSha: string;
  fastForwarded: boolean;
  existingMeta: LocalBranchMetadata | null;
  summary: string;
  runtimeVersion: string;
  skipExport: boolean;
  cloudShelfUrl: string | null;
  cloudUploadToken: string | null;
  ensureDepsOnce: () => Promise<void>;
}): Promise<{ staged: StagedSurfaceRelease; reused: boolean }> {
  const existingDigest =
    input.surface === "daemon"
      ? input.existingMeta?.daemonReleaseDigest
      : input.existingMeta?.releaseDigest;
  const canReuse =
    input.fastForwarded &&
    Boolean(existingDigest) &&
    input.existingMeta?.sourceSha === input.landedSha;
  if (canReuse && existingDigest) {
    const staged = await loadExistingStagedRelease({
      paths: input.paths,
      surface: input.surface,
      releaseDigest: existingDigest,
      expectedSourceSha: input.landedSha,
      summary: input.summary,
      expectedRuntimeVersion: input.runtimeVersion,
      cloudShelfUrl: input.cloudShelfUrl,
      cloudUploadToken: input.cloudUploadToken,
      alreadyUploadedToCloud: input.existingMeta?.uploadedToCloud,
    });
    return { staged, reused: true };
  }
  await input.ensureDepsOnce();
  const staged = await buildAndStageSurface({
    paths: input.paths,
    surface: input.surface,
    worktreeDir: input.worktreeDir,
    sourceSha: input.landedSha,
    summary: input.summary,
    stagingPrefix:
      input.surface === "daemon"
        ? `daemon-${input.landedSha.slice(0, 12)}`
        : input.landedSha.slice(0, 12),
    runtimeVersion: input.runtimeVersion,
    skipExport: input.skipExport,
    cloudShelfUrl: input.cloudShelfUrl,
    cloudUploadToken: input.cloudUploadToken,
  });
  return { staged, reused: false };
}

async function verifyBeforeShip(input: {
  paths: EditableHomePaths;
  slug: string | null;
  worktreeDir: string;
  existingMeta: LocalBranchMetadata | null;
  impact: ReturnType<typeof classifyPaseoImpact>;
  skipVerify: boolean;
}) {
  if (input.skipVerify) return { ok: true as const };
  const headBeforeLand = await getHeadSha(input.worktreeDir);
  const isDirtyBeforeLand = (await runGit(["status", "--porcelain"], input.worktreeDir)).length > 0;
  const alreadyVerified =
    !isDirtyBeforeLand &&
    input.existingMeta?.status === "ready" &&
    input.existingMeta.sourceSha === headBeforeLand;
  if (alreadyVerified) return { ok: true as const };
  if (input.slug) {
    await ensureWorktreeDependencies({
      repoDir: input.paths.repoDir,
      worktreeDir: input.worktreeDir,
      editableHome: input.paths.home,
      slug: input.slug,
    });
  }
  return runScopedVerify(input.worktreeDir, input.impact);
}

async function cleanupAfterShip(input: {
  paths: EditableHomePaths;
  slug: string | null;
  keepWorktree: boolean;
  landedSha: string;
  changedFiles: string[];
  cloudShelfUrl: string | null;
  cloudUploadToken: string | null;
}): Promise<boolean> {
  let cleanedWorktree = false;
  if (input.slug && !input.keepWorktree) {
    await cancelWorktreeDepsBootstrap(input.paths.home, input.slug);
    await removeWipWorktree({
      repoDir: input.paths.repoDir,
      worktreesDir: input.paths.worktreesDir,
      slug: input.slug,
      deleteBranch: true,
    }).catch(() => undefined);
    await deleteBranchMetadata(input.paths, input.slug);
    await publishWipIndex({
      paths: input.paths,
      cloudShelfUrl: input.cloudShelfUrl,
      cloudUploadToken: input.cloudUploadToken,
    }).catch(() => undefined);
    cleanedWorktree = true;
  }

  const baseDepsRefreshed = await refreshBaseRepoDepsIfLockfileChanged({
    repoDir: input.paths.repoDir,
    landedSha: input.landedSha,
    changedFiles: input.changedFiles,
  }).catch(() => false);
  if (baseDepsRefreshed) {
    await invalidateWarmPool(input.paths.home, input.paths.repoDir).catch(() => undefined);
  }
  void spawnBackgroundWarmPool({
    editableHome: input.paths.home,
    cliEntrypoint: fileURLToPath(import.meta.url),
  }).catch(() => undefined);
  return cleanedWorktree;
}

async function publishShipSurfaces(input: {
  paths: EditableHomePaths;
  config: EditableConfig;
  slug: string | null;
  worktreeDir: string;
  landedSha: string;
  fastForwarded: boolean;
  existingMeta: LocalBranchMetadata | null;
  summary: string;
  wantsElectron: boolean;
  wantsDaemon: boolean;
  skipExport: boolean;
  cloudShelfUrl: string | null;
  cloudUploadToken: string | null;
}) {
  let ensuredDeps = false;
  const ensureDepsOnce = async () => {
    if (ensuredDeps || input.skipExport || !input.slug) return;
    await ensureWorktreeDependencies({
      repoDir: input.paths.repoDir,
      worktreeDir: input.worktreeDir,
      editableHome: input.paths.home,
      slug: input.slug,
    });
    ensuredDeps = true;
  };

  const surfacesToPublish: StagedSurfaceRelease[] = [];
  let reusedElectron = false;
  let reusedDaemon = false;
  if (input.wantsElectron) {
    const res = await prepareShipSurface({
      paths: input.paths,
      surface: "electron-web",
      worktreeDir: input.worktreeDir,
      landedSha: input.landedSha,
      fastForwarded: input.fastForwarded,
      existingMeta: input.existingMeta,
      summary: input.summary,
      runtimeVersion: input.config.desktopRuntimeVersion,
      skipExport: input.skipExport,
      cloudShelfUrl: input.cloudShelfUrl,
      cloudUploadToken: input.cloudUploadToken,
      ensureDepsOnce,
    });
    surfacesToPublish.push(res.staged);
    reusedElectron = res.reused;
  }
  if (input.wantsDaemon) {
    const res = await prepareShipSurface({
      paths: input.paths,
      surface: "daemon",
      worktreeDir: input.worktreeDir,
      landedSha: input.landedSha,
      fastForwarded: input.fastForwarded,
      existingMeta: input.existingMeta,
      summary: input.summary,
      runtimeVersion: input.config.daemonRuntimeVersion ?? DAEMON_RUNTIME_VERSION,
      skipExport: input.skipExport,
      cloudShelfUrl: input.cloudShelfUrl,
      cloudUploadToken: input.cloudUploadToken,
      ensureDepsOnce,
    });
    surfacesToPublish.push(res.staged);
    reusedDaemon = res.reused;
  }

  const published =
    surfacesToPublish.length > 0
      ? await publishChannelSurfaces({
          paths: input.paths,
          channel: input.config.channel,
          defaultChannel: input.config.channel,
          surfaces: surfacesToPublish,
          preserveExistingSurfaces: true,
          updateDeviceState: true,
          cloudShelfUrl: input.cloudShelfUrl,
          cloudUploadToken: input.cloudUploadToken,
        })
      : null;

  const ui = surfacesToPublish.find((s) => s.surface === "electron-web");
  const daemon = surfacesToPublish.find((s) => s.surface === "daemon");
  return {
    electronPublish:
      ui && published
        ? {
            releaseDigest: ui.releaseDigest,
            generation: published.generation,
            uploadedToCloud: published.uploadedToCloud,
            reusedStagedRelease: reusedElectron,
          }
        : null,
    daemonPublish:
      daemon && published
        ? {
            releaseDigest: daemon.releaseDigest,
            generation: published.generation,
            uploadedToCloud: published.uploadedToCloud,
            reusedStagedRelease: reusedDaemon,
          }
        : null,
  };
}

async function handleShip(ctx: CliContext): Promise<number> {
  const target = ctx.positionals[1];
  if (!target) {
    throw new Error("Usage: paseo-ed ship <slug> [--summary <text>] [--push] [--upload]");
  }
  const config = await readEditableConfig(ctx.paths.configPath);
  if (!config) throw new Error("Run `paseo-ed init` first.");

  const slug = !target.includes("/") && !target.startsWith(".") ? validateSlug(target) : null;
  const worktreeDir = await resolveWorktreeDir(ctx.paths, target);
  const existingMeta = slug ? await readBranchMetadata(ctx.paths, slug) : null;
  const summary =
    stringFlag(ctx.flags, "summary") ?? existingMeta?.summary ?? `Editable change ${target}`;

  const changed = await getChangedFiles(worktreeDir, config.baseBranch);
  const impact = classifyPaseoImpact(changed);
  const verified = await verifyBeforeShip({
    paths: ctx.paths,
    slug,
    worktreeDir,
    existingMeta,
    impact,
    skipVerify: boolFlag(ctx.flags, "skip-verify"),
  });
  if (!verified.ok) {
    emit({ ok: false, stage: "verify", impact, checks: verified.checks }, ctx.json);
    return 1;
  }

  const explicitPush = boolFlag(ctx.flags, "push");
  const softPush = !explicitPush && config.autoPush === true && !boolFlag(ctx.flags, "no-push");
  const landed = await landWipBranch({
    repoDir: ctx.paths.repoDir,
    worktreeDir,
    baseBranch: config.baseBranch,
    summary,
    push: explicitPush,
    softPush,
  });

  const { cloudShelfUrl, cloudUploadToken } = resolveCloudUploadParams(ctx.flags, config);
  const { electronPublish, daemonPublish } = await publishShipSurfaces({
    paths: ctx.paths,
    config,
    slug,
    worktreeDir,
    landedSha: landed.landedSha,
    fastForwarded: landed.fastForwarded,
    existingMeta,
    summary,
    wantsElectron: impact.canPublishElectronRenderer || boolFlag(ctx.flags, "force-electron"),
    wantsDaemon: impact.canPublishDaemon || boolFlag(ctx.flags, "force-daemon"),
    skipExport: boolFlag(ctx.flags, "skip-export"),
    cloudShelfUrl,
    cloudUploadToken,
  });
  const cleanedWorktree = await cleanupAfterShip({
    paths: ctx.paths,
    slug,
    keepWorktree: boolFlag(ctx.flags, "keep-worktree"),
    landedSha: landed.landedSha,
    changedFiles: changed,
    cloudShelfUrl,
    cloudUploadToken,
  });

  emit(
    {
      ok: true,
      landedSha: landed.landedSha,
      fastForwarded: landed.fastForwarded,
      pushed: landed.pushed,
      pushWarning: landed.pushWarning ?? null,
      cleanedWorktree,
      impact,
      electronPublish,
      daemonPublish,
      nextAction: impact.requiresNativeRebuild
        ? "Desktop/native files changed: rebuild Paseo.app before expecting hot-swap delivery."
        : null,
    },
    ctx.json,
  );
  return 0;
}

async function handleGitSync(ctx: CliContext): Promise<number> {
  const config = await readEditableConfig(ctx.paths.configPath);
  if (!config) throw new Error("Run `paseo-ed init` first.");
  const autoPush =
    boolFlag(ctx.flags, "push") || (config.autoPush === true && !boolFlag(ctx.flags, "no-push"));
  const result = await syncGitBaseBranch({
    repoDir: ctx.paths.repoDir,
    baseBranch: config.baseBranch,
    autoPush,
  });
  if (result.status === "fast-forwarded") {
    void spawnBackgroundWarmPool({
      editableHome: ctx.paths.home,
      cliEntrypoint: fileURLToPath(import.meta.url),
    }).catch(() => undefined);
  }
  emit(result, ctx.json);
  return 0;
}

async function handleCheck(ctx: CliContext): Promise<number> {
  const target = ctx.positionals[1];
  const worktreeDir = target ? await resolveWorktreeDir(ctx.paths, target) : ctx.paths.repoDir;
  if (target) {
    await ensureWorktreeDepsIfManaged(ctx.paths, worktreeDir);
  }
  const result = await runConfidenceCheck(worktreeDir, {
    skipSmoke: boolFlag(ctx.flags, "skip-smoke"),
  });
  emit(result, ctx.json);
  return result.ok ? 0 : 1;
}

async function handleRollbackLocal(ctx: CliContext): Promise<number> {
  const state = await readDeviceState(ctx.paths.deviceStatePath);
  const toPackaged = boolFlag(ctx.flags, "packaged");
  const nextActive = toPackaged ? null : state.lastKnownGoodDigest;
  const quarantined =
    state.activeDigest && state.activeDigest !== nextActive
      ? Array.from(new Set([...state.quarantinedDigests, state.activeDigest]))
      : state.quarantinedDigests;

  const nextState = {
    ...state,
    activeDigest: nextActive,
    quarantinedDigests: quarantined,
    previewUrl: null,
  };
  await writeJsonAtomic(ctx.paths.deviceStatePath, nextState);
  emit(
    {
      ok: true,
      previousActive: state.activeDigest,
      activeDigest: nextState.activeDigest,
      usingPackagedRecovery: nextState.activeDigest === null,
    },
    ctx.json,
  );
  return 0;
}

async function handleRevert(ctx: CliContext): Promise<number> {
  const targetSha = ctx.positionals[1];
  if (!targetSha) throw new Error("Usage: ed revert <sha> [--push]");
  const config = await readEditableConfig(ctx.paths.configPath);
  if (!config) throw new Error("Run `ed init` first.");
  const reverted = await createGitRevert({
    repoDir: ctx.paths.repoDir,
    baseBranch: config.baseBranch,
    targetSha,
    push: boolFlag(ctx.flags, "push"),
  });
  emit({ ok: true, ...reverted }, ctx.json);
  return 0;
}

const COMMAND_HANDLERS: Record<string, (ctx: CliContext) => Promise<number>> = {
  keygen: async (ctx) => {
    emit(await ensureKeyPair(ctx.paths, boolFlag(ctx.flags, "force")), ctx.json);
    return 0;
  },
  "keygen-ios": async (ctx) => {
    emit(await ensureExpoCodeSigningKeys(ctx.paths, boolFlag(ctx.flags, "force")), ctx.json);
    return 0;
  },
  sync: handleSync,
  "publish-ios-ota": handlePublishIosOta,
  init: handleInit,
  "workshop-setup": handleWorkshopSetup,
  status: handleStatus,
  branches: handleBranches,
  wip: handleWip,
  impact: handleImpact,
  preview: handlePreview,
  verify: handleVerify,
  "build-electron": (ctx) => handleBuildSurface(ctx, "electron-web"),
  "build-daemon": (ctx) => handleBuildSurface(ctx, "daemon"),
  "sign-publish": handleSignPublish,
  stage: handleStage,
  ship: handleShip,
  "git-sync": handleGitSync,
  check: handleCheck,
  "rollback-local": handleRollbackLocal,
  revert: handleRevert,
};

export async function runCli(argv: string[]): Promise<number> {
  const { positionals, flags } = parseArgs(argv);
  const json = boolFlag(flags, "json");
  const cmd = positionals[0];

  if (!cmd || cmd === "help" || (cmd !== "app" && boolFlag(flags, "help"))) {
    printHelp();
    return 0;
  }

  const paths = getEditablePaths(resolveEditableHome());
  if (cmd === "app") {
    const res = await runAppInspectorCommand({
      editableHome: paths.home,
      subcommand: positionals[1],
      extraPositional: positionals[2],
      flags,
    });
    if (res) {
      emit(json ? res.data : (res.text ?? res.data), json);
    }
    return 0;
  }

  await loadCloudEnvFile(paths.home);
  const handler = COMMAND_HANDLERS[cmd];
  if (!handler) {
    throw new Error(`Unknown command: ${cmd}. Run \`ed --help\`.`);
  }
  return handler({ positionals, flags, json, paths });
}

function isDirectCliExecution(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  const selfPath = fileURLToPath(import.meta.url);
  if (path.resolve(selfPath) === path.resolve(argv1)) return true;
  try {
    return realpathSync(selfPath) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isDirectCliExecution()) {
  void (async () => {
    try {
      process.exitCode = await runCli(process.argv.slice(2));
    } catch (err) {
      process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    }
  })();
}
