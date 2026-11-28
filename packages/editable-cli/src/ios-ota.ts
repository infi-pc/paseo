import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import {
  buildExpoIosManifestFromExport,
  computeReleaseDigest,
  collectDirectoryFiles,
  generateExpoCodeSigningPair,
  readAndVerifyChannel,
  signEnvelope,
  signExpoManifestBytes,
  writeJsonAtomic,
  type ChannelManifestPayload,
  type EditableHomePaths,
} from "@getpaseo/editable-core";

const execFileAsync = promisify(execFile);

export async function ensureExpoCodeSigningKeys(
  paths: EditableHomePaths,
  force = false,
): Promise<{ privateKeyPath: string; certificatePath: string; keyId: string; created: boolean }> {
  const privateKeyPath = path.join(paths.keysDir, "expo-codesign.private.pem");
  const certificatePath = path.join(paths.keysDir, "expo-codesign.cert.pem");
  const exists = await fs
    .access(privateKeyPath)
    .then(() => true)
    .catch(() => false);
  if (exists && !force) {
    return { privateKeyPath, certificatePath, keyId: "main", created: false };
  }
  const pair = await generateExpoCodeSigningPair(paths.keysDir);
  return { ...pair, created: true };
}

export async function publishIosOtaUpdate(options: {
  paths: EditableHomePaths;
  worktreeDir: string;
  sourceSha: string;
  runtimeVersion: string;
  summary: string;
  channel: string;
  cloudShelfUrl: string;
  cloudUploadToken: string;
  skipExport?: boolean;
  fetchImpl?: typeof fetch;
}): Promise<{
  releaseDigest: string;
  updateId: string;
  generation: number;
  assetsUploaded: number;
  expoSignature: string;
}> {
  const fetchFn = options.fetchImpl ?? fetch;
  const appDir = path.join(options.worktreeDir, "packages", "app");
  const exportDir = path.join(appDir, "dist-ios-ota");

  if (!options.skipExport) {
    await execFileAsync("npm", ["run", "build:app-deps"], {
      cwd: options.worktreeDir,
      maxBuffer: 32 * 1024 * 1024,
    });
    await fs.rm(exportDir, { recursive: true, force: true });
    await execFileAsync("npx", ["expo", "export", "--platform", "ios", "--output-dir", exportDir], {
      cwd: appDir,
      env: { ...process.env, APP_VARIANT: "testflight", CI: "1" },
      maxBuffer: 32 * 1024 * 1024,
    });
  }

  const files = await collectDirectoryFiles(exportDir);
  const releaseDigest = computeReleaseDigest({
    surface: "ios-ota",
    sourceSha: options.sourceSha,
    runtimeVersion: options.runtimeVersion,
    files,
  });

  const { manifest, manifestBytes, uploadAssets } = await buildExpoIosManifestFromExport({
    exportDir,
    runtimeVersion: options.runtimeVersion,
    releaseDigest,
    sourceSha: options.sourceSha,
    cloudShelfBaseUrl: options.cloudShelfUrl,
    summary: options.summary,
  });

  const expoKeys = await ensureExpoCodeSigningKeys(options.paths, false);
  const rsaPrivateKeyPem = await fs.readFile(expoKeys.privateKeyPath, "utf8");
  const expoSignature = signExpoManifestBytes(manifestBytes, rsaPrivateKeyPem, expoKeys.keyId);

  const edPrivateKeyPem = await fs.readFile(options.paths.privateKeyPath, "utf8");
  const edPublicKeyPem = await fs.readFile(options.paths.publicKeyPath, "utf8");

  const baseUrl = options.cloudShelfUrl.replace(/\/+$/, "");
  const authHeaders = { Authorization: `Bearer ${options.cloudUploadToken}` };

  // 1. Upload every immutable asset
  const seenHashes = new Set<string>();
  let assetsUploaded = 0;
  for (const asset of uploadAssets) {
    if (seenHashes.has(asset.sha256Hex)) continue;
    seenHashes.add(asset.sha256Hex);
    const bytes = await fs.readFile(asset.localPath);
    const res = await fetchFn(asset.url, {
      method: "PUT",
      headers: { ...authHeaders, "Content-Type": asset.contentType },
      body: new Uint8Array(bytes),
    });
    if (!res.ok && res.status !== 409) {
      throw new Error(
        `Failed to upload iOS asset ${asset.sha256Hex} (${res.status}): ${await res.text()}`,
      );
    }
    if (res.status === 201) assetsUploaded++;
  }

  // 2. Upload exact Expo Updates v1 manifest bytes + expo-signature header
  const expoManifestUrl = `${baseUrl}/releases/ios-ota/${releaseDigest}/expo-manifest.json`;
  const putExpoManifest = await fetchFn(expoManifestUrl, {
    method: "PUT",
    headers: {
      ...authHeaders,
      "Content-Type": "application/json",
      "expo-signature": expoSignature,
    },
    body: new Uint8Array(manifestBytes),
  });
  if (!putExpoManifest.ok && putExpoManifest.status !== 409) {
    throw new Error(
      `Failed to upload Expo manifest (${putExpoManifest.status}): ${await putExpoManifest.text()}`,
    );
  }

  // 3. Advance signed channel manifest atomically with strictly monotonic generation
  const existingChannel = await readAndVerifyChannel(
    options.paths.electronChannelPath,
    edPublicKeyPem,
    0,
  );
  const nextGeneration = existingChannel.ok ? existingChannel.envelope.payload.generation + 1 : 1;
  const existingSurfaces = existingChannel.ok ? existingChannel.envelope.payload.surfaces : {};
  const now = new Date().toISOString();

  const channelPayload: ChannelManifestPayload = {
    schemaVersion: 1,
    kind: "channel",
    channel: options.channel,
    generation: nextGeneration,
    updatedAt: now,
    surfaces: {
      ...existingSurfaces,
      "ios-ota": {
        releaseDigest,
        sourceSha: options.sourceSha,
        runtimeVersion: options.runtimeVersion,
        archiveUrl: manifest.launchAsset.url,
        manifestUrl: expoManifestUrl,
        summary: options.summary.slice(0, 200),
        updatedAt: now,
      },
    },
  };
  const signedChannel = signEnvelope(channelPayload, edPrivateKeyPem, edPublicKeyPem);

  const putChannel = await fetchFn(`${baseUrl}/channels/${options.channel}.json`, {
    method: "PUT",
    headers: { ...authHeaders, "Content-Type": "application/json" },
    body: JSON.stringify(signedChannel),
  });
  if (!putChannel.ok) {
    throw new Error(
      `Failed to advance cloud channel (${putChannel.status}): ${await putChannel.text()}`,
    );
  }

  await writeJsonAtomic(options.paths.electronChannelPath, signedChannel);

  return {
    releaseDigest,
    updateId: manifest.id,
    generation: nextGeneration,
    assetsUploaded,
    expoSignature,
  };
}
