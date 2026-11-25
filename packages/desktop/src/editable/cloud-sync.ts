import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseEnv, promisify } from "node:util";
import { z } from "zod";
import { DESKTOP_RUNTIME_VERSION } from "./constants.js";
import {
  isSafeRelativePath,
  resolveRegularFile,
  verifyReleaseDirectory,
  verifySignedEnvelope,
} from "./crypto.js";
import { parseReleaseManifest } from "./release-manifest.js";
import { channelManifestSchema, wipIndexSchema, type WipBranchPointer } from "./schema.js";

const run = promisify(execFile);
const MAX_JSON_BYTES = 4 * 1024 * 1024;
const MAX_RELEASE_BYTES = 128 * 1024 * 1024;
const configSchema = z.object({
  cloudShelfUrl: z.url({ protocol: /^https$/ }),
  channel: z
    .string()
    .regex(/^[\w-]+$/)
    .default("prod"),
});

export interface CloudChannelCandidate {
  digest: string;
  generation: number;
}

async function readDownload(response: Response, limit: number): Promise<Buffer> {
  if (!response.ok) throw new Error(`Cloud Shelf request failed (HTTP ${response.status})`);
  if (!response.body) throw new Error("Cloud Shelf response is missing its body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) return Buffer.concat(chunks, bytes);
      bytes += chunk.value.byteLength;
      if (bytes > limit) throw new Error("Cloud Shelf response exceeds its size limit");
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
}

async function readShelfConfig(home: string) {
  const config = configSchema.parse(
    JSON.parse(await readFile(path.join(home, "config.json"), "utf8")),
  );
  const env = await readFile(path.join(home, "cloud.env"), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  return { ...config, readToken: parseEnv(env).EDITABLE_CLOUD_READ_TOKEN };
}

async function runTar(args: string[]) {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
    COPYFILE_DISABLE: "1",
  };
  delete env.TAR_OPTIONS;
  const tar = process.platform === "darwin" ? "/usr/bin/tar" : "tar";
  return (await run(tar, args, { env, maxBuffer: 8 * 1024 * 1024, timeout: 30_000 })).stdout;
}

async function extractArchive(archive: string, directory: string, expectedPaths: Set<string>) {
  // The Shelf publisher archives only the individual regular files in the signed file list.
  const names = (await runTar(["-tzf", archive])).replace(/\r?\n$/, "").split(/\r?\n/);
  const details = (await runTar(["-tvzf", archive])).replace(/\r?\n$/, "").split(/\r?\n/);
  if (
    names.length !== expectedPaths.size ||
    details.length !== names.length ||
    details.some((line) => !line.startsWith("-")) ||
    names.some((name) => !isSafeRelativePath(name) || !expectedPaths.delete(name))
  ) {
    throw new Error("Cloud Shelf archive contains unsafe or undeclared entries");
  }
  await runTar(["-xzf", archive, "-C", directory, "--no-same-owner", "--no-same-permissions"]);
}

async function readDownloadJson(response: Response): Promise<unknown> {
  return JSON.parse((await readDownload(response, MAX_JSON_BYTES)).toString("utf8"));
}

async function downloadRelease(
  request: (url: string) => Promise<Response>,
  releaseUrl: string,
  pointer: { releaseDigest: string; sourceSha: string },
  trustedKey: string,
) {
  const manifestEnvelope = await readDownloadJson(await request(`${releaseUrl}/manifest.json`));
  if (!verifySignedEnvelope(manifestEnvelope, trustedKey)) {
    throw new Error("Invalid Cloud Shelf release signature");
  }
  const manifest = parseReleaseManifest(manifestEnvelope.payload);
  if (
    manifest.releaseDigest !== pointer.releaseDigest ||
    manifest.runtimeVersion !== DESKTOP_RUNTIME_VERSION ||
    manifest.sourceSha !== pointer.sourceSha
  ) {
    throw new Error("Cloud Shelf release manifest does not match its channel");
  }
  if (
    manifest.archiveBytes > MAX_RELEASE_BYTES ||
    manifest.files.reduce((bytes, file) => bytes + file.bytes, 0) > MAX_RELEASE_BYTES
  ) {
    throw new Error("Cloud Shelf release exceeds its size limit");
  }
  const archiveBytes = await readDownload(
    await request(`${releaseUrl}/archive.tar.gz`),
    manifest.archiveBytes,
  );
  if (
    archiveBytes.length !== manifest.archiveBytes ||
    createHash("sha256").update(archiveBytes).digest("hex") !== manifest.archiveSha256
  ) {
    throw new Error("Cloud Shelf archive integrity check failed");
  }

  return { manifestEnvelope, manifest, archiveBytes };
}

async function prepareReleaseStore(home: string): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const releases = path.join(home, "releases");
  const surface = path.join(releases, "electron-web");
  if (!(await lstat(home)).isDirectory())
    throw new Error("Unsafe Editable release store directory");
  for (const dir of [releases, surface]) {
    await mkdir(dir, { mode: 0o700 }).catch((error) => {
      if (error.code !== "EEXIST") throw error;
    });
    if (!(await lstat(dir)).isDirectory())
      throw new Error("Unsafe Editable release store directory");
  }

  return surface;
}

export async function syncFromCloudShelf({
  home,
  configHome,
  publicKey,
  shouldInstall,
  fetchImpl = fetch,
}: {
  home: string;
  configHome: string;
  publicKey: () => string;
  shouldInstall: (candidate: CloudChannelCandidate) => boolean;
  fetchImpl?: typeof fetch;
}): Promise<boolean> {
  const { cloudShelfUrl, channel, readToken } = await readShelfConfig(configHome);
  const shelfUrl = new URL(cloudShelfUrl);
  if (shelfUrl.username || shelfUrl.password || shelfUrl.search || shelfUrl.hash) {
    throw new Error("Cloud Shelf URL must be an HTTPS base URL");
  }
  const base = shelfUrl.href.replace(/\/+$/, "");
  const request = (url: string) =>
    fetchImpl(url, {
      headers: readToken ? { Authorization: `Bearer ${readToken}` } : {},
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });

  const trustedKey = publicKey();
  const channelEnvelope = await readDownloadJson(await request(`${base}/channels/${channel}.json`));
  if (!verifySignedEnvelope(channelEnvelope, trustedKey)) {
    throw new Error("Invalid Cloud Shelf channel signature");
  }
  const payload = channelManifestSchema.parse(channelEnvelope.payload);
  if (payload.channel !== channel) throw new Error("Cloud Shelf channel name mismatch");
  const pointer = payload.surfaces["electron-web"];
  if (!pointer || pointer.runtimeVersion !== DESKTOP_RUNTIME_VERSION) {
    throw new Error("Cloud Shelf channel has no compatible desktop renderer");
  }
  const candidate = { digest: pointer.releaseDigest, generation: payload.generation };
  if (!shouldInstall(candidate)) return false;

  // The publisher uses immutable objects under the configured Shelf. Keep the read token there.
  const releaseUrl = `${base}/releases/electron-web/${candidate.digest}`;
  const { manifestEnvelope, manifest, archiveBytes } = await downloadRelease(
    request,
    releaseUrl,
    pointer,
    trustedKey,
  );

  const surface = await prepareReleaseStore(home);
  const staging = await mkdtemp(path.join(surface, ".cloud-"));
  try {
    const archive = path.join(staging, "archive.tar.gz");
    const extracted = path.join(staging, "release");
    const target = path.join(surface, candidate.digest);
    await writeFile(archive, archiveBytes);
    await mkdir(extracted);
    await extractArchive(archive, extracted, new Set(manifest.files.map((file) => file.path)));
    verifyReleaseDirectory(extracted, manifestEnvelope, trustedKey, DESKTOP_RUNTIME_VERSION);
    await writeFile(path.join(extracted, "manifest.json"), JSON.stringify(manifestEnvelope), {
      flag: "wx",
    });

    // Recheck after the downloads so a manual switch or renderer rollback can win.
    if (!shouldInstall(candidate)) return false;
    try {
      renameSync(extracted, target);
    } catch (error) {
      if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? ""))
        throw error;
      const existingManifest = resolveRegularFile(target, "manifest.json");
      if (!existingManifest)
        throw new Error("Installed release is missing its manifest", { cause: error });
      const installed = verifyReleaseDirectory(
        target,
        JSON.parse(await readFile(existingManifest, "utf8")),
        trustedKey,
        DESKTOP_RUNTIME_VERSION,
      );
      if (installed.releaseDigest !== candidate.digest)
        throw new Error("Installed release digest mismatch", { cause: error });
      if (!shouldInstall(candidate)) return false;
    }
    const channelFile = path.join(staging, "channel.json");
    writeFileSync(channelFile, JSON.stringify(channelEnvelope) + "\n");
    renameSync(channelFile, path.join(surface, "channel.json"));
    return true;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export interface ChannelSyncResult {
  updated: boolean;
  digest: string;
  generation: number;
  summary: string;
}

async function readCachedChannelMeta(
  channelDest: string,
  trustedKey: string,
): Promise<{ generation: number; digest: string | null }> {
  try {
    const existingRaw = JSON.parse(await readFile(channelDest, "utf8")) as unknown;
    if (verifySignedEnvelope(existingRaw, trustedKey)) {
      const existingParsed = channelManifestSchema.parse(existingRaw.payload);
      return {
        generation: existingParsed.generation,
        digest: existingParsed.surfaces["electron-web"]?.releaseDigest ?? null,
      };
    }
  } catch {
    // Missing or unreadable channel file
  }
  return { generation: 0, digest: null };
}

async function installReleaseFromCloud(input: {
  request: (url: string) => Promise<Response>;
  base: string;
  pointer: { releaseDigest: string; sourceSha: string };
  trustedKey: string;
  surface: string;
  staging: string;
}): Promise<void> {
  const releaseUrl = `${input.base}/releases/electron-web/${input.pointer.releaseDigest}`;
  const { manifestEnvelope, manifest, archiveBytes } = await downloadRelease(
    input.request,
    releaseUrl,
    input.pointer,
    input.trustedKey,
  );
  const archive = path.join(input.staging, "archive.tar.gz");
  const extracted = path.join(input.staging, "release");
  const target = path.join(input.surface, input.pointer.releaseDigest);
  await writeFile(archive, archiveBytes);
  await mkdir(extracted);
  await extractArchive(archive, extracted, new Set(manifest.files.map((file) => file.path)));
  verifyReleaseDirectory(extracted, manifestEnvelope, input.trustedKey, DESKTOP_RUNTIME_VERSION);
  await writeFile(path.join(extracted, "manifest.json"), JSON.stringify(manifestEnvelope), {
    flag: "wx",
  });
  try {
    renameSync(extracted, target);
  } catch (error) {
    if (!["EEXIST", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw error;
    }
  }
}

function buildShelfRequest(
  cloudShelfUrl: string,
  readToken: string | undefined,
  fetchImpl: typeof fetch,
) {
  const shelfUrl = new URL(cloudShelfUrl);
  if (shelfUrl.username || shelfUrl.password || shelfUrl.search || shelfUrl.hash) {
    throw new Error("Cloud Shelf URL must be an HTTPS base URL");
  }
  const base = shelfUrl.href.replace(/\/+$/, "");
  const request = (url: string) =>
    fetchImpl(url, {
      headers: readToken ? { Authorization: `Bearer ${readToken}` } : {},
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    });
  return { base, request };
}

/**
 * Downloads & verifies a signed channel (`prod` or `wip-<slug>`) from Cloud Shelf
 * into `home` without automatically reloading any window.
 */
export async function syncChannelFromCloudShelf({
  home,
  configHome,
  channel,
  publicKey,
  minGeneration = 0,
  isQuarantined = () => false,
  hasInstalledRelease = () => false,
  fetchImpl = fetch,
}: {
  home: string;
  configHome: string;
  channel: string;
  publicKey: () => string;
  minGeneration?: number;
  isQuarantined?: (digest: string) => boolean;
  hasInstalledRelease?: (digest: string) => boolean;
  fetchImpl?: typeof fetch;
}): Promise<ChannelSyncResult | null> {
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(channel)) {
    throw new Error(`Invalid Cloud Shelf channel name: ${channel}`);
  }
  const { cloudShelfUrl, readToken } = await readShelfConfig(configHome);
  const { base, request } = buildShelfRequest(cloudShelfUrl, readToken, fetchImpl);
  const trustedKey = publicKey();
  const chanRes = await request(`${base}/channels/${channel}.json`);
  if (chanRes.status === 404) return null;
  const channelEnvelope = await readDownloadJson(chanRes);
  if (!verifySignedEnvelope(channelEnvelope, trustedKey)) {
    throw new Error("Invalid Cloud Shelf channel signature");
  }
  const payload = channelManifestSchema.parse(channelEnvelope.payload);
  if (payload.channel !== channel) throw new Error("Cloud Shelf channel name mismatch");
  const pointer = payload.surfaces["electron-web"];
  if (!pointer || pointer.runtimeVersion !== DESKTOP_RUNTIME_VERSION) return null;
  if (payload.generation < minGeneration || isQuarantined(pointer.releaseDigest)) return null;

  const surface = await prepareReleaseStore(home);
  const channelsDir = path.join(surface, "channels");
  await mkdir(channelsDir, { recursive: true, mode: 0o700 });
  const channelDest =
    channel === "prod"
      ? path.join(surface, "channel.json")
      : path.join(channelsDir, `${channel}.json`);

  const cached = await readCachedChannelMeta(channelDest, trustedKey);
  if (payload.generation < cached.generation) return null;

  const alreadyInstalled = hasInstalledRelease(pointer.releaseDigest);
  if (
    payload.generation === cached.generation &&
    pointer.releaseDigest === cached.digest &&
    alreadyInstalled
  ) {
    return {
      updated: false,
      digest: pointer.releaseDigest,
      generation: payload.generation,
      summary: pointer.summary,
    };
  }

  const staging = await mkdtemp(path.join(surface, ".cloud-"));
  try {
    if (!alreadyInstalled) {
      await installReleaseFromCloud({ request, base, pointer, trustedKey, surface, staging });
    }
    const channelTmp = path.join(staging, "channel.json");
    writeFileSync(channelTmp, JSON.stringify(channelEnvelope) + "\n");
    renameSync(channelTmp, channelDest);
    return {
      updated: true,
      digest: pointer.releaseDigest,
      generation: payload.generation,
      summary: pointer.summary,
    };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export async function syncWipIndexFromCloudShelf({
  home,
  configHome,
  publicKey,
  fetchImpl = fetch,
}: {
  home: string;
  configHome: string;
  publicKey: () => string;
  fetchImpl?: typeof fetch;
}): Promise<WipBranchPointer[]> {
  const { cloudShelfUrl, readToken } = await readShelfConfig(configHome);
  const shelfUrl = new URL(cloudShelfUrl);
  if (shelfUrl.username || shelfUrl.password || shelfUrl.search || shelfUrl.hash) {
    throw new Error("Cloud Shelf URL must be an HTTPS base URL");
  }
  const base = shelfUrl.href.replace(/\/+$/, "");
  const response = await fetchImpl(`${base}/channels/wip-index.json`, {
    headers: readToken ? { Authorization: `Bearer ${readToken}` } : {},
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return [];

  const trustedKey = publicKey();
  const envelope = await readDownloadJson(response);
  if (!verifySignedEnvelope(envelope, trustedKey)) {
    throw new Error("Invalid Cloud Shelf wip-index signature");
  }
  const payload = wipIndexSchema.parse(envelope.payload);

  const surface = await prepareReleaseStore(home);
  const channelsDir = path.join(surface, "channels");
  await mkdir(channelsDir, { recursive: true, mode: 0o700 });
  const dest = path.join(channelsDir, "wip-index.json");

  let prevGen = 0;
  try {
    const existing = JSON.parse(await readFile(dest, "utf8")) as unknown;
    if (verifySignedEnvelope(existing, trustedKey)) {
      prevGen = wipIndexSchema.parse(existing.payload).generation;
    }
  } catch {
    // No previous wip-index
  }
  if (payload.generation < prevGen) {
    return [];
  }

  const staging = await mkdtemp(path.join(surface, ".wipidx-"));
  try {
    const tmp = path.join(staging, "wip-index.json");
    writeFileSync(tmp, JSON.stringify(envelope) + "\n");
    renameSync(tmp, dest);
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
  return payload.branches;
}
