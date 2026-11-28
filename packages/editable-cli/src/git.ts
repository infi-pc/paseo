import { execFile, spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { cloneDirectoryCow } from "./clonefile.js";

const execFileAsync = promisify(execFile);

export async function runGit(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
  });
  return stdout.trim();
}

export async function initDedicatedClone(options: {
  sourceRepoUrl: string;
  repoDir: string;
  baseBranch: string;
}): Promise<{ cloned: boolean; headSha: string }> {
  const gitMarker = path.join(options.repoDir, ".git");
  let exists = false;
  try {
    await fs.access(gitMarker);
    exists = true;
  } catch {
    exists = false;
  }

  if (!exists) {
    await fs.mkdir(path.dirname(options.repoDir), { recursive: true });
    await execFileAsync(
      "git",
      ["clone", "--branch", options.baseBranch, options.sourceRepoUrl, options.repoDir],
      { maxBuffer: 32 * 1024 * 1024 },
    );
    // Keep the dedicated repo detached so `baseBranch` is free for landing worktrees
    const sha = await runGit(["rev-parse", "HEAD"], options.repoDir);
    await runGit(["checkout", "--detach", sha], options.repoDir);
    return { cloned: true, headSha: sha };
  }

  await runGit(["fetch", "origin", options.baseBranch], options.repoDir).catch(() => undefined);
  const sha = await runGit(["rev-parse", "HEAD"], options.repoDir);
  return { cloned: false, headSha: sha };
}

export function validateSlug(slug: string): string {
  const clean = slug.trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-_]{0,47}$/.test(clean)) {
    throw new Error(
      `Invalid WIP slug "${slug}". Use 1-48 lowercase letters, digits, hyphens, or underscores.`,
    );
  }
  return clean;
}

async function pathExists(p: string): Promise<boolean> {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function depsLockPaths(
  editableHome: string,
  slug: string,
): {
  locksDir: string;
  lockPath: string;
  readyPath: string;
} {
  const locksDir = path.join(editableHome, "locks");
  return {
    locksDir,
    lockPath: path.join(locksDir, `${slug}.deps.lock`),
    readyPath: path.join(locksDir, `${slug}.deps.ready`),
  };
}

export async function markWorktreeDepsReady(editableHome: string, slug: string): Promise<void> {
  const { locksDir, readyPath } = depsLockPaths(editableHome, slug);
  await fs.mkdir(locksDir, { recursive: true });
  await fs.writeFile(readyPath, `${new Date().toISOString()}\n`, "utf8").catch(() => undefined);
}

async function readLockPid(lockPath: string): Promise<number | null> {
  try {
    const raw = JSON.parse(await fs.readFile(lockPath, "utf8")) as { pid?: unknown };
    return typeof raw.pid === "number" ? raw.pid : null;
  } catch {
    return null;
  }
}

async function cloneDirectory(src: string, dst: string): Promise<void> {
  if (!(await pathExists(src))) return;
  if (await pathExists(dst)) return;
  await cloneDirectoryCow(src, dst);
}

/**
 * Refreshes built internal workspace `dist` folders (excluding `packages/app/dist`)
 * in a worktree from the base clone using fast CoW cloning.
 */
export async function refreshWorktreeDists(repoDir: string, worktreeDir: string): Promise<void> {
  const packagesDir = path.join(repoDir, "packages");
  const pkgEntries = await fs.readdir(packagesDir, { withFileTypes: true }).catch(() => []);
  await Promise.all(
    pkgEntries
      .filter((entry) => entry.isDirectory() && entry.name !== "app")
      .map(async (entry) => {
        const srcDist = path.join(packagesDir, entry.name, "dist");
        const dstPkg = path.join(worktreeDir, "packages", entry.name);
        const dstDist = path.join(dstPkg, "dist");
        if (!(await pathExists(srcDist)) || !(await pathExists(dstPkg))) return;
        await fs.rm(dstDist, { recursive: true, force: true }).catch(() => undefined);
        await cloneDirectoryCow(srcDist, dstDist);
      }),
  );
}

/**
 * Refreshes `repoDir/node_modules` when a shipped commit modified a lockfile, so
 * future WIP clones and the `.warm` standby pool pick up the updated dependencies.
 */
export async function refreshBaseRepoDepsIfLockfileChanged(options: {
  repoDir: string;
  landedSha: string;
  changedFiles: string[];
}): Promise<boolean> {
  const lockfiles = new Set(["package-lock.json", "pnpm-lock.yaml", "yarn.lock"]);
  if (!options.changedFiles.some((f) => lockfiles.has(f))) return false;
  if (!(await pathExists(path.join(options.repoDir, "node_modules")))) return false;

  const dirty = await runGit(["status", "--porcelain"], options.repoDir).catch(() => "dirty");
  if (dirty.length > 0) return false;

  await runGit(["checkout", "--detach", options.landedSha], options.repoDir);
  if (await pathExists(path.join(options.repoDir, "pnpm-lock.yaml"))) {
    await execFileAsync("pnpm", ["install", "--frozen-lockfile"], {
      cwd: options.repoDir,
      maxBuffer: 32 * 1024 * 1024,
    });
  } else if (await pathExists(path.join(options.repoDir, "yarn.lock"))) {
    await execFileAsync("yarn", ["install", "--frozen-lockfile"], {
      cwd: options.repoDir,
      maxBuffer: 32 * 1024 * 1024,
    });
  } else {
    await execFileAsync("npm", ["ci"], {
      cwd: options.repoDir,
      maxBuffer: 32 * 1024 * 1024,
    });
  }
  return true;
}

/**
 * Copy-on-write clones `node_modules` and built workspace `dist` directories (except
 * `packages/app/dist`) from the dedicated repo clone into a fresh WIP worktree so
 * `paseo-ed verify` and `paseo-ed ship` work immediately without re-running `npm ci`.
 */
export async function bootstrapWorktreeDependencies(
  repoDir: string,
  worktreeDir: string,
): Promise<boolean> {
  const rootNm = path.join(repoDir, "node_modules");
  if (!(await pathExists(rootNm)) || !(await pathExists(worktreeDir))) return false;

  const tasks: Promise<void>[] = [cloneDirectory(rootNm, path.join(worktreeDir, "node_modules"))];

  const packagesDir = path.join(repoDir, "packages");
  const pkgEntries = await fs.readdir(packagesDir, { withFileTypes: true }).catch(() => []);
  for (const entry of pkgEntries) {
    if (!entry.isDirectory()) continue;
    const srcPkgDir = path.join(packagesDir, entry.name);
    const dstPkgDir = path.join(worktreeDir, "packages", entry.name);
    tasks.push(
      (async () => {
        if (!(await pathExists(dstPkgDir))) return;
        await cloneDirectory(
          path.join(srcPkgDir, "node_modules"),
          path.join(dstPkgDir, "node_modules"),
        );
        if (entry.name !== "app") {
          await cloneDirectory(path.join(srcPkgDir, "dist"), path.join(dstPkgDir, "dist"));
        }
      })(),
    );
  }
  await Promise.all(tasks);
  return true;
}

async function waitOrClearStaleDepsLock(
  lockPath: string,
  slug: string,
  deadline: number,
): Promise<boolean> {
  const ownerPid = await readLockPid(lockPath);
  if (ownerPid && ownerPid !== process.pid && isPidAlive(ownerPid)) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for worktree dependency bootstrap (${slug})`);
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    return true;
  }
  await fs.rm(lockPath, { force: true }).catch(() => undefined);
  return false;
}

async function tryWriteDepsLock(lockPath: string): Promise<boolean> {
  try {
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      { flag: "wx", encoding: "utf8" },
    );
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      return false;
    }
    throw err;
  }
}

/**
 * Lock-coordinated dependency bootstrap for a WIP worktree.
 * Safe to invoke from a detached background worker AND lazily from `verify`/`stage`/`build-electron`
 * without ever leaving partial `node_modules` or dirtying `git status`.
 */
export async function ensureWorktreeDependencies(options: {
  repoDir: string;
  worktreeDir: string;
  editableHome: string;
  slug: string;
  waitTimeoutMs?: number;
}): Promise<boolean> {
  if (path.resolve(options.worktreeDir) === path.resolve(options.repoDir)) return false;
  if (!(await pathExists(path.join(options.repoDir, "node_modules")))) return false;
  if (!(await pathExists(options.worktreeDir))) return false;

  const { locksDir, lockPath, readyPath } = depsLockPaths(options.editableHome, options.slug);
  await fs.mkdir(locksDir, { recursive: true });
  const deadline = Date.now() + (options.waitTimeoutMs ?? 180_000);

  while (true) {
    const hasNm = await pathExists(path.join(options.worktreeDir, "node_modules"));
    const hasLock = await pathExists(lockPath);
    if (hasNm && !hasLock) {
      if (!(await pathExists(readyPath))) {
        await fs
          .writeFile(readyPath, `${new Date().toISOString()}\n`, "utf8")
          .catch(() => undefined);
      }
      return true;
    }
    if (hasLock && (await waitOrClearStaleDepsLock(lockPath, options.slug, deadline))) {
      continue;
    }
    if (!(await tryWriteDepsLock(lockPath))) {
      continue;
    }
    try {
      const bootstrapped = await bootstrapWorktreeDependencies(
        options.repoDir,
        options.worktreeDir,
      );
      if (bootstrapped && (await pathExists(options.worktreeDir))) {
        await fs
          .writeFile(readyPath, `${new Date().toISOString()}\n`, "utf8")
          .catch(() => undefined);
      }
      return bootstrapped;
    } finally {
      const ownerPid = await readLockPid(lockPath);
      if (ownerPid === process.pid || ownerPid === null) {
        await fs.rm(lockPath, { force: true }).catch(() => undefined);
      }
    }
  }
}

export async function spawnBackgroundDepsBootstrap(options: {
  editableHome: string;
  repoDir: string;
  slug: string;
  cliEntrypoint: string;
}): Promise<boolean> {
  if (!(await pathExists(path.join(options.repoDir, "node_modules")))) return false;
  const env = { ...process.env, EDITABLE_PASEO_HOME: options.editableHome };
  const bundledCli = process.env.PASEO_ED_CLI;
  if (bundledCli && (await pathExists(bundledCli))) {
    const child = spawn(bundledCli, ["wip", "bootstrap-deps", options.slug], {
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
  const child = spawn(
    process.execPath,
    [options.cliEntrypoint, "wip", "bootstrap-deps", options.slug],
    {
      env,
      detached: true,
      stdio: "ignore",
    },
  );
  child.unref();
  return Boolean(child.pid);
}

export async function cancelWorktreeDepsBootstrap(
  editableHome: string,
  slug: string,
): Promise<void> {
  const { lockPath, readyPath } = depsLockPaths(editableHome, slug);
  const ownerPid = await readLockPid(lockPath);
  if (ownerPid && ownerPid !== process.pid && isPidAlive(ownerPid)) {
    try {
      process.kill(ownerPid, "SIGTERM");
    } catch {
      // Process may have exited already
    }
    const deadline = Date.now() + 1_500;
    while (Date.now() < deadline && isPidAlive(ownerPid)) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  await fs.rm(lockPath, { force: true }).catch(() => undefined);
  await fs.rm(readyPath, { force: true }).catch(() => undefined);
}

async function resolveBaseTarget(repoDir: string, baseBranch: string): Promise<string> {
  const localRef = `refs/heads/${baseBranch}`;
  const remoteRef = `refs/remotes/origin/${baseBranch}`;
  const hasLocal = await runGit(["show-ref", "--verify", localRef], repoDir)
    .then(() => true)
    .catch(() => false);
  const hasRemote = await runGit(["show-ref", "--verify", remoteRef], repoDir)
    .then(() => true)
    .catch(() => false);

  if (hasLocal && hasRemote) {
    // Only fast-forward to origin if remote is at or ahead of local; preserve unpushed local landings.
    const remoteAheadOrEqual = await runGit(
      ["merge-base", "--is-ancestor", localRef, remoteRef],
      repoDir,
    )
      .then(() => true)
      .catch(() => false);
    return remoteAheadOrEqual ? `origin/${baseBranch}` : baseBranch;
  }
  if (hasLocal) return baseBranch;
  if (hasRemote) return `origin/${baseBranch}`;
  return baseBranch;
}

export async function createWipWorktree(options: {
  repoDir: string;
  worktreesDir: string;
  slug: string;
  fromRef: string;
  skipBootstrapDeps?: boolean;
}): Promise<{
  slug: string;
  branch: string;
  worktreeDir: string;
  baseSha: string;
  depsBootstrapped: boolean;
}> {
  const slug = validateSlug(options.slug);
  const branch = `ed/wip/${slug}`;
  const worktreeDir = path.join(options.worktreesDir, slug);
  await fs.mkdir(options.worktreesDir, { recursive: true });

  try {
    await fs.access(worktreeDir);
    throw new Error(`Worktree "${slug}" already exists at ${worktreeDir}`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }

  const baseSha = await runGit(["rev-parse", options.fromRef], options.repoDir);
  await runGit(["worktree", "add", "-b", branch, worktreeDir, baseSha], options.repoDir);
  const depsBootstrapped = options.skipBootstrapDeps
    ? false
    : await bootstrapWorktreeDependencies(options.repoDir, worktreeDir);

  return { slug, branch, worktreeDir, baseSha, depsBootstrapped };
}

interface WipWorktreeInfo {
  slug: string;
  branch: string | null;
  path: string;
  headSha: string;
  dirty: boolean;
}

export async function listWipWorktrees(
  repoDir: string,
  worktreesDir: string,
): Promise<WipWorktreeInfo[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(worktreesDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }

  const results: WipWorktreeInfo[] = [];
  for (const slug of entries.sort()) {
    if (slug.startsWith(".")) continue;
    const wtPath = path.join(worktreesDir, slug);
    const stat = await fs.stat(wtPath).catch(() => null);
    if (!stat?.isDirectory()) continue;
    try {
      const headSha = await runGit(["rev-parse", "HEAD"], wtPath);
      const branchOut = await runGit(["symbolic-ref", "--short", "HEAD"], wtPath).catch(() => null);
      const statusOut = await runGit(["status", "--porcelain"], wtPath);
      results.push({
        slug,
        branch: branchOut,
        path: wtPath,
        headSha,
        dirty: statusOut.length > 0,
      });
    } catch {
      // Ignore non-git directories inside worktreesDir
    }
  }
  // Keep repoDir referenced so unused param lint never triggers
  void repoDir;
  return results;
}

export async function removeWipWorktree(options: {
  repoDir: string;
  worktreesDir: string;
  slug: string;
  deleteBranch?: boolean;
}): Promise<void> {
  const slug = validateSlug(options.slug);
  const worktreeDir = path.join(options.worktreesDir, slug);
  await runGit(["worktree", "remove", "--force", worktreeDir], options.repoDir);
  if (options.deleteBranch) {
    await runGit(["branch", "-D", `ed/wip/${slug}`], options.repoDir).catch(() => undefined);
  }
}

export async function getChangedFiles(worktreeDir: string, baseRef: string): Promise<string[]> {
  const files = new Set<string>();
  const committed = await runGit(["diff", "--name-only", `${baseRef}...HEAD`], worktreeDir).catch(
    () => "",
  );
  for (const f of committed.split(/\r?\n/)) {
    if (f.trim()) files.add(f.trim());
  }
  const unstaged = await runGit(["diff", "--name-only"], worktreeDir).catch(() => "");
  for (const f of unstaged.split(/\r?\n/)) {
    if (f.trim()) files.add(f.trim());
  }
  const staged = await runGit(["diff", "--cached", "--name-only"], worktreeDir).catch(() => "");
  for (const f of staged.split(/\r?\n/)) {
    if (f.trim()) files.add(f.trim());
  }
  const untracked = await runGit(["ls-files", "--others", "--exclude-standard"], worktreeDir).catch(
    () => "",
  );
  for (const f of untracked.split(/\r?\n/)) {
    if (f.trim()) files.add(f.trim());
  }
  return Array.from(files).sort();
}

export async function getHeadSha(dir: string): Promise<string> {
  return runGit(["rev-parse", "HEAD"], dir);
}

export async function commitWorktreeIfDirty(
  worktreeDir: string,
  summary: string,
): Promise<{ committed: boolean; headSha: string }> {
  const dirty = await runGit(["status", "--porcelain"], worktreeDir);
  if (dirty.length > 0) {
    await runGit(["add", "-A"], worktreeDir);
    await runGit(["commit", "--no-verify", "-m", summary], worktreeDir);
    return { committed: true, headSha: await runGit(["rev-parse", "HEAD"], worktreeDir) };
  }
  return { committed: false, headSha: await runGit(["rev-parse", "HEAD"], worktreeDir) };
}

export async function getBranchAheadBehind(
  repoDir: string,
  baseRef: string,
  headSha: string,
): Promise<{ behind: number; ahead: number }> {
  const out = await runGit(
    ["rev-list", "--left-right", "--count", `${baseRef}...${headSha}`],
    repoDir,
  );
  const [behindStr, aheadStr] = out.split(/\s+/);
  return {
    behind: Number(behindStr ?? 0) || 0,
    ahead: Number(aheadStr ?? 0) || 0,
  };
}

/**
 * Lands a clean commit from a WIP worktree onto `baseBranch` inside a short-lived
 * detached landing worktree. Never touches ~/www/paseo and never force-pushes.
 * When `main` has diverged, merges cleanly and updates `worktreeDir` to the merged
 * commit so subsequent rebuilds reflect the combined tree.
 */
export async function landWipBranch(options: {
  repoDir: string;
  worktreeDir: string;
  baseBranch: string;
  summary: string;
  push: boolean;
  softPush?: boolean;
}): Promise<{
  landedSha: string;
  wipSha: string;
  fastForwarded: boolean;
  pushed: boolean;
  pushWarning?: string | null;
}> {
  const { headSha: wipSha } = await commitWorktreeIfDirty(options.worktreeDir, options.summary);
  const landingDir = await fs.mkdtemp(path.join(path.dirname(options.repoDir), ".land-"));

  try {
    await runGit(["fetch", "origin", options.baseBranch], options.repoDir).catch(() => undefined);
    const baseTarget = await resolveBaseTarget(options.repoDir, options.baseBranch);

    await runGit(["worktree", "add", "--detach", landingDir, baseTarget], options.repoDir);
    // Merge WIP branch cleanly (fast-forward if linear, standard merge commit if diverged)
    await runGit(
      ["merge", "--no-edit", "-m", `Merge editable change: ${options.summary}`, wipSha],
      landingDir,
    );
    const landedSha = await runGit(["rev-parse", "HEAD"], landingDir);
    const fastForwarded = landedSha === wipSha;

    // Advance local baseBranch pointer cleanly
    await runGit(["branch", "-f", options.baseBranch, landedSha], options.repoDir);

    // If a non-fast-forward merge occurred, bring the WIP worktree onto the merged commit
    // so building from worktreeDir (which already has bootstrapped deps) builds the combined tree.
    if (!fastForwarded) {
      await runGit(["merge", "--ff-only", landedSha], options.worktreeDir).catch(async () => {
        await runGit(["reset", "--hard", landedSha], options.worktreeDir);
      });
    }

    let pushed = false;
    let pushWarning: string | null = null;
    if (options.push || options.softPush) {
      try {
        await runGit(
          ["push", "origin", `${landedSha}:refs/heads/${options.baseBranch}`],
          options.repoDir,
        );
        pushed = true;
      } catch (err) {
        if (options.push) throw err;
        pushWarning = err instanceof Error ? err.message : String(err);
      }
    }
    return { landedSha, wipSha, fastForwarded, pushed, ...(pushWarning ? { pushWarning } : {}) };
  } finally {
    await runGit(["worktree", "remove", "--force", landingDir], options.repoDir).catch(() =>
      fs.rm(landingDir, { recursive: true, force: true }),
    );
  }
}

interface GitSyncResult {
  ok: boolean;
  status: "up-to-date" | "fast-forwarded" | "pushed" | "diverged" | "offline" | "ahead-unpushed";
  updated: boolean;
  localSha: string | null;
  remoteSha: string | null;
  ahead: number;
  behind: number;
  warning?: string | null;
}

async function pushAheadBaseBranch(options: {
  repoDir: string;
  baseBranch: string;
  localSha: string;
  remoteSha: string | null;
  ahead: number;
  autoPush: boolean;
}): Promise<GitSyncResult> {
  if (!options.autoPush) {
    return {
      ok: true,
      status: "ahead-unpushed",
      updated: false,
      localSha: options.localSha,
      remoteSha: options.remoteSha,
      ahead: options.ahead,
      behind: 0,
    };
  }
  try {
    await runGit(
      ["push", "origin", `${options.localSha}:refs/heads/${options.baseBranch}`],
      options.repoDir,
    );
    return {
      ok: true,
      status: "pushed",
      updated: true,
      localSha: options.localSha,
      remoteSha: options.localSha,
      ahead: 0,
      behind: 0,
    };
  } catch (err) {
    return {
      ok: true,
      status: "ahead-unpushed",
      updated: false,
      localSha: options.localSha,
      remoteSha: options.remoteSha,
      ahead: options.ahead,
      behind: 0,
      warning: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Non-destructively synchronizes local `baseBranch` with `origin/<baseBranch>`:
 * - Fast-forwards local `baseBranch` when strictly behind `origin`.
 * - Pushes local `baseBranch` when strictly ahead and `autoPush` is enabled.
 * - Never force-pushes or drops commits when diverged or offline.
 */
export async function syncGitBaseBranch(options: {
  repoDir: string;
  baseBranch: string;
  autoPush: boolean;
}): Promise<GitSyncResult> {
  const localRef = `refs/heads/${options.baseBranch}`;
  const remoteRef = `refs/remotes/origin/${options.baseBranch}`;

  try {
    await runGit(["fetch", "origin", options.baseBranch], options.repoDir);
  } catch (err) {
    const localSha = await runGit(["rev-parse", localRef], options.repoDir).catch(() => null);
    return {
      ok: true,
      status: "offline",
      updated: false,
      localSha,
      remoteSha: null,
      ahead: 0,
      behind: 0,
      warning: err instanceof Error ? err.message : String(err),
    };
  }

  const localSha = await runGit(["rev-parse", localRef], options.repoDir).catch(() => null);
  const remoteSha = await runGit(["rev-parse", remoteRef], options.repoDir).catch(() => null);

  if (!localSha && remoteSha) {
    await runGit(["branch", "-f", options.baseBranch, remoteSha], options.repoDir);
    return {
      ok: true,
      status: "fast-forwarded",
      updated: true,
      localSha: remoteSha,
      remoteSha,
      ahead: 0,
      behind: 0,
    };
  }
  if (localSha && !remoteSha) {
    return pushAheadBaseBranch({ ...options, localSha, remoteSha: null, ahead: 1 });
  }
  if (!localSha || !remoteSha) {
    return {
      ok: true,
      status: "up-to-date",
      updated: false,
      localSha,
      remoteSha,
      ahead: 0,
      behind: 0,
    };
  }

  const counts = await runGit(
    ["rev-list", "--left-right", "--count", `${remoteSha}...${localSha}`],
    options.repoDir,
  );
  const [behindStr, aheadStr] = counts.split(/\s+/);
  const behind = Number(behindStr ?? 0) || 0;
  const ahead = Number(aheadStr ?? 0) || 0;

  if (behind === 0 && ahead === 0) {
    return {
      ok: true,
      status: "up-to-date",
      updated: false,
      localSha,
      remoteSha,
      ahead: 0,
      behind: 0,
    };
  }
  if (behind > 0 && ahead === 0) {
    await runGit(["branch", "-f", options.baseBranch, remoteSha], options.repoDir);
    return {
      ok: true,
      status: "fast-forwarded",
      updated: true,
      localSha: remoteSha,
      remoteSha,
      ahead: 0,
      behind: 0,
    };
  }
  if (ahead > 0 && behind === 0) {
    return pushAheadBaseBranch({ ...options, localSha, remoteSha, ahead });
  }
  return { ok: true, status: "diverged", updated: false, localSha, remoteSha, ahead, behind };
}

export async function createGitRevert(options: {
  repoDir: string;
  baseBranch: string;
  targetSha: string;
  push: boolean;
}): Promise<{ revertSha: string; pushed: boolean }> {
  const revertDir = await fs.mkdtemp(path.join(path.dirname(options.repoDir), ".revert-"));
  try {
    await runGit(["fetch", "origin", options.baseBranch], options.repoDir).catch(() => undefined);
    const baseTarget = await resolveBaseTarget(options.repoDir, options.baseBranch);

    await runGit(["worktree", "add", "--detach", revertDir, baseTarget], options.repoDir);
    const revLine = await runGit(
      ["rev-list", "--parents", "-n", "1", options.targetSha],
      revertDir,
    );
    const isMergeCommit = revLine.split(/\s+/).length > 2;
    const revertArgs = isMergeCommit
      ? ["revert", "--no-edit", "-m", "1", options.targetSha]
      : ["revert", "--no-edit", options.targetSha];
    await runGit(revertArgs, revertDir);
    const revertSha = await runGit(["rev-parse", "HEAD"], revertDir);
    await runGit(["branch", "-f", options.baseBranch, revertSha], options.repoDir);

    let pushed = false;
    if (options.push) {
      await runGit(
        ["push", "origin", `${revertSha}:refs/heads/${options.baseBranch}`],
        options.repoDir,
      );
      pushed = true;
    }
    return { revertSha, pushed };
  } finally {
    await runGit(["worktree", "remove", "--force", revertDir], options.repoDir).catch(() =>
      fs.rm(revertDir, { recursive: true, force: true }),
    );
  }
}
