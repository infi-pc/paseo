import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { getEditablePaths, writeJsonAtomic } from "@getpaseo/editable-core";
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

describe("autoPush on ship and git-sync", () => {
  it("auto-pushes on ship when config.autoPush is true, soft-warns when offline, and retries via git-sync", async () => {
    const root = await makeTempDir("ed-git-sync-");
    const originBare = path.join(root, "origin.git");
    const seed = path.join(root, "seed");
    const edHome = path.join(root, "editable-home");

    await fs.mkdir(originBare, { recursive: true });
    await git(["init", "--bare", "-b", "paseo-customizations"], originBare);
    await fs.mkdir(path.join(seed, "packages", "app", "src"), { recursive: true });
    await git(["init", "-b", "paseo-customizations"], seed);
    await git(["config", "user.email", "test@example.com"], seed);
    await git(["config", "user.name", "Test User"], seed);
    await fs.writeFile(path.join(seed, ".gitignore"), "packages/app/dist/\n");
    await fs.writeFile(path.join(seed, "packages", "app", "src", "a.ts"), "export const a = 1;\n");
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

    // Enable autoPush in config.json
    const cfg = JSON.parse(await fs.readFile(paths.configPath, "utf8"));
    await writeJsonAtomic(paths.configPath, { ...cfg, autoPush: true });

    // 1. Ship a WIP without passing --push -> should auto-push to origin!
    expect((await captureCli(["wip", "create", "auto-pushed", "--json"])).code).toBe(0);
    const wt1 = path.join(paths.worktreesDir, "auto-pushed");
    await fs.writeFile(path.join(wt1, "packages", "app", "src", "a.ts"), "export const a = 2;\n");
    await fs.mkdir(path.join(wt1, "packages", "app", "dist"), { recursive: true });
    await fs.writeFile(path.join(wt1, "packages", "app", "dist", "index.html"), "<html>2</html>");

    const ship1 = await captureCli([
      "ship",
      "auto-pushed",
      "--summary",
      "Auto push test",
      "--skip-verify",
      "--skip-export",
      "--json",
    ]);
    expect(ship1.code).toBe(0);
    const ship1Json = JSON.parse(ship1.stdout);
    expect(ship1Json.pushed).toBe(true);
    expect(ship1Json.pushWarning).toBeNull();
    expect(await git(["rev-parse", "refs/heads/paseo-customizations"], originBare)).toBe(
      ship1Json.landedSha,
    );

    // 2. Simulate offline remote -> ship still succeeds locally with pushWarning, then git-sync pushes once back online
    await git(["remote", "set-url", "origin", path.join(root, "missing.git")], paths.repoDir);
    expect((await captureCli(["wip", "create", "offline-ship", "--json"])).code).toBe(0);
    const wt2 = path.join(paths.worktreesDir, "offline-ship");
    await fs.writeFile(path.join(wt2, "packages", "app", "src", "a.ts"), "export const a = 3;\n");
    await fs.mkdir(path.join(wt2, "packages", "app", "dist"), { recursive: true });
    await fs.writeFile(path.join(wt2, "packages", "app", "dist", "index.html"), "<html>3</html>");

    const ship2 = await captureCli([
      "ship",
      "offline-ship",
      "--summary",
      "Offline ship test",
      "--skip-verify",
      "--skip-export",
      "--json",
    ]);
    expect(ship2.code).toBe(0);
    const ship2Json = JSON.parse(ship2.stdout);
    expect(ship2Json.pushed).toBe(false);
    expect(typeof ship2Json.pushWarning).toBe("string");

    // Restore remote and run git-sync -> pushes queued commit automatically
    await git(["remote", "set-url", "origin", originBare], paths.repoDir);
    const syncPush = JSON.parse((await captureCli(["git-sync", "--json"])).stdout);
    expect(syncPush.status).toBe("pushed");
    expect(syncPush.updated).toBe(true);
    expect(await git(["rev-parse", "refs/heads/paseo-customizations"], originBare)).toBe(
      ship2Json.landedSha,
    );

    // 3. Remote advances from another machine -> git-sync fast-forwards local baseBranch
    await git(["pull", "--ff-only", "origin", "paseo-customizations"], seed);
    await fs.writeFile(path.join(seed, "packages", "app", "src", "a.ts"), "export const a = 4;\n");
    await git(["add", "-A"], seed);
    await git(["commit", "-m", "remote commit"], seed);
    await git(["push", "origin", "paseo-customizations"], seed);
    const remoteHead = await git(["rev-parse", "HEAD"], seed);

    const syncFf = JSON.parse((await captureCli(["git-sync", "--json"])).stdout);
    expect(syncFf.status).toBe("fast-forwarded");
    expect(syncFf.updated).toBe(true);
    expect(syncFf.localSha).toBe(remoteHead);
    expect(await git(["rev-parse", "refs/heads/paseo-customizations"], paths.repoDir)).toBe(
      remoteHead,
    );
  });
});
