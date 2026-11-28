import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { getEditablePaths } from "@getpaseo/editable-core";
import { cloneDirectoryCow } from "./clonefile.js";
import { runCli } from "./index.js";

const execFileAsync = promisify(execFile);
const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

async function captureCli(argv: string[]): Promise<{ code: number; stdout: string }> {
  let out = "";
  const origWrite = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: unknown) => {
    out += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    const code = await runCli(argv);
    return { code, stdout: out };
  } finally {
    process.stdout.write = origWrite;
  }
}

afterEach(async () => {
  delete process.env.EDITABLE_PASEO_HOME;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    await fs.rm(dir, { recursive: true, force: true });
  }
});

describe("cloneDirectoryCow + 1-slot .warm worktree pool", () => {
  it("clones directories with isolated CoW writes and preserves relative symlinks", async () => {
    const root = await makeTempDir("ed-cow-");
    const src = path.join(root, "src-nm");
    const dst = path.join(root, "dst-nm");

    await fs.mkdir(path.join(src, "@getpaseo"), { recursive: true });
    await fs.mkdir(path.join(src, "pkg-a"), { recursive: true });
    await fs.writeFile(path.join(src, "pkg-a", "index.js"), "module.exports = 'orig';\n");
    await fs.symlink("../../packages/app", path.join(src, "@getpaseo", "app"));

    const method = await cloneDirectoryCow(src, dst);
    expect(["clonefile", "cp-cow", "cp"]).toContain(method);

    // Symlink target is preserved verbatim (CLONE_NOFOLLOW), not dereferenced
    expect(await fs.readlink(path.join(dst, "@getpaseo", "app"))).toBe("../../packages/app");

    // Mutating the clone never mutates the source (isolated CoW)
    await fs.writeFile(path.join(dst, "pkg-a", "index.js"), "module.exports = 'mutated';\n");
    expect(await fs.readFile(path.join(src, "pkg-a", "index.js"), "utf8")).toContain("orig");
  });

  it("claims warm slot instantly, fast-refreshes on code commits, and invalidates on lockfile/mtime change", async () => {
    const root = await makeTempDir("ed-warm-pool-");
    const originBare = path.join(root, "origin.git");
    const seed = path.join(root, "seed");
    const edHome = path.join(root, "editable-home");

    await fs.mkdir(originBare, { recursive: true });
    await git(["init", "--bare", "-b", "paseo-customizations"], originBare);
    await fs.mkdir(path.join(seed, "packages", "app", "src"), { recursive: true });
    await git(["init", "-b", "paseo-customizations"], seed);
    await git(["config", "user.email", "test@example.com"], seed);
    await git(["config", "user.name", "Test User"], seed);
    await fs.writeFile(path.join(seed, ".gitignore"), "node_modules/\n", "utf8");
    await fs.writeFile(path.join(seed, "package-lock.json"), '{"lockfileVersion":3,"v":1}\n');
    await fs.writeFile(
      path.join(seed, "packages", "app", "src", "home.ts"),
      "export const v = 1;\n",
    );
    await git(["add", "-A"], seed);
    await git(["commit", "-m", "initial"], seed);
    await git(["remote", "add", "origin", originBare], seed);
    await git(["push", "-u", "origin", "paseo-customizations"], seed);

    process.env.EDITABLE_PASEO_HOME = edHome;
    const paths = getEditablePaths(edHome);
    expect(
      (
        await captureCli([
          "init",
          "--repo",
          originBare,
          "--branch",
          "paseo-customizations",
          "--json",
        ])
      ).code,
    ).toBe(0);

    // Seed fake node_modules in base repo clone
    await fs.mkdir(path.join(paths.repoDir, "node_modules", "sample"), { recursive: true });
    await fs.writeFile(
      path.join(paths.repoDir, "node_modules", "sample", "index.js"),
      "module.exports = 'v1';\n",
    );

    // 1. Warm the 1-slot standby pool
    const warm1 = JSON.parse((await captureCli(["wip", "warm", "--json"])).stdout);
    expect(warm1.ok).toBe(true);
    expect(warm1.warmed).toBe(true);
    expect(warm1.depsBootstrapped).toBe(true);

    // Standby pool must stay invisible to `wip ls` and `branches`
    const lsBefore = JSON.parse((await captureCli(["wip", "ls", "--json"])).stdout);
    expect(lsBefore.worktrees).toEqual([]);
    const branchesBefore = JSON.parse((await captureCli(["branches", "--json"])).stdout);
    expect(branchesBefore.branches).toEqual([]);

    // 2. Second `wip warm` with unchanged repo is an instant no-op
    const warm2 = JSON.parse((await captureCli(["wip", "warm", "--json"])).stdout);
    expect(warm2.warmed).toBe(false);
    expect(warm2.reason).toBe("already-warm");

    // 3. `wip create` claims the warm slot with deps already ready
    const created1 = JSON.parse(
      (await captureCli(["wip", "create", "instant-branch", "--summary", "Fast edit", "--json"]))
        .stdout,
    );
    expect(created1.claimedWarmSlot).toBe(true);
    expect(created1.depsBootstrapped).toBe(true);
    expect(
      await fs.readFile(
        path.join(paths.worktreesDir, "instant-branch", "node_modules", "sample", "index.js"),
        "utf8",
      ),
    ).toContain("v1");
    expect(
      await git(["status", "--porcelain"], path.join(paths.worktreesDir, "instant-branch")),
    ).toBe("");

    // 4. Warm again, then advance baseBranch with a code-only commit (no lockfile change)
    expect(JSON.parse((await captureCli(["wip", "warm", "--json"])).stdout).warmed).toBe(true);
    await fs.writeFile(
      path.join(seed, "packages", "app", "src", "home.ts"),
      "export const v = 2;\n",
    );
    await git(["add", "-A"], seed);
    await git(["commit", "-m", "code only"], seed);
    await git(["push", "origin", "paseo-customizations"], seed);
    await git(["fetch", "origin", "paseo-customizations"], paths.repoDir);
    await git(
      ["branch", "-f", "paseo-customizations", "origin/paseo-customizations"],
      paths.repoDir,
    );

    const warmRefresh = JSON.parse((await captureCli(["wip", "warm", "--json"])).stdout);
    expect(warmRefresh.warmed).toBe(true);
    expect(warmRefresh.refreshed).toBe(true);

    // Claiming after fast-refresh yields the new code commit + cloned deps
    const created2 = JSON.parse(
      (await captureCli(["wip", "create", "after-refresh", "--json"])).stdout,
    );
    expect(created2.claimedWarmSlot).toBe(true);
    expect(
      await fs.readFile(
        path.join(paths.worktreesDir, "after-refresh", "packages", "app", "src", "home.ts"),
        "utf8",
      ),
    ).toContain("v = 2");

    // 5. Stamp invalidation: warm, then change package-lock.json on baseBranch -> must NOT claim stale warm slot
    expect(JSON.parse((await captureCli(["wip", "warm", "--json"])).stdout).warmed).toBe(true);
    await fs.writeFile(path.join(seed, "package-lock.json"), '{"lockfileVersion":3,"v":2}\n');
    await git(["add", "-A"], seed);
    await git(["commit", "-m", "bump lockfile"], seed);
    await git(["push", "origin", "paseo-customizations"], seed);
    await git(["fetch", "origin", "paseo-customizations"], paths.repoDir);
    await git(
      ["branch", "-f", "paseo-customizations", "origin/paseo-customizations"],
      paths.repoDir,
    );

    const created3 = JSON.parse(
      (await captureCli(["wip", "create", "after-lock-bump", "--json"])).stdout,
    );
    expect(created3.claimedWarmSlot).toBe(false);
    expect(created3.depsBootstrapped).toBe(false);
  });
});
