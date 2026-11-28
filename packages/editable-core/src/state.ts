import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { verifySignedEnvelope } from "./crypto.js";
import {
  EDITABLE_READER_VERSION,
  EDITABLE_STATE_SCHEMA_VERSION,
  IncompatibleStateError,
  checkOnDiskVersion,
  type ChannelManifestPayload,
  type DeviceState,
  type WipIndexPayload,
} from "./schema.js";
import {
  DAEMON_RUNTIME_VERSION,
  DESKTOP_RUNTIME_VERSION,
  validateChannelManifestPayload,
  validateWipIndexPayload,
  type EditableConfig,
  type SignedEnvelope,
} from "./types.js";

export function resolveEditableHome(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.EDITABLE_PASEO_HOME?.trim();
  if (override && override.length > 0) {
    return path.resolve(override);
  }
  return path.join(os.homedir(), ".editable-paseo");
}

export interface EditableHomePaths {
  home: string;
  configPath: string;
  keysDir: string;
  privateKeyPath: string;
  publicKeyPath: string;
  repoDir: string;
  worktreesDir: string;
  branchesDir: string;
  electronReleasesDir: string;
  daemonReleasesDir: string;
  electronChannelsDir: string;
  electronChannelPath: string;
  wipIndexPath: string;
  deviceStatePath: string;
}

export function getEditablePaths(home = resolveEditableHome()): EditableHomePaths {
  const electronReleasesDir = path.join(home, "releases", "electron-web");
  const daemonReleasesDir = path.join(home, "releases", "daemon");
  const electronChannelsDir = path.join(electronReleasesDir, "channels");
  return {
    home,
    configPath: path.join(home, "config.json"),
    keysDir: path.join(home, "keys"),
    privateKeyPath: path.join(home, "keys", "signing.private.pem"),
    publicKeyPath: path.join(home, "keys", "signing.public.pem"),
    repoDir: path.join(home, "repo"),
    worktreesDir: path.join(home, "worktrees"),
    branchesDir: path.join(home, "branches"),
    electronReleasesDir,
    daemonReleasesDir,
    electronChannelsDir,
    electronChannelPath: path.join(electronReleasesDir, "channel.json"),
    wipIndexPath: path.join(electronChannelsDir, "wip-index.json"),
    deviceStatePath: path.join(home, "device-state.json"),
  };
}

export function resolveSurfaceReleasesDir(
  paths: EditableHomePaths,
  surface: "electron-web" | "daemon",
): string {
  return surface === "daemon" ? paths.daemonReleasesDir : paths.electronReleasesDir;
}

export function resolveChannelFilePath(
  paths: EditableHomePaths,
  channel: string,
  defaultChannel = "prod",
): string {
  if (channel === defaultChannel) return paths.electronChannelPath;
  return path.join(paths.electronChannelsDir, `${channel}.json`);
}

export async function writeJsonAtomic(
  filePath: string,
  data: unknown,
  mode?: number,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmpPath, `${JSON.stringify(data, null, 2)}\n`, {
    encoding: "utf8",
    ...(mode !== undefined ? { mode } : {}),
  });
  await fs.rename(tmpPath, filePath);
}

export function defaultDeviceState(): DeviceState {
  return {
    schemaVersion: EDITABLE_STATE_SCHEMA_VERSION,
    minReaderVersion: EDITABLE_READER_VERSION,
    activeDigest: null,
    lastKnownGoodDigest: null,
    quarantinedDigests: [],
    previewUrl: null,
    activeGeneration: 0,
  };
}

function normalizeDeviceState(raw: Partial<DeviceState>): DeviceState {
  return {
    schemaVersion: EDITABLE_STATE_SCHEMA_VERSION,
    minReaderVersion: EDITABLE_READER_VERSION,
    activeDigest: typeof raw.activeDigest === "string" ? raw.activeDigest : null,
    lastKnownGoodDigest:
      typeof raw.lastKnownGoodDigest === "string" ? raw.lastKnownGoodDigest : null,
    quarantinedDigests: Array.isArray(raw.quarantinedDigests)
      ? raw.quarantinedDigests.filter((d): d is string => typeof d === "string")
      : [],
    previewUrl: typeof raw.previewUrl === "string" ? raw.previewUrl : null,
    activeGeneration:
      typeof raw.activeGeneration === "number" && Number.isInteger(raw.activeGeneration)
        ? raw.activeGeneration
        : 0,
    ...(typeof raw.activeChannel === "string" ? { activeChannel: raw.activeChannel } : {}),
    ...(raw.activeDaemonDigest === null || typeof raw.activeDaemonDigest === "string"
      ? { activeDaemonDigest: raw.activeDaemonDigest }
      : {}),
    ...(raw.lastKnownGoodDaemonDigest === null || typeof raw.lastKnownGoodDaemonDigest === "string"
      ? { lastKnownGoodDaemonDigest: raw.lastKnownGoodDaemonDigest }
      : {}),
    ...(Array.isArray(raw.quarantinedDaemonDigests)
      ? {
          quarantinedDaemonDigests: raw.quarantinedDaemonDigests.filter(
            (d): d is string => typeof d === "string",
          ),
        }
      : {}),
    ...(typeof raw.activeDaemonGeneration === "number" &&
    Number.isInteger(raw.activeDaemonGeneration)
      ? { activeDaemonGeneration: raw.activeDaemonGeneration }
      : {}),
  };
}

export async function readDeviceState(filePath: string): Promise<DeviceState> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    const version = checkOnDiskVersion(parsed, EDITABLE_READER_VERSION);
    if (!version.ok) {
      throw new IncompatibleStateError(version);
    }
    return normalizeDeviceState(parsed as Partial<DeviceState>);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultDeviceState();
    }
    throw err;
  }
}

export async function readEditableConfig(filePath: string): Promise<EditableConfig | null> {
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    const version = checkOnDiskVersion(parsed, EDITABLE_READER_VERSION);
    if (!version.ok) {
      if (version.reason === "reader_too_old") {
        throw new IncompatibleStateError(version);
      }
      return null;
    }
    const raw = parsed as Partial<EditableConfig>;
    if (typeof raw.sourceRepoUrl !== "string") {
      return null;
    }
    return {
      schemaVersion: EDITABLE_STATE_SCHEMA_VERSION,
      minReaderVersion: EDITABLE_READER_VERSION,
      sourceRepoUrl: raw.sourceRepoUrl,
      baseBranch: raw.baseBranch ?? "paseo-customizations",
      workshopHome: raw.workshopHome ?? path.join(os.homedir(), ".paseo-workshop"),
      workshopPort: typeof raw.workshopPort === "number" ? raw.workshopPort : 6769,
      desktopRuntimeVersion: raw.desktopRuntimeVersion ?? DESKTOP_RUNTIME_VERSION,
      daemonRuntimeVersion: raw.daemonRuntimeVersion ?? DAEMON_RUNTIME_VERSION,
      cloudShelfUrl: typeof raw.cloudShelfUrl === "string" ? raw.cloudShelfUrl : null,
      channel: raw.channel ?? "prod",
      ...(raw.autoPush === true ? { autoPush: true } : {}),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw err;
  }
}

export async function readAndVerifyChannel(
  channelPath: string,
  publicKeyPem: string,
  minGeneration = 0,
): Promise<
  | { ok: true; envelope: SignedEnvelope<ChannelManifestPayload> }
  | { ok: false; error: string; notFound?: boolean }
> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(channelPath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, error: "Channel manifest not found", notFound: true };
    }
    return {
      ok: false,
      error: `Failed to read channel manifest: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const verified = verifySignedEnvelope<ChannelManifestPayload>(raw, publicKeyPem);
  if (!verified.ok) {
    return { ok: false, error: verified.error };
  }
  const validated = validateChannelManifestPayload(verified.payload);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  if (validated.value.generation < minGeneration) {
    return {
      ok: false,
      error: `Channel generation rollback rejected (${validated.value.generation} < ${minGeneration})`,
    };
  }
  return {
    ok: true,
    envelope: raw as SignedEnvelope<ChannelManifestPayload>,
  };
}

export async function readAndVerifyWipIndex(
  wipIndexPath: string,
  publicKeyPem: string,
  minGeneration = 0,
): Promise<
  | { ok: true; envelope: SignedEnvelope<WipIndexPayload> }
  | { ok: false; error: string; notFound?: boolean }
> {
  let raw: unknown;
  try {
    raw = JSON.parse(await fs.readFile(wipIndexPath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ok: false, error: "WIP index not found", notFound: true };
    }
    return {
      ok: false,
      error: `Failed to read WIP index: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const verified = verifySignedEnvelope<WipIndexPayload>(raw, publicKeyPem);
  if (!verified.ok) {
    return { ok: false, error: verified.error };
  }
  const validated = validateWipIndexPayload(verified.payload);
  if (!validated.ok) {
    return { ok: false, error: validated.error };
  }
  if (validated.value.generation < minGeneration) {
    return {
      ok: false,
      error: `WIP index generation rollback rejected (${validated.value.generation} < ${minGeneration})`,
    };
  }
  return {
    ok: true,
    envelope: raw as SignedEnvelope<WipIndexPayload>,
  };
}
