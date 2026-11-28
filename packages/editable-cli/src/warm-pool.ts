import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { writeJsonAtomic } from "@getpaseo/editable-core";
import {
  bootstrapWorktreeDependencies,
  isPidAlive,
  markWorktreeDepsReady,
  refreshWorktreeDists,
  runGit,
  validateSlug,
} from "./git.js";

interface RepoDepsStamp {
  lockfileBlobSha: string | null;
  rootNodeModulesMtimeMs: number | null;
  appNodeModulesMtimeMs: number | null;
}

interface WarmPoolMeta {
  schemaVersion: 1;
  baseSha: string;
  stamp: RepoDepsStamp;
  depsBootstrapped: boolean;
  createdAt: string;
}

interface WarmPoolResult {
  warmed: boolean;
  refreshed?: boolean;
  reason?: "busy" | "already-warm";
  baseSha?: string;
  depsBootstrapped?: boolean;
  durationMs: number;
}

interface ClaimedWarmWorktree {
  slug: string;
  branch: string;
  worktreeDir: string;
  baseSha: string;
  depsBootstrapped: boolean;
  claimedWarmSlot: true;
}

async function pathExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

async function statMtimeMs(p: string): Promise<number | null> {
  try {
    const st = await fs.stat(p);
    return Math.round(st.mtimeMs);
  } catch {
    return null;
  }
}

function warmPoolPaths(editableHome: string): {
  poolDir: string;
  slotDir: string;
  metaPath: string;
  locksDir: string;
  lockPath: string;
} {
  const poolDir = path.join(editableHome, "warm-pool");
  const locksDir = path.join(editableHome, "locks");
  return {
    poolDir,
    slotDir: path.join(poolDir, "slot"),
    metaPath: path.join(poolDir, "meta.json"),
    locksDir,
    lockPath: path.join(locksDir, "warm-pool.lock"),
  };
}

async function computeRepoDepsStamp(repoDir: string, baseSha: string): Promise<RepoDepsStamp> {
  let lockfileBlobSha: string | null = null;
  for (const name of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]) {
    const sha = await runGit(["rev-parse", `${baseSha}:${name}`], repoDir).catch(() => null);
    if (sha) {
      lockfileBlobSha = `${name}:${sha}`;
      break;
    }
  }
  const [rootNodeModulesMtimeMs, appNodeModulesMtimeMs] = await Promise.all([
    statMtimeMs(path.join(repoDir, "node_modules")),
    statMtimeMs(path.join(repoDir, "packages", "app", "node_modules")),
  ]);
  return {
    lockfileBlobSha,
    rootNodeModulesMtimeMs,
    appNodeModulesMtimeMs,
  };
}

function depsStampsEqual(a: RepoDepsStamp, b: RepoDepsStamp): boolean {
  return (
    a.lockfileBlobSha === b.lockfileBlobSha &&
    a.rootNodeModulesMtimeMs === b.rootNodeModulesMtimeMs &&
    a.appNodeModulesMtimeMs === b.appNodeModulesMtimeMs
  );
}

async function readLockPid(lockPath: string): Promise<number | null> {
  try {
    const raw = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid?: unknown };
    return typeof raw.pid === "number" ? raw.pid : null;
  } catch {
    return null;
  }
}

async function tryAcquireWarmLock(editableHome: string): Promise<(() => Promise<void>) | null> {
  const { locksDir, lockPath } = warmPoolPaths(editableHome);
  await fs.mkdir(locksDir, { recursive: true });

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await fs.writeFile(
        lockPath,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
        { flag: "wx", encoding: "utf8" },
      );
      return async () => {
        const owner = await readLockPid(lockPath);
        if (owner === process.pid || owner === null) {
          await fs.rm(lockPath, { force: true }).catch(() => undefined);
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = await readLockPid(lockPath);
      if (owner && owner !== process.pid && isPidAlive(owner)) {
        return null;
      }
      // Stale lock from a crashed worker — clean up and retry once.
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }
  return null;
}

async function readWarmMeta(metaPath: string): Promise<WarmPoolMeta | null> {
  try {
    const raw = JSON.parse(await fs.readFile(metaPath, "utf8")) as Partial<WarmPoolMeta>;
    if (
      raw.schemaVersion !== 1 ||
      typeof raw.baseSha !== "string" ||
      !raw.stamp ||
      typeof raw.stamp !== "object"
    ) {
      return null;
    }
    return raw as WarmPoolMeta;
  } catch {
    return null;
  }
}

async function removeWarmSlot(repoDir: string, slotDir: string, metaPath: string): Promise<void> {
  await fs.rm(metaPath, { force: true }).catch(() => undefined);
  if (await pathExists(slotDir)) {
    await runGit(["worktree", "remove", "--force", slotDir], repoDir).catch(() => undefined);
    await fs.rm(slotDir, { recursive: true, force: true }).catch(() => undefined);
  }
  await runGit(["worktree", "prune"], repoDir).catch(() => undefined);
}

async function isCleanWorktree(dir: string): Promise<boolean> {
  if (!(await pathExists(path.join(dir, ".git")))) return false;
  try {
    const status = await runGit(["status", "--porcelain"], dir);
    return status.length === 0;
  } catch {
    return false;
  }
}

/**
 * Ensures the 1-slot standby worktree at `<editableHome>/warm-pool/slot` is ready
 * with CoW-cloned dependencies matching the current `fromRef` lockfile and base `node_modules`.
 */
export async function warmWorktreePool(options: {
  editableHome: string;
  repoDir: string;
  fromRef: string;
}): Promise<WarmPoolResult> {
  const start = Date.now();
  const release = await tryAcquireWarmLock(options.editableHome);
  if (!release) {
    return { warmed: false, reason: "busy", durationMs: Date.now() - start };
  }

  const { poolDir, slotDir, metaPath } = warmPoolPaths(options.editableHome);
  try {
    const baseSha = await runGit(["rev-parse", options.fromRef], options.repoDir);
    const stamp = await computeRepoDepsStamp(options.repoDir, baseSha);
    const existingMeta = await readWarmMeta(metaPath);

    if (
      existingMeta &&
      depsStampsEqual(existingMeta.stamp, stamp) &&
      (await isCleanWorktree(slotDir))
    ) {
      if (existingMeta.baseSha === baseSha) {
        return {
          warmed: false,
          reason: "already-warm",
          baseSha,
          depsBootstrapped: existingMeta.depsBootstrapped,
          durationMs: Date.now() - start,
        };
      }
      // Lockfile & base node_modules unchanged — fast-forward checkout + refresh dists (~50ms).
      await runGit(["checkout", "--detach", baseSha], slotDir);
      await refreshWorktreeDists(options.repoDir, slotDir);
      const updatedMeta: WarmPoolMeta = {
        ...existingMeta,
        baseSha,
        createdAt: new Date().toISOString(),
      };
      await writeJsonAtomic(metaPath, updatedMeta);
      return {
        warmed: true,
        refreshed: true,
        baseSha,
        depsBootstrapped: existingMeta.depsBootstrapped,
        durationMs: Date.now() - start,
      };
    }

    await removeWarmSlot(options.repoDir, slotDir, metaPath);
    await fs.mkdir(poolDir, { recursive: true });
    await runGit(["worktree", "add", "--detach", slotDir, baseSha], options.repoDir);
    const depsBootstrapped = await bootstrapWorktreeDependencies(options.repoDir, slotDir);
    const meta: WarmPoolMeta = {
      schemaVersion: 1,
      baseSha,
      stamp,
      depsBootstrapped,
      createdAt: new Date().toISOString(),
    };
    await writeJsonAtomic(metaPath, meta);

    return {
      warmed: true,
      refreshed: false,
      baseSha,
      depsBootstrapped,
      durationMs: Date.now() - start,
    };
  } finally {
    await release();
  }
}

/**
 * Atomically claims the pre-warmed standby slot if present, clean, and matching the current
 * dependency stamp. Returns `null` immediately when busy, missing, or stale so `wip create`
 * can fall back to standard creation without ever blocking.
 */
export async function claimWarmWorktree(options: {
  editableHome: string;
  repoDir: string;
  worktreesDir: string;
  slug: string;
  fromRef: string;
}): Promise<ClaimedWarmWorktree | null> {
  const slug = validateSlug(options.slug);
  const branch = `ed/wip/${slug}`;
  const targetDir = path.join(options.worktreesDir, slug);

  if (await pathExists(targetDir)) {
    throw new Error(`Worktree "${slug}" already exists at ${targetDir}`);
  }
  const branchExists = await runGit(
    ["show-ref", "--verify", `refs/heads/${branch}`],
    options.repoDir,
  )
    .then(() => true)
    .catch(() => false);
  if (branchExists) {
    return null;
  }

  const release = await tryAcquireWarmLock(options.editableHome);
  if (!release) return null;

  const { slotDir, metaPath } = warmPoolPaths(options.editableHome);
  try {
    const meta = await readWarmMeta(metaPath);
    if (!meta) {
      if (await pathExists(slotDir)) {
        await removeWarmSlot(options.repoDir, slotDir, metaPath);
      }
      return null;
    }

    const baseSha = await runGit(["rev-parse", options.fromRef], options.repoDir);
    const currentStamp = await computeRepoDepsStamp(options.repoDir, baseSha);
    if (!depsStampsEqual(meta.stamp, currentStamp) || !(await isCleanWorktree(slotDir))) {
      await removeWarmSlot(options.repoDir, slotDir, metaPath);
      return null;
    }

    await fs.mkdir(options.worktreesDir, { recursive: true });
    await runGit(["worktree", "move", slotDir, targetDir], options.repoDir);
    await fs.rm(metaPath, { force: true }).catch(() => undefined);

    await runGit(["checkout", "-b", branch, baseSha], targetDir);
    if (meta.baseSha !== baseSha) {
      await refreshWorktreeDists(options.repoDir, targetDir);
    }

    const hasNm = await pathExists(path.join(targetDir, "node_modules"));
    if (hasNm) {
      await markWorktreeDepsReady(options.editableHome, slug);
    }

    return {
      slug,
      branch,
      worktreeDir: targetDir,
      baseSha,
      depsBootstrapped: hasNm,
      claimedWarmSlot: true,
    };
  } catch {
    // Any unexpected move/checkout issue falls back cleanly to standard git worktree add.
    return null;
  } finally {
    await release();
  }
}

export async function invalidateWarmPool(editableHome: string, repoDir: string): Promise<void> {
  const { slotDir, metaPath, lockPath } = warmPoolPaths(editableHome);
  const owner = await readLockPid(lockPath);
  if (owner && owner !== process.pid && isPidAlive(owner)) {
    try {
      process.kill(owner, "SIGTERM");
    } catch {
      // Already exited
    }
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline && isPidAlive(owner)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    await fs.rm(lockPath, { force: true }).catch(() => undefined);
  }
  await removeWarmSlot(repoDir, slotDir, metaPath);
}

export async function spawnBackgroundWarmPool(options: {
  editableHome: string;
  cliEntrypoint: string;
}): Promise<boolean> {
  const env = { ...process.env, EDITABLE_PASEO_HOME: options.editableHome };
  const bundledCli = process.env.PASEO_ED_CLI;
  if (bundledCli && (await pathExists(bundledCli))) {
    const child = spawn(bundledCli, ["wip", "warm"], {
      env,
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    return Boolean(child.pid);
  }
  if (!options.cliEntrypoint.endsWith(".js") || !(await pathExists(options.cliEntrypoint))) {
    return false;
  }
  const child = spawn(process.execPath, [options.cliEntrypoint, "wip", "warm"], {
    env,
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  return Boolean(child.pid);
}
