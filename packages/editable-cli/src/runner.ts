import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  DAEMON_ENTRYPOINT_REL_PATH,
  DAEMON_RUNTIME_VERSION,
  DESKTOP_RUNTIME_VERSION,
  isSafeRelativePath,
  packReleaseArchive,
  readAndVerifyChannel,
  readDeviceState,
  resolveChannelFilePath,
  resolveSurfaceReleasesDir,
  signEnvelope,
  validateReleaseManifestPayload,
  verifyAndExtractReleaseArchive,
  verifySignedEnvelope,
  writeJsonAtomic,
  type ChannelManifestPayload,
  type ChannelSurfacePointer,
  type EditableHomePaths,
  type ImpactPlan,
  type ReleaseManifestPayload,
  type SignedEnvelope,
} from "@getpaseo/editable-core";

export type HotSwappableSurface = "electron-web" | "daemon";

const DAEMON_WORKSPACE_PACKAGES = [
  "server",
  "protocol",
  "client",
  "relay",
  "highlight",
  "plugin",
  "cli",
] as const;

const execFileAsync = promisify(execFile);

interface CommandCheckResult {
  name: string;
  command: string;
  ok: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

function buildToolEnv(extra?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const nodeBin = path.dirname(process.execPath);
  const currentPath = extra?.PATH ?? process.env.PATH ?? "";
  let nextPath = currentPath;
  if (!currentPath.split(path.delimiter).includes(nodeBin)) {
    nextPath = currentPath ? `${nodeBin}${path.delimiter}${currentPath}` : nodeBin;
  }
  return { ...process.env, ...extra, PATH: nextPath };
}

async function runCheckCommand(
  name: string,
  cmd: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
): Promise<CommandCheckResult> {
  const start = Date.now();
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      env: buildToolEnv(env),
      maxBuffer: 32 * 1024 * 1024,
    });
    return {
      name,
      command: `${cmd} ${args.join(" ")}`,
      ok: true,
      durationMs: Date.now() - start,
      stdout: stdout.slice(-8000),
      stderr: stderr.slice(-8000),
    };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    return {
      name,
      command: `${cmd} ${args.join(" ")}`,
      ok: false,
      durationMs: Date.now() - start,
      stdout: (e.stdout ?? "").slice(-8000),
      stderr: (e.stderr ?? e.message ?? "").slice(-8000),
    };
  }
}

/**
 * Runs scoped verification against a Paseo WIP worktree.
 * Never touches live ~/.paseo or port 6767; any daemon checks run with a fresh mkdtemp PASEO_HOME.
 */
export async function runScopedVerify(
  worktreeDir: string,
  impact: ImpactPlan,
): Promise<{ ok: boolean; checks: CommandCheckResult[] }> {
  const checks: CommandCheckResult[] = [];
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "editable-paseo-verify-home-"));

  try {
    const isolatedEnv: NodeJS.ProcessEnv = {
      PASEO_HOME: tempHome,
      PASEO_DISABLE_RELAY: "1",
    };

    if (impact.verifySteps.includes("typecheck:app")) {
      checks.push(
        await runCheckCommand(
          "typecheck:app",
          "npm",
          ["run", "typecheck", "--workspace=@getpaseo/app"],
          worktreeDir,
          isolatedEnv,
        ),
      );
    }

    if (impact.verifySteps.includes("typecheck:desktop")) {
      checks.push(
        await runCheckCommand(
          "typecheck:desktop",
          "npm",
          ["run", "typecheck", "--workspace=@getpaseo/desktop"],
          worktreeDir,
          isolatedEnv,
        ),
      );
    }

    if (impact.verifySteps.includes("typecheck:server")) {
      checks.push(
        await runCheckCommand(
          "typecheck:server",
          "npm",
          ["run", "typecheck:server"],
          worktreeDir,
          isolatedEnv,
        ),
      );
    }

    const lintableFiles = impact.changedFiles.filter((f) => /\.[cm]?[jt]sx?$/.test(f));
    if (lintableFiles.length > 0) {
      checks.push(
        await runCheckCommand(
          "oxlint:touched",
          "npx",
          ["oxlint", ...lintableFiles],
          worktreeDir,
          isolatedEnv,
        ),
      );
    }

    if (impact.verifySteps.includes("typecheck:editable")) {
      checks.push(
        await runCheckCommand(
          "typecheck:editable",
          "npm",
          ["run", "typecheck:editable"],
          worktreeDir,
          isolatedEnv,
        ),
      );
    }

    if (impact.verifySteps.includes("test:editable")) {
      checks.push(
        await runCheckCommand(
          "test:editable",
          "npm",
          ["run", "test:editable"],
          worktreeDir,
          isolatedEnv,
        ),
      );
    }

    if (impact.verifySteps.includes("test:desktop")) {
      checks.push(
        await runCheckCommand(
          "test:desktop:preload-sandbox",
          "npm",
          ["run", "test", "--workspace=@getpaseo/desktop", "--", "src/preload-sandbox.test.ts"],
          worktreeDir,
          isolatedEnv,
        ),
      );
    }

    return {
      ok: checks.every((c) => c.ok),
      checks,
    };
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

/**
 * Fast local confidence check ("make sure everything works") without waiting for full GitHub CI:
 * full workspace `tsgo` typecheck + core unit tests + optional Playwright browser smoke suite.
 * Runs against an isolated temporary PASEO_HOME and never touches live ~/.paseo (:6767).
 */
export async function runConfidenceCheck(
  worktreeDir: string,
  options: { skipSmoke?: boolean } = {},
): Promise<{ ok: boolean; durationMs: number; checks: CommandCheckResult[] }> {
  const start = Date.now();
  const checks: CommandCheckResult[] = [];
  const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "editable-paseo-check-home-"));

  try {
    const isolatedEnv: NodeJS.ProcessEnv = {
      PASEO_HOME: tempHome,
      PASEO_DISABLE_RELAY: "1",
    };

    checks.push(
      await runCheckCommand("typecheck:all", "npm", ["run", "typecheck"], worktreeDir, isolatedEnv),
    );
    checks.push(
      await runCheckCommand(
        "test:protocol",
        "npm",
        ["run", "test", "--workspace=@getpaseo/protocol"],
        worktreeDir,
        isolatedEnv,
      ),
    );
    checks.push(
      await runCheckCommand(
        "test:client",
        "npm",
        ["run", "test", "--workspace=@getpaseo/client"],
        worktreeDir,
        isolatedEnv,
      ),
    );
    checks.push(
      await runCheckCommand(
        "test:desktop",
        "npm",
        ["run", "test", "--workspace=@getpaseo/desktop"],
        worktreeDir,
        isolatedEnv,
      ),
    );
    checks.push(
      await runCheckCommand(
        "test:app:editable",
        "npm",
        ["run", "test", "--workspace=@getpaseo/app", "--", "src/editable/"],
        worktreeDir,
        isolatedEnv,
      ),
    );

    if (!options.skipSmoke) {
      checks.push(
        await runCheckCommand(
          "test:e2e:smoke",
          "npm",
          ["run", "test:e2e:smoke", "--workspace=@getpaseo/app"],
          worktreeDir,
          { ...isolatedEnv, E2E_WORKERS: "2" },
        ),
      );
    }

    return {
      ok: checks.every((c) => c.ok),
      durationMs: Date.now() - start,
      checks,
    };
  } finally {
    await fs.rm(tempHome, { recursive: true, force: true });
  }
}

export async function buildElectronArtifact(options: {
  worktreeDir: string;
  sourceSha: string;
  summary: string;
  outputDir: string;
  runtimeVersion?: string;
  skipExport?: boolean;
}): Promise<{
  archivePath: string;
  unsignedManifestPath: string;
  manifest: ReleaseManifestPayload;
  durationMs: number;
}> {
  const start = Date.now();
  const appDir = path.join(options.worktreeDir, "packages", "app");
  const distDir = path.join(appDir, "dist");

  if (!options.skipExport) {
    const env = buildToolEnv();
    await execFileAsync("npm", ["run", "build:app-deps"], {
      cwd: options.worktreeDir,
      env,
      maxBuffer: 32 * 1024 * 1024,
    });
    await fs.rm(distDir, { recursive: true, force: true });
    await execFileAsync("npx", ["expo", "export", "--platform", "web"], {
      cwd: appDir,
      env: { ...env, PASEO_WEB_PLATFORM: "electron" },
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  await fs.mkdir(options.outputDir, { recursive: true });
  const archivePath = path.join(
    options.outputDir,
    `electron-web-${options.sourceSha.slice(0, 12)}.tar.gz`,
  );
  const manifest = await packReleaseArchive({
    sourceDir: distDir,
    outputArchivePath: archivePath,
    surface: "electron-web",
    sourceSha: options.sourceSha,
    runtimeVersion: options.runtimeVersion ?? DESKTOP_RUNTIME_VERSION,
    summary: options.summary,
  });

  const unsignedManifestPath = path.join(
    options.outputDir,
    `electron-web-${options.sourceSha.slice(0, 12)}.manifest.unsigned.json`,
  );
  await writeJsonAtomic(unsignedManifestPath, manifest);

  return {
    archivePath,
    unsignedManifestPath,
    manifest,
    durationMs: Date.now() - start,
  };
}

async function copyFilteredDaemonDist(
  srcDir: string,
  destDir: string,
  pkgName: string,
  relPrefix = "",
): Promise<void> {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const stat = await fs.lstat(srcPath);
    if (stat.isSymbolicLink()) continue;
    const nextRel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
    if (stat.isDirectory()) {
      if (entry.name === "web-ui" || entry.name === "node_modules") continue;
      await copyFilteredDaemonDist(srcPath, path.join(destDir, entry.name), pkgName, nextRel);
      continue;
    }
    if (!stat.isFile()) continue;
    if (
      entry.name.endsWith(".map") ||
      entry.name.endsWith(".tsbuildinfo") ||
      entry.name.includes(".test.") ||
      entry.name.includes(".spec.")
    ) {
      continue;
    }
    // Keep .d.ts only for @getpaseo/plugin and builtin-plugins (runtime plugin compilation).
    if (
      entry.name.endsWith(".d.ts") &&
      pkgName !== "plugin" &&
      !nextRel.includes("builtin-plugins")
    ) {
      continue;
    }
    if (!isSafeRelativePath(nextRel)) continue;
    await fs.mkdir(destDir, { recursive: true });
    await fs.copyFile(srcPath, path.join(destDir, entry.name));
  }
}

export async function buildDaemonArtifact(options: {
  worktreeDir: string;
  sourceSha: string;
  summary: string;
  outputDir: string;
  runtimeVersion?: string;
  skipExport?: boolean;
}): Promise<{
  archivePath: string;
  unsignedManifestPath: string;
  manifest: ReleaseManifestPayload;
  durationMs: number;
}> {
  const start = Date.now();
  if (!options.skipExport) {
    const env = buildToolEnv();
    await execFileAsync("npm", ["run", "build:server"], {
      cwd: options.worktreeDir,
      env,
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  const stageDir = await fs.mkdtemp(path.join(os.tmpdir(), "ed-daemon-stage-"));
  try {
    for (const pkgName of DAEMON_WORKSPACE_PACKAGES) {
      const pkgSrcDir = path.join(options.worktreeDir, "packages", pkgName);
      const pkgJsonSrc = path.join(pkgSrcDir, "package.json");
      const distSrc = path.join(pkgSrcDir, "dist");
      const pkgDestDir = path.join(stageDir, "node_modules", "@getpaseo", pkgName);

      const hasPkgJson = await fs
        .stat(pkgJsonSrc)
        .then((s) => s.isFile())
        .catch(() => false);
      if (hasPkgJson) {
        await fs.mkdir(pkgDestDir, { recursive: true });
        await fs.copyFile(pkgJsonSrc, path.join(pkgDestDir, "package.json"));
      }
      const hasDist = await fs
        .stat(distSrc)
        .then((s) => s.isDirectory())
        .catch(() => false);
      if (hasDist) {
        await copyFilteredDaemonDist(distSrc, path.join(pkgDestDir, "dist"), pkgName);
      }
    }

    const entryFullPath = path.join(stageDir, DAEMON_ENTRYPOINT_REL_PATH);
    const hasEntry = await fs
      .stat(entryFullPath)
      .then((s) => s.isFile())
      .catch(() => false);
    if (!hasEntry) {
      throw new Error(
        `Built daemon tree is missing ${DAEMON_ENTRYPOINT_REL_PATH}. Run build:server first.`,
      );
    }

    await fs.mkdir(options.outputDir, { recursive: true });
    const archivePath = path.join(
      options.outputDir,
      `daemon-${options.sourceSha.slice(0, 12)}.tar.gz`,
    );
    const manifest = await packReleaseArchive({
      sourceDir: stageDir,
      outputArchivePath: archivePath,
      surface: "daemon",
      sourceSha: options.sourceSha,
      runtimeVersion: options.runtimeVersion ?? DAEMON_RUNTIME_VERSION,
      summary: options.summary,
    });

    const unsignedManifestPath = path.join(
      options.outputDir,
      `daemon-${options.sourceSha.slice(0, 12)}.manifest.unsigned.json`,
    );
    await writeJsonAtomic(unsignedManifestPath, manifest);

    return {
      archivePath,
      unsignedManifestPath,
      manifest,
      durationMs: Date.now() - start,
    };
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true });
  }
}

export interface StagedSurfaceRelease {
  surface: HotSwappableSurface;
  releaseDigest: string;
  sourceSha: string;
  runtimeVersion: string;
  summary: string;
  releaseDir: string;
  archiveUrl: string;
  manifestUrl: string;
  signedRelease: SignedEnvelope<ReleaseManifestPayload>;
  uploadedToCloud: boolean;
}

export async function signAndStageReleaseLocal(options: {
  paths: EditableHomePaths;
  archivePath: string;
  unsignedManifestPath: string;
  expectedSurface?: HotSwappableSurface;
  expectedRuntimeVersion?: string;
  cloudShelfUrl?: string | null;
  cloudUploadToken?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<StagedSurfaceRelease> {
  const fetchFn = options.fetchImpl ?? fetch;
  const privateKeyPem = await fs.readFile(options.paths.privateKeyPath, "utf8");
  const publicKeyPem = await fs.readFile(options.paths.publicKeyPath, "utf8");

  const rawManifest = JSON.parse(await fs.readFile(options.unsignedManifestPath, "utf8"));
  const validated = validateReleaseManifestPayload(rawManifest);
  if (!validated.ok) {
    throw new Error(`Invalid unsigned manifest: ${validated.error}`);
  }
  const manifest = validated.value;
  if (manifest.surface !== "electron-web" && manifest.surface !== "daemon") {
    throw new Error(`Expected electron-web or daemon surface, got ${manifest.surface}`);
  }
  if (options.expectedSurface && manifest.surface !== options.expectedSurface) {
    throw new Error(`Expected ${options.expectedSurface} surface, got ${manifest.surface}`);
  }

  const expectedRuntime =
    options.expectedRuntimeVersion ??
    (manifest.surface === "daemon" ? DAEMON_RUNTIME_VERSION : DESKTOP_RUNTIME_VERSION);
  const signedRelease = signEnvelope(manifest, privateKeyPem, publicKeyPem);
  const releaseDir = path.join(
    resolveSurfaceReleasesDir(options.paths, manifest.surface),
    manifest.releaseDigest,
  );

  await verifyAndExtractReleaseArchive({
    archivePath: options.archivePath,
    signedManifest: signedRelease,
    publicKeyPem,
    expectedSurface: manifest.surface,
    expectedRuntimeVersion: expectedRuntime,
    targetDir: releaseDir,
  });

  const baseUrl = options.cloudShelfUrl?.replace(/\/+$/, "") ?? null;
  const archiveUrl = baseUrl
    ? `${baseUrl}/releases/${manifest.surface}/${manifest.releaseDigest}/archive.tar.gz`
    : `file://${options.archivePath}`;
  const manifestUrl = baseUrl
    ? `${baseUrl}/releases/${manifest.surface}/${manifest.releaseDigest}/manifest.json`
    : `file://${path.join(releaseDir, "manifest.json")}`;

  let uploadedToCloud = false;
  if (baseUrl && options.cloudUploadToken) {
    const authHeader = { Authorization: `Bearer ${options.cloudUploadToken}` };
    const archiveBytes = await fs.readFile(options.archivePath);

    const putArchive = await fetchFn(archiveUrl, {
      method: "PUT",
      headers: { ...authHeader, "Content-Type": "application/gzip" },
      body: new Uint8Array(archiveBytes),
    });
    if (!putArchive.ok && putArchive.status !== 409) {
      throw new Error(
        `Cloud archive upload failed (${putArchive.status}): ${await putArchive.text()}`,
      );
    }

    const putManifest = await fetchFn(manifestUrl, {
      method: "PUT",
      headers: { ...authHeader, "Content-Type": "application/json" },
      body: JSON.stringify(signedRelease),
    });
    if (!putManifest.ok && putManifest.status !== 409) {
      throw new Error(
        `Cloud manifest upload failed (${putManifest.status}): ${await putManifest.text()}`,
      );
    }
    uploadedToCloud = true;
  }

  return {
    surface: manifest.surface,
    releaseDigest: manifest.releaseDigest,
    sourceSha: manifest.sourceSha,
    runtimeVersion: manifest.runtimeVersion,
    summary: manifest.summary,
    releaseDir,
    archiveUrl,
    manifestUrl,
    signedRelease,
    uploadedToCloud,
  };
}

async function maybePromoteManifestToCloud(options: {
  fetchFn: typeof fetch;
  manifestUrl: string;
  rawEnvelope: unknown;
  baseUrl: string | null;
  cloudUploadToken: string | null | undefined;
  alreadyUploadedToCloud: boolean | undefined;
}): Promise<boolean> {
  if (!options.baseUrl || !options.cloudUploadToken) return false;
  if (options.alreadyUploadedToCloud) return true;
  const putManifest = await options.fetchFn(options.manifestUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${options.cloudUploadToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(options.rawEnvelope),
  });
  if (!putManifest.ok && putManifest.status !== 409) {
    throw new Error(
      `Cloud manifest promote failed (${putManifest.status}): ${await putManifest.text()}`,
    );
  }
  return true;
}

export async function loadExistingStagedRelease(options: {
  paths: EditableHomePaths;
  surface: HotSwappableSurface;
  releaseDigest: string;
  expectedSourceSha: string;
  summary?: string;
  expectedRuntimeVersion?: string;
  cloudShelfUrl?: string | null;
  cloudUploadToken?: string | null;
  alreadyUploadedToCloud?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<StagedSurfaceRelease> {
  const fetchFn = options.fetchImpl ?? fetch;
  const publicKeyPem = await fs.readFile(options.paths.publicKeyPath, "utf8");
  const releaseDir = path.join(
    resolveSurfaceReleasesDir(options.paths, options.surface),
    options.releaseDigest,
  );
  const manifestPath = path.join(releaseDir, "manifest.json");
  const rawEnvelope = JSON.parse(await fs.readFile(manifestPath, "utf8")) as unknown;
  const verified = verifySignedEnvelope<ReleaseManifestPayload>(rawEnvelope, publicKeyPem);
  if (!verified.ok) {
    throw new Error(`Existing release signature invalid: ${verified.error}`);
  }
  const validated = validateReleaseManifestPayload(verified.payload);
  if (!validated.ok) {
    throw new Error(`Existing release manifest invalid: ${validated.error}`);
  }
  const manifest = validated.value;
  const defaultRuntime =
    options.surface === "daemon" ? DAEMON_RUNTIME_VERSION : DESKTOP_RUNTIME_VERSION;
  const expectedRuntime = options.expectedRuntimeVersion ?? defaultRuntime;
  if (
    manifest.releaseDigest !== options.releaseDigest ||
    manifest.sourceSha !== options.expectedSourceSha ||
    manifest.runtimeVersion !== expectedRuntime ||
    manifest.surface !== options.surface
  ) {
    throw new Error("Existing release does not match fast-forwarded commit or runtime");
  }

  const baseUrl = options.cloudShelfUrl?.replace(/\/+$/, "") ?? null;
  const archiveUrl = baseUrl
    ? `${baseUrl}/releases/${options.surface}/${manifest.releaseDigest}/archive.tar.gz`
    : `file://${path.join(releaseDir, "archive.tar.gz")}`;
  const manifestUrl = baseUrl
    ? `${baseUrl}/releases/${options.surface}/${manifest.releaseDigest}/manifest.json`
    : `file://${manifestPath}`;
  const uploadedToCloud = await maybePromoteManifestToCloud({
    fetchFn,
    manifestUrl,
    rawEnvelope,
    baseUrl,
    cloudUploadToken: options.cloudUploadToken,
    alreadyUploadedToCloud: options.alreadyUploadedToCloud,
  });

  return {
    surface: options.surface,
    releaseDigest: manifest.releaseDigest,
    sourceSha: manifest.sourceSha,
    runtimeVersion: manifest.runtimeVersion,
    summary: (options.summary ?? manifest.summary).slice(0, 200),
    releaseDir,
    archiveUrl,
    manifestUrl,
    signedRelease: rawEnvelope as SignedEnvelope<ReleaseManifestPayload>,
    uploadedToCloud,
  };
}

async function maybeUploadChannelToCloud(options: {
  fetchFn: typeof fetch;
  channel: string;
  signedChannel: SignedEnvelope<ChannelManifestPayload>;
  cloudShelfUrl?: string | null;
  cloudUploadToken?: string | null;
}): Promise<boolean> {
  const baseUrl = options.cloudShelfUrl?.replace(/\/+$/, "") ?? null;
  if (!baseUrl || !options.cloudUploadToken) return false;
  const putChannel = await options.fetchFn(`${baseUrl}/channels/${options.channel}.json`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${options.cloudUploadToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(options.signedChannel),
  });
  if (!putChannel.ok) {
    throw new Error(
      `Cloud channel update failed (${putChannel.status}): ${await putChannel.text()}`,
    );
  }
  return true;
}

async function updateDeviceStateForPublishedSurfaces(
  deviceStatePath: string,
  surfaces: StagedSurfaceRelease[],
  nextGeneration: number,
): Promise<void> {
  const prevDeviceState = await readDeviceState(deviceStatePath);
  const nextState = { ...prevDeviceState };
  for (const item of surfaces) {
    if (item.surface === "electron-web") {
      const prevUi = prevDeviceState.activeDigest;
      nextState.activeDigest = item.releaseDigest;
      nextState.lastKnownGoodDigest =
        prevUi && prevUi !== item.releaseDigest ? prevUi : prevDeviceState.lastKnownGoodDigest;
      nextState.activeGeneration = nextGeneration;
      nextState.quarantinedDigests = prevDeviceState.quarantinedDigests.filter(
        (d) => d !== item.releaseDigest,
      );
    } else if (item.surface === "daemon") {
      const prevDaemon = prevDeviceState.activeDaemonDigest ?? null;
      nextState.activeDaemonDigest = item.releaseDigest;
      nextState.lastKnownGoodDaemonDigest =
        prevDaemon && prevDaemon !== item.releaseDigest
          ? prevDaemon
          : (prevDeviceState.lastKnownGoodDaemonDigest ?? null);
      nextState.activeDaemonGeneration = nextGeneration;
      nextState.quarantinedDaemonDigests = (prevDeviceState.quarantinedDaemonDigests ?? []).filter(
        (d) => d !== item.releaseDigest,
      );
    }
  }
  await writeJsonAtomic(deviceStatePath, nextState);
}

export async function publishChannelSurfaces(options: {
  paths: EditableHomePaths;
  channel: string;
  defaultChannel?: string;
  surfaces: StagedSurfaceRelease[];
  preserveExistingSurfaces?: boolean;
  updateDeviceState?: boolean;
  cloudShelfUrl?: string | null;
  cloudUploadToken?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{
  generation: number;
  channelPath: string;
  signedChannel: SignedEnvelope<ChannelManifestPayload>;
  uploadedToCloud: boolean;
}> {
  if (options.surfaces.length === 0) {
    throw new Error("Cannot publish empty surface list to channel");
  }
  const fetchFn = options.fetchImpl ?? fetch;
  const privateKeyPem = await fs.readFile(options.paths.privateKeyPath, "utf8");
  const publicKeyPem = await fs.readFile(options.paths.publicKeyPath, "utf8");

  const defaultChannel = options.defaultChannel ?? "prod";
  const channelPath = resolveChannelFilePath(options.paths, options.channel, defaultChannel);
  const shouldUpdateDeviceState = options.updateDeviceState ?? options.channel === defaultChannel;
  const preserveExisting = options.preserveExistingSurfaces ?? options.channel === defaultChannel;

  const existingChannel = await readAndVerifyChannel(channelPath, publicKeyPem, 0);
  const nextGeneration = existingChannel.ok ? existingChannel.envelope.payload.generation + 1 : 1;
  const baseSurfaces: ChannelManifestPayload["surfaces"] =
    preserveExisting && existingChannel.ok ? { ...existingChannel.envelope.payload.surfaces } : {};

  const now = new Date().toISOString();
  const nextSurfaces: ChannelManifestPayload["surfaces"] = { ...baseSurfaces };
  for (const item of options.surfaces) {
    const pointer: ChannelSurfacePointer = {
      releaseDigest: item.releaseDigest,
      sourceSha: item.sourceSha,
      runtimeVersion: item.runtimeVersion,
      archiveUrl: item.archiveUrl,
      manifestUrl: item.manifestUrl,
      summary: item.summary.slice(0, 200),
      updatedAt: now,
    };
    nextSurfaces[item.surface] = pointer;
  }

  const channelPayload: ChannelManifestPayload = {
    schemaVersion: 1,
    kind: "channel",
    channel: options.channel,
    generation: nextGeneration,
    updatedAt: now,
    surfaces: nextSurfaces,
  };
  const signedChannel = signEnvelope(channelPayload, privateKeyPem, publicKeyPem);
  const uploadedToCloud = await maybeUploadChannelToCloud({
    fetchFn,
    channel: options.channel,
    signedChannel,
    cloudShelfUrl: options.cloudShelfUrl,
    cloudUploadToken: options.cloudUploadToken,
  });

  await writeJsonAtomic(channelPath, signedChannel);
  if (shouldUpdateDeviceState) {
    await updateDeviceStateForPublishedSurfaces(
      options.paths.deviceStatePath,
      options.surfaces,
      nextGeneration,
    );
  }

  return {
    generation: nextGeneration,
    channelPath,
    signedChannel,
    uploadedToCloud,
  };
}

/**
 * Trusted local Publisher / Signer step.
 * Never executes any code from the candidate tree. Reads only the verified archive
 * and unsigned manifest, signs with Ed25519 private key, stages immutably, and
 * advances channel.json with a strictly monotonic generation counter.
 */
export async function signAndPublishElectronLocal(options: {
  paths: EditableHomePaths;
  archivePath: string;
  unsignedManifestPath: string;
  channel: string;
  defaultChannel?: string;
  updateDeviceState?: boolean;
  expectedSurface?: HotSwappableSurface;
  expectedRuntimeVersion?: string;
  cloudShelfUrl?: string | null;
  cloudUploadToken?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{
  surface: HotSwappableSurface;
  releaseDigest: string;
  generation: number;
  releaseDir: string;
  channelPath: string;
  signedRelease: SignedEnvelope<ReleaseManifestPayload>;
  signedChannel: SignedEnvelope<ChannelManifestPayload>;
  uploadedToCloud: boolean;
}> {
  const staged = await signAndStageReleaseLocal({
    paths: options.paths,
    archivePath: options.archivePath,
    unsignedManifestPath: options.unsignedManifestPath,
    expectedSurface: options.expectedSurface,
    expectedRuntimeVersion: options.expectedRuntimeVersion,
    cloudShelfUrl: options.cloudShelfUrl,
    cloudUploadToken: options.cloudUploadToken,
    fetchImpl: options.fetchImpl,
  });
  const published = await publishChannelSurfaces({
    paths: options.paths,
    channel: options.channel,
    defaultChannel: options.defaultChannel,
    surfaces: [staged],
    preserveExistingSurfaces: true,
    updateDeviceState: options.updateDeviceState,
    cloudShelfUrl: options.cloudShelfUrl,
    cloudUploadToken: options.cloudUploadToken,
    fetchImpl: options.fetchImpl,
  });
  return {
    surface: staged.surface,
    releaseDigest: staged.releaseDigest,
    generation: published.generation,
    releaseDir: staged.releaseDir,
    channelPath: published.channelPath,
    signedRelease: staged.signedRelease,
    signedChannel: published.signedChannel,
    uploadedToCloud: published.uploadedToCloud,
  };
}

export async function startLocalPreviewServer(options: {
  paths: EditableHomePaths;
  worktreeDir: string;
  port: number;
}): Promise<{ pid: number; url: string; logFile: string }> {
  if (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535) {
    throw new Error(`Invalid preview port: ${options.port}`);
  }
  const logFile = path.join(options.paths.home, "preview-metro.log");
  const pidFile = path.join(options.paths.home, "preview-metro.pid");

  await stopLocalPreviewServer(options.paths);

  const logHandle = await fs.open(logFile, "w");
  const child = spawn("npx", ["expo", "start", "--web", "--port", String(options.port)], {
    cwd: path.join(options.worktreeDir, "packages", "app"),
    env: { ...process.env, PASEO_WEB_PLATFORM: "electron", CI: "1" },
    detached: true,
    stdio: ["ignore", logHandle.fd, logHandle.fd],
  });
  child.unref();
  await logHandle.close();

  const pid = child.pid;
  if (!pid) {
    throw new Error("Failed to spawn Metro preview process");
  }
  const url = `http://127.0.0.1:${options.port}`;
  await fs.writeFile(pidFile, `${pid}\n`, "utf8");

  const deviceState = await readDeviceState(options.paths.deviceStatePath);
  await writeJsonAtomic(options.paths.deviceStatePath, {
    ...deviceState,
    previewUrl: url,
  });

  return { pid, url, logFile };
}

export async function stopLocalPreviewServer(
  paths: EditableHomePaths,
): Promise<{ stopped: boolean }> {
  const pidFile = path.join(paths.home, "preview-metro.pid");
  let stopped = false;
  try {
    const raw = (await fs.readFile(pidFile, "utf8")).trim();
    const pid = Number(raw);
    if (Number.isInteger(pid) && pid > 1) {
      try {
        process.kill(-pid, "SIGTERM");
        stopped = true;
      } catch {
        try {
          process.kill(pid, "SIGTERM");
          stopped = true;
        } catch {
          stopped = false;
        }
      }
    }
    await fs.rm(pidFile, { force: true });
  } catch {
    stopped = false;
  }

  const deviceState = await readDeviceState(paths.deviceStatePath);
  if (deviceState.previewUrl !== null) {
    await writeJsonAtomic(paths.deviceStatePath, {
      ...deviceState,
      previewUrl: null,
    });
  }
  return { stopped };
}
