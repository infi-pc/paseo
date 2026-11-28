import fs from "node:fs/promises";
import path from "node:path";
import {
  readAndVerifyChannel,
  readAndVerifyWipIndex,
  signEnvelope,
  wipChannelName,
  writeJsonAtomic,
  type ChannelSurfacePointer,
  type EditableConfig,
  type EditableHomePaths,
  type EditableService,
  type SignedEnvelope,
  type WipBranchPointer,
  type WipIndexPayload,
} from "@getpaseo/editable-core";
import { getBranchAheadBehind, listWipWorktrees } from "./git.js";

export interface LocalBranchMetadata {
  schemaVersion: 1;
  slug: string;
  branch: string;
  channel: string;
  title?: string | null;
  icon?: string | null;
  status: "working" | "ready" | "failed";
  summary: string;
  releaseDigest: string | null;
  daemonReleaseDigest: string | null;
  services: EditableService[];
  sourceSha: string;
  generation: number | null;
  uploadedToCloud: boolean;
  requiresDaemon: boolean;
  requiresNative: boolean;
  agentId: string | null;
  error: string | null;
  updatedAt: string;
}

function normalizeServices(raw: Partial<LocalBranchMetadata>): EditableService[] {
  if (Array.isArray(raw.services)) {
    return raw.services.filter(
      (s): s is EditableService => s === "ui" || s === "daemon" || s === "desktop" || s === "ios",
    );
  }
  const inferred: EditableService[] = [];
  if (typeof raw.releaseDigest === "string") inferred.push("ui");
  if (typeof raw.daemonReleaseDigest === "string" || raw.requiresDaemon === true) {
    inferred.push("daemon");
  }
  if (raw.requiresNative === true) inferred.push("desktop");
  return inferred;
}

function normalizeTrimmedString(value: unknown, maxLen: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLen) : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function normalizeBranchMetadataRecord(
  raw: Partial<LocalBranchMetadata>,
): LocalBranchMetadata | null {
  if (raw.schemaVersion !== 1 || typeof raw.slug !== "string") return null;
  const status = raw.status === "ready" || raw.status === "failed" ? raw.status : "working";
  return {
    schemaVersion: 1,
    slug: raw.slug,
    branch: raw.branch ?? `ed/wip/${raw.slug}`,
    channel: raw.channel ?? wipChannelName(raw.slug),
    title: normalizeTrimmedString(raw.title, 120),
    icon: normalizeTrimmedString(raw.icon, 32),
    status,
    summary: stringOrNull(raw.summary) ?? "",
    releaseDigest: stringOrNull(raw.releaseDigest),
    daemonReleaseDigest: stringOrNull(raw.daemonReleaseDigest),
    services: normalizeServices(raw),
    sourceSha: stringOrNull(raw.sourceSha) ?? "",
    generation: typeof raw.generation === "number" ? raw.generation : null,
    uploadedToCloud: raw.uploadedToCloud === true,
    requiresDaemon: raw.requiresDaemon === true,
    requiresNative: raw.requiresNative === true,
    agentId: stringOrNull(raw.agentId),
    error: stringOrNull(raw.error),
    updatedAt: stringOrNull(raw.updatedAt) ?? new Date().toISOString(),
  };
}

function branchMetaPath(paths: EditableHomePaths, slug: string): string {
  return path.join(paths.branchesDir, `${slug}.json`);
}

export async function readBranchMetadata(
  paths: EditableHomePaths,
  slug: string,
): Promise<LocalBranchMetadata | null> {
  try {
    const raw = JSON.parse(
      await fs.readFile(branchMetaPath(paths, slug), "utf8"),
    ) as Partial<LocalBranchMetadata>;
    return normalizeBranchMetadataRecord(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function writeBranchMetadata(
  paths: EditableHomePaths,
  meta: LocalBranchMetadata,
): Promise<void> {
  await writeJsonAtomic(branchMetaPath(paths, meta.slug), meta);
}

export async function deleteBranchMetadata(paths: EditableHomePaths, slug: string): Promise<void> {
  await fs.rm(branchMetaPath(paths, slug), { force: true });
}

async function listAllBranchMetadata(paths: EditableHomePaths): Promise<LocalBranchMetadata[]> {
  let files: string[];
  try {
    files = await fs.readdir(paths.branchesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const results: LocalBranchMetadata[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith(".json")) continue;
    const slug = file.slice(0, -".json".length);
    const meta = await readBranchMetadata(paths, slug).catch(() => null);
    if (meta) results.push(meta);
  }
  return results;
}

function toWipBranchPointer(meta: LocalBranchMetadata): WipBranchPointer {
  const pointer: WipBranchPointer = {
    slug: meta.slug,
    branch: meta.branch,
    channel: meta.channel,
    releaseDigest: meta.releaseDigest,
    daemonReleaseDigest: meta.daemonReleaseDigest,
    services: meta.services,
    sourceSha: meta.sourceSha,
    summary: meta.summary.slice(0, 200),
    requiresDaemon: meta.requiresDaemon,
    requiresNative: meta.requiresNative,
    updatedAt: meta.updatedAt,
  };
  if (meta.title) pointer.title = meta.title.slice(0, 120);
  if (meta.icon) pointer.icon = meta.icon.slice(0, 32);
  return pointer;
}

export async function publishWipIndex(options: {
  paths: EditableHomePaths;
  cloudShelfUrl?: string | null;
  cloudUploadToken?: string | null;
  fetchImpl?: typeof fetch;
}): Promise<{
  generation: number;
  branchCount: number;
  uploadedToCloud: boolean;
  envelope: SignedEnvelope<WipIndexPayload>;
}> {
  const privateKeyPem = await fs.readFile(options.paths.privateKeyPath, "utf8");
  const publicKeyPem = await fs.readFile(options.paths.publicKeyPath, "utf8");
  const fetchFn = options.fetchImpl ?? fetch;

  const existing = await readAndVerifyWipIndex(options.paths.wipIndexPath, publicKeyPem, 0);
  let nextGeneration = existing.ok ? existing.envelope.payload.generation + 1 : 1;

  // Also check remote generation if uploading so multi-device publishes never collide on 409
  const baseUrl = options.cloudShelfUrl?.replace(/\/+$/, "") ?? null;
  if (baseUrl && options.cloudUploadToken) {
    const readToken = process.env.EDITABLE_CLOUD_READ_TOKEN ?? options.cloudUploadToken;
    try {
      const remoteRes = await fetchFn(`${baseUrl}/channels/wip-index.json`, {
        headers: readToken ? { Authorization: `Bearer ${readToken}` } : {},
      });
      if (remoteRes.ok) {
        const remoteJson = (await remoteRes.json()) as { payload?: { generation?: unknown } };
        const remoteGen = remoteJson?.payload?.generation;
        if (
          typeof remoteGen === "number" &&
          Number.isInteger(remoteGen) &&
          remoteGen >= nextGeneration
        ) {
          nextGeneration = remoteGen + 1;
        }
      }
    } catch {
      // Ignore probe failures; PUT below will validate
    }
  }

  const worktrees = await listWipWorktrees(options.paths.repoDir, options.paths.worktreesDir);
  const wtSlugs = new Set(worktrees.map((w) => w.slug));
  const metas = await listAllBranchMetadata(options.paths);

  const branches: WipBranchPointer[] = metas
    .filter((m) => wtSlugs.has(m.slug) && m.sourceSha.length === 40)
    .map(toWipBranchPointer);

  const payload: WipIndexPayload = {
    schemaVersion: 1,
    kind: "wip-index",
    generation: nextGeneration,
    updatedAt: new Date().toISOString(),
    branches,
  };
  const envelope = signEnvelope(payload, privateKeyPem, publicKeyPem);

  let uploadedToCloud = false;
  if (baseUrl && options.cloudUploadToken) {
    const putRes = await fetchFn(`${baseUrl}/channels/wip-index.json`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${options.cloudUploadToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(envelope),
    });
    if (!putRes.ok) {
      throw new Error(`Cloud wip-index upload failed (${putRes.status}): ${await putRes.text()}`);
    }
    uploadedToCloud = true;
  }

  await writeJsonAtomic(options.paths.wipIndexPath, envelope);
  return {
    generation: nextGeneration,
    branchCount: branches.length,
    uploadedToCloud,
    envelope,
  };
}

function pickLatestProdPointer(
  uiPtr: ChannelSurfacePointer | null,
  daemonPtr: ChannelSurfacePointer | null,
): ChannelSurfacePointer | null {
  if (uiPtr && daemonPtr) {
    return daemonPtr.updatedAt > uiPtr.updatedAt ? daemonPtr : uiPtr;
  }
  return uiPtr ?? daemonPtr;
}

function isReleaseMatchingHead(
  meta: LocalBranchMetadata | null,
  wt: { headSha: string; dirty: boolean },
): boolean {
  if (!meta || meta.status !== "ready" || meta.sourceSha !== wt.headSha || wt.dirty) {
    return false;
  }
  return Boolean(meta.releaseDigest || meta.daemonReleaseDigest || meta.requiresDaemon);
}

function extractBranchMetaFields(slug: string, meta: LocalBranchMetadata | null) {
  if (!meta) {
    return {
      channel: wipChannelName(slug),
      title: null as string | null,
      icon: null as string | null,
      status: "working" as const,
      summary: "",
      releaseDigest: null as string | null,
      daemonReleaseDigest: null as string | null,
      services: [] as EditableService[],
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
    title: meta.title ?? null,
    icon: meta.icon ?? null,
    status: meta.status,
    summary: meta.summary,
    releaseDigest: meta.releaseDigest,
    daemonReleaseDigest: meta.daemonReleaseDigest,
    services: meta.services,
    generation: meta.generation,
    requiresDaemon: meta.requiresDaemon,
    requiresNative: meta.requiresNative,
    agentId: meta.agentId,
    error: meta.error,
    updatedAt: meta.updatedAt,
  };
}

function buildBranchSnapshotEntry(
  wt: { slug: string; branch: string | null; path: string; headSha: string; dirty: boolean },
  meta: LocalBranchMetadata | null,
  aheadBehind: { behind: number; ahead: number },
) {
  const releaseMatchesHead = isReleaseMatchingHead(meta, wt);
  const fields = extractBranchMetaFields(wt.slug, meta);
  return {
    slug: wt.slug,
    branch: wt.branch ?? `ed/wip/${wt.slug}`,
    ...fields,
    path: wt.path,
    headSha: wt.headSha,
    dirty: wt.dirty,
    aheadOfMain: aheadBehind.ahead,
    behindMain: aheadBehind.behind,
    canFastForward: aheadBehind.behind === 0 && !wt.dirty && releaseMatchesHead,
    alreadyMerged: aheadBehind.ahead === 0 && !wt.dirty && !meta,
  };
}

function buildMainSnapshot(
  config: EditableConfig,
  prodPayload: {
    generation: number;
    surfaces: { "electron-web"?: ChannelSurfacePointer; daemon?: ChannelSurfacePointer };
  } | null,
) {
  const prodPtr = prodPayload?.surfaces["electron-web"] ?? null;
  const prodDaemonPtr = prodPayload?.surfaces.daemon ?? null;
  const latestProdPtr = pickLatestProdPointer(prodPtr, prodDaemonPtr);
  return {
    channel: config.channel,
    baseBranch: config.baseBranch,
    generation: prodPayload ? prodPayload.generation : 0,
    releaseDigest: prodPtr ? prodPtr.releaseDigest : null,
    daemonReleaseDigest: prodDaemonPtr ? prodDaemonPtr.releaseDigest : null,
    sourceSha: latestProdPtr ? latestProdPtr.sourceSha : null,
    summary: latestProdPtr ? latestProdPtr.summary : null,
    updatedAt: latestProdPtr ? latestProdPtr.updatedAt : null,
  };
}

export async function listBranchesSnapshot(paths: EditableHomePaths, config: EditableConfig) {
  const pubKey = await fs.readFile(paths.publicKeyPath, "utf8").catch(() => null);
  const prodChannel = pubKey
    ? await readAndVerifyChannel(paths.electronChannelPath, pubKey, 0)
    : null;
  const prodPayload = prodChannel?.ok ? prodChannel.envelope.payload : null;

  const worktrees = await listWipWorktrees(paths.repoDir, paths.worktreesDir);
  const branches = [];

  for (const wt of worktrees) {
    const meta = await readBranchMetadata(paths, wt.slug);
    const aheadBehind = await getBranchAheadBehind(
      paths.repoDir,
      config.baseBranch,
      wt.headSha,
    ).catch(() => ({ behind: 0, ahead: 0 }));
    branches.push(buildBranchSnapshotEntry(wt, meta, aheadBehind));
  }

  return {
    main: buildMainSnapshot(config, prodPayload),
    branches,
  };
}
