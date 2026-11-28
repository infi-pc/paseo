import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  DAEMON_RUNTIME_VERSION,
  DESKTOP_RUNTIME_VERSION,
  readDeviceState,
  resolveSurfaceReleasesDir,
  validateChannelManifestPayload,
  verifyAndExtractReleaseArchive,
  verifySignedEnvelope,
  writeJsonAtomic,
  type ChannelManifestPayload,
  type ChannelSurfacePointer,
  type DeviceState,
  type EditableHomePaths,
  type ReleaseManifestPayload,
  type SignedEnvelope,
} from "@getpaseo/editable-core";

interface CloudSyncResult {
  updated: boolean;
  reason?: string;
  releaseDigest: string | null;
  daemonReleaseDigest?: string | null;
  generation: number;
}

function shouldSyncSurface(input: {
  pointer: ChannelSurfacePointer | undefined;
  expectedRuntime: string;
  quarantined: string[];
  activeDigest: string | null;
  activeGeneration: number;
  channelGeneration: number;
}): boolean {
  const { pointer } = input;
  if (!pointer || pointer.runtimeVersion !== input.expectedRuntime) return false;
  if (input.quarantined.includes(pointer.releaseDigest)) return false;
  return (
    pointer.releaseDigest !== input.activeDigest || input.channelGeneration > input.activeGeneration
  );
}

function buildNoOpSyncResult(input: {
  uiPointer: ChannelSurfacePointer | undefined;
  daemonPointer: ChannelSurfacePointer | undefined;
  expectedUiRuntime: string;
  deviceState: DeviceState;
  channelGeneration: number;
  currentMaxGen: number;
}): CloudSyncResult {
  const base = {
    updated: false,
    releaseDigest: input.deviceState.activeDigest,
    daemonReleaseDigest: input.deviceState.activeDaemonDigest ?? null,
  };
  if (!input.uiPointer && !input.daemonPointer) {
    return {
      ...base,
      reason: "Channel has no electron-web or daemon release",
      generation: input.channelGeneration,
    };
  }
  if (input.uiPointer && input.uiPointer.runtimeVersion !== input.expectedUiRuntime) {
    return {
      ...base,
      reason: `Incompatible desktop runtime (${input.uiPointer.runtimeVersion} != ${input.expectedUiRuntime})`,
      generation: input.deviceState.activeGeneration,
    };
  }
  if (
    input.uiPointer &&
    input.deviceState.quarantinedDigests.includes(input.uiPointer.releaseDigest)
  ) {
    return {
      ...base,
      reason: `Release ${input.uiPointer.releaseDigest.slice(0, 12)} is quarantined on this device`,
      generation: input.deviceState.activeGeneration,
    };
  }
  return { ...base, reason: "Already up to date", generation: input.currentMaxGen };
}

async function downloadAndExtractSurface(options: {
  paths: EditableHomePaths;
  surface: "electron-web" | "daemon";
  pointer: ChannelSurfacePointer;
  expectedRuntime: string;
  publicKeyPem: string;
  headers: Record<string, string>;
  fetchFn: typeof fetch;
}): Promise<void> {
  const releaseDir = path.join(
    resolveSurfaceReleasesDir(options.paths, options.surface),
    options.pointer.releaseDigest,
  );
  const manifestRes = await options.fetchFn(options.pointer.manifestUrl, {
    headers: options.headers,
  });
  if (!manifestRes.ok) {
    throw new Error(`Failed to fetch ${options.surface} release manifest (${manifestRes.status})`);
  }
  const signedManifest = (await manifestRes.json()) as SignedEnvelope<ReleaseManifestPayload>;

  const archiveRes = await options.fetchFn(options.pointer.archiveUrl, {
    headers: options.headers,
  });
  if (!archiveRes.ok) {
    throw new Error(`Failed to fetch ${options.surface} release archive (${archiveRes.status})`);
  }
  const archiveBytes = Buffer.from(await archiveRes.arrayBuffer());

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), `ed-cloud-sync-${options.surface}-`));
  try {
    const tmpArchive = path.join(tmpDir, "archive.tar.gz");
    await fs.writeFile(tmpArchive, archiveBytes);
    await verifyAndExtractReleaseArchive({
      archivePath: tmpArchive,
      signedManifest,
      publicKeyPem: options.publicKeyPem,
      expectedSurface: options.surface,
      expectedRuntimeVersion: options.expectedRuntime,
      targetDir: releaseDir,
    });
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
}

async function fetchVerifiedCloudChannel(options: {
  fetchFn: typeof fetch;
  baseUrl: string;
  channel: string;
  headers: Record<string, string>;
  publicKeyPem: string;
}): Promise<{ rawEnvelope: unknown; channel: ChannelManifestPayload } | null> {
  const chanRes = await options.fetchFn(`${options.baseUrl}/channels/${options.channel}.json`, {
    headers: options.headers,
  });
  if (chanRes.status === 404) return null;
  if (!chanRes.ok) {
    throw new Error(`Failed to fetch cloud channel (${chanRes.status}): ${await chanRes.text()}`);
  }
  const rawEnvelope = (await chanRes.json()) as unknown;
  const verified = verifySignedEnvelope<ChannelManifestPayload>(rawEnvelope, options.publicKeyPem);
  if (!verified.ok) {
    throw new Error(`Cloud channel Ed25519 signature invalid: ${verified.error}`);
  }
  const validated = validateChannelManifestPayload(verified.payload);
  if (!validated.ok) {
    throw new Error(`Cloud channel payload invalid: ${validated.error}`);
  }
  return { rawEnvelope, channel: validated.value };
}

function buildSyncedDeviceState(
  deviceState: DeviceState,
  channelGeneration: number,
  uiDigest: string | null,
  daemonDigest: string | null,
): DeviceState {
  const nextState: DeviceState = { ...deviceState };
  if (uiDigest) {
    nextState.activeDigest = uiDigest;
    nextState.activeGeneration = channelGeneration;
  }
  if (daemonDigest) {
    nextState.activeDaemonDigest = daemonDigest;
    nextState.activeDaemonGeneration = channelGeneration;
  }
  return nextState;
}

function resolveSyncTargets(
  channel: ChannelManifestPayload,
  deviceState: DeviceState,
  expectedUiRuntime: string,
  expectedDaemonRuntime: string,
) {
  const uiPointer = channel.surfaces["electron-web"];
  const daemonPointer = channel.surfaces.daemon;
  const uiTarget = shouldSyncSurface({
    pointer: uiPointer,
    expectedRuntime: expectedUiRuntime,
    quarantined: deviceState.quarantinedDigests,
    activeDigest: deviceState.activeDigest,
    activeGeneration: deviceState.activeGeneration,
    channelGeneration: channel.generation,
  })
    ? uiPointer
    : undefined;
  const daemonTarget = shouldSyncSurface({
    pointer: daemonPointer,
    expectedRuntime: expectedDaemonRuntime,
    quarantined: deviceState.quarantinedDaemonDigests ?? [],
    activeDigest: deviceState.activeDaemonDigest ?? null,
    activeGeneration: deviceState.activeDaemonGeneration ?? 0,
    channelGeneration: channel.generation,
  })
    ? daemonPointer
    : undefined;
  return { uiPointer, daemonPointer, uiTarget, daemonTarget };
}

/**
 * Pulls the latest signed channel manifest from the untrusted Cloud Shelf Worker,
 * verifies its Ed25519 signature + monotonic generation against our pinned local
 * public key, downloads & verifies the signed electron-web archive, extracts it
 * immutably into ~/.editable-paseo/releases/electron-web/<digest>/, and updates
 * local channel.json + device-state.json so Electron Desktop activates it cleanly.
 */
export async function syncElectronFromCloudShelf(options: {
  paths: EditableHomePaths;
  cloudShelfUrl: string;
  channel: string;
  readToken?: string | null;
  expectedRuntimeVersion?: string;
  expectedDaemonRuntimeVersion?: string;
  fetchImpl?: typeof fetch;
}): Promise<CloudSyncResult> {
  const fetchFn = options.fetchImpl ?? fetch;
  const publicKeyPem = await fs.readFile(options.paths.publicKeyPath, "utf8");
  const deviceState = await readDeviceState(options.paths.deviceStatePath);
  const baseUrl = options.cloudShelfUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = options.readToken
    ? { Authorization: `Bearer ${options.readToken}` }
    : {};

  const fetched = await fetchVerifiedCloudChannel({
    fetchFn,
    baseUrl,
    channel: options.channel,
    headers,
    publicKeyPem,
  });
  if (!fetched) {
    return {
      updated: false,
      reason: "No channel manifest published on Cloud Shelf yet",
      releaseDigest: deviceState.activeDigest,
      daemonReleaseDigest: deviceState.activeDaemonDigest ?? null,
      generation: deviceState.activeGeneration,
    };
  }

  const { rawEnvelope, channel } = fetched;
  const currentMaxGen = Math.max(
    deviceState.activeGeneration,
    deviceState.activeDaemonGeneration ?? 0,
  );
  if (channel.generation < currentMaxGen) {
    throw new Error(
      `Cloud channel generation rollback rejected (${channel.generation} < ${currentMaxGen})`,
    );
  }

  const expectedUiRuntime = options.expectedRuntimeVersion ?? DESKTOP_RUNTIME_VERSION;
  const expectedDaemonRuntime = options.expectedDaemonRuntimeVersion ?? DAEMON_RUNTIME_VERSION;
  const { uiPointer, daemonPointer, uiTarget, daemonTarget } = resolveSyncTargets(
    channel,
    deviceState,
    expectedUiRuntime,
    expectedDaemonRuntime,
  );

  if (!uiTarget && !daemonTarget) {
    return buildNoOpSyncResult({
      uiPointer,
      daemonPointer,
      expectedUiRuntime,
      deviceState,
      channelGeneration: channel.generation,
      currentMaxGen,
    });
  }

  if (uiTarget) {
    await downloadAndExtractSurface({
      paths: options.paths,
      surface: "electron-web",
      pointer: uiTarget,
      expectedRuntime: expectedUiRuntime,
      publicKeyPem,
      headers,
      fetchFn,
    });
  }
  if (daemonTarget) {
    await downloadAndExtractSurface({
      paths: options.paths,
      surface: "daemon",
      pointer: daemonTarget,
      expectedRuntime: expectedDaemonRuntime,
      publicKeyPem,
      headers,
      fetchFn,
    });
  }

  await writeJsonAtomic(options.paths.electronChannelPath, rawEnvelope);
  const nextState = buildSyncedDeviceState(
    deviceState,
    channel.generation,
    uiTarget?.releaseDigest ?? null,
    daemonTarget?.releaseDigest ?? null,
  );
  await writeJsonAtomic(options.paths.deviceStatePath, nextState);

  return {
    updated: true,
    releaseDigest: nextState.activeDigest,
    daemonReleaseDigest: nextState.activeDaemonDigest ?? null,
    generation: channel.generation,
  };
}
