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
import { channelManifestSchema } from "./schema.js";

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
