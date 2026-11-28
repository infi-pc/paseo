import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  getEditablePaths,
  readAndVerifyChannel,
  readAndVerifyWipIndex,
} from "@getpaseo/editable-core";
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

describe("paseo-ed stage + fast-forward ship + parallel diverged ship", () => {
  it("stages on WIP branch, fast-forward promotes without rebuild, and rebuilds on parallel merge", async () => {
    const root = await makeTempDir("ed-stage-ship-");
    const originBare = path.join(root, "origin.git");
    const seed = path.join(root, "seed");
    const edHome = path.join(root, "editable-home");

    await fs.mkdir(originBare, { recursive: true });
    await git(["init", "--bare", "-b", "paseo-customizations"], originBare);

    await fs.mkdir(path.join(seed, "packages", "app", "src"), { recursive: true });
    await git(["init", "-b", "paseo-customizations"], seed);
    await git(["config", "user.email", "test@example.com"], seed);
    await git(["config", "user.name", "Test User"], seed);
    await fs.writeFile(path.join(seed, ".gitignore"), "packages/app/dist/\n", "utf8");
    await fs.writeFile(
      path.join(seed, "packages", "app", "src", "home.tsx"),
      "export const home = 'base';\n",
      "utf8",
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

    // Create two parallel WIP branches off the same base commit
    expect(
      (await captureCli(["wip", "create", "feature-a", "--summary", "Feature A", "--json"])).code,
    ).toBe(0);
    expect(
      (await captureCli(["wip", "create", "feature-b", "--summary", "Feature B", "--json"])).code,
    ).toBe(0);

    const wtA = path.join(paths.worktreesDir, "feature-a");
    const wtB = path.join(paths.worktreesDir, "feature-b");

    // Edit & stage Feature A (leave prod channel completely untouched)
    await fs.writeFile(path.join(wtA, "packages", "app", "src", "a.tsx"), "export const a = 1;\n");
    await fs.mkdir(path.join(wtA, "packages", "app", "dist"), { recursive: true });
    await fs.writeFile(path.join(wtA, "packages", "app", "dist", "index.html"), "<html>A</html>");

    const stageA = await captureCli([
      "stage",
      "feature-a",
      "--summary",
      "Add feature A",
      "--skip-verify",
      "--skip-export",
      "--json",
    ]);
    expect(stageA.code).toBe(0);
    const stageAJson = JSON.parse(stageA.stdout);
    expect(stageAJson.channel).toBe("wip-feature-a");
    expect(stageAJson.electronPublish.releaseDigest).toMatch(/^[a-f0-9]{64}$/);

    // Edit & stage Feature B in parallel
    await fs.writeFile(path.join(wtB, "packages", "app", "src", "b.tsx"), "export const b = 2;\n");
    await fs.mkdir(path.join(wtB, "packages", "app", "dist"), { recursive: true });
    await fs.writeFile(path.join(wtB, "packages", "app", "dist", "index.html"), "<html>B</html>");

    const stageB = await captureCli([
      "stage",
      "feature-b",
      "--summary",
      "Add feature B",
      "--skip-verify",
      "--skip-export",
      "--json",
    ]);
    expect(stageB.code).toBe(0);

    // Verify prod channel is STILL untouched, while wip-index has both branches
    const pubKey = await fs.readFile(paths.publicKeyPath, "utf8");
    expect((await readAndVerifyChannel(paths.electronChannelPath, pubKey)).ok).toBe(false);
    const wipIdx = await readAndVerifyWipIndex(paths.wipIndexPath, pubKey);
    expect(wipIdx.ok).toBe(true);
    if (wipIdx.ok) {
      expect(wipIdx.envelope.payload.branches.map((b) => b.slug)).toEqual([
        "feature-a",
        "feature-b",
      ]);
    }

    // Check `branches` shows both ready and fast-forward eligible
    const branchesBefore = JSON.parse((await captureCli(["branches", "--json"])).stdout);
    expect(branchesBefore.branches).toHaveLength(2);
    expect(branchesBefore.branches[0].canFastForward).toBe(true);
    expect(branchesBefore.branches[1].canFastForward).toBe(true);

    // Delete wtA's dist folder to PROVE fast-forward ship reuses the staged release without touching dist!
    await fs.rm(path.join(wtA, "packages", "app", "dist"), { recursive: true, force: true });

    const shipA = await captureCli(["ship", "feature-a", "--skip-verify", "--json"]);
    expect(shipA.code).toBe(0);
    const shipAJson = JSON.parse(shipA.stdout);
    expect(shipAJson.fastForwarded).toBe(true);
    expect(shipAJson.cleanedWorktree).toBe(true);
    expect(shipAJson.electronPublish.reusedStagedRelease).toBe(true);
    expect(shipAJson.electronPublish.releaseDigest).toBe(stageAJson.electronPublish.releaseDigest);
    expect(shipAJson.electronPublish.generation).toBe(1);

    // Now feature-b is behind main! Verify `branches` reports behindMain > 0 & canFastForward = false
    const branchesAfterA = JSON.parse((await captureCli(["branches", "--json"])).stdout);
    expect(branchesAfterA.branches).toHaveLength(1);
    expect(branchesAfterA.branches[0].slug).toBe("feature-b");
    expect(branchesAfterA.branches[0].behindMain).toBeGreaterThan(0);
    expect(branchesAfterA.branches[0].canFastForward).toBe(false);

    // Ship feature-b (parallel diverged merge) -> must NOT reuse staged release, must merge both A & B
    await fs.writeFile(path.join(wtB, "packages", "app", "dist", "index.html"), "<html>A+B</html>");
    const shipB = await captureCli([
      "ship",
      "feature-b",
      "--skip-verify",
      "--skip-export",
      "--json",
    ]);
    expect(shipB.code).toBe(0);
    const shipBJson = JSON.parse(shipB.stdout);
    expect(shipBJson.fastForwarded).toBe(false);
    expect(shipBJson.electronPublish.reusedStagedRelease).toBe(false);
    expect(shipBJson.electronPublish.generation).toBe(2);
    expect(shipBJson.cleanedWorktree).toBe(true);

    // wip-index is now empty and prod is at generation 2
    const wipIdxFinal = await readAndVerifyWipIndex(paths.wipIndexPath, pubKey);
    expect(wipIdxFinal.ok).toBe(true);
    if (wipIdxFinal.ok) {
      expect(wipIdxFinal.envelope.payload.branches).toEqual([]);
    }
    const prodFinal = await readAndVerifyChannel(paths.electronChannelPath, pubKey);
    expect(prodFinal.ok).toBe(true);
    if (prodFinal.ok) {
      expect(prodFinal.envelope.payload.generation).toBe(2);
    }
  });

  it("defers node_modules copy on wip create, writes metadata immediately, and bootstraps via wip bootstrap-deps", async () => {
    const root = await makeTempDir("ed-deferred-deps-");
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
    await fs.writeFile(path.join(seed, "packages", "app", "src", "x.ts"), "export const x = 1;\n");
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

    // Seed a fake node_modules tree in the dedicated clone
    await fs.mkdir(path.join(paths.repoDir, "node_modules", "sample-pkg"), { recursive: true });
    await fs.writeFile(
      path.join(paths.repoDir, "node_modules", "sample-pkg", "index.js"),
      "module.exports = 42;\n",
    );

    const created = await captureCli([
      "wip",
      "create",
      "quick-question",
      "--summary",
      "Just asking a question",
      "--json",
    ]);
    expect(created.code).toBe(0);
    const createdJson = JSON.parse(created.stdout);
    expect(createdJson.depsBootstrapped).toBe(false);

    // Metadata exists immediately while node_modules was not copied synchronously
    const meta = JSON.parse(
      await fs.readFile(path.join(paths.branchesDir, "quick-question.json"), "utf8"),
    );
    expect(meta.slug).toBe("quick-question");
    expect(meta.summary).toBe("Just asking a question");
    await expect(
      fs.access(path.join(paths.worktreesDir, "quick-question", "node_modules")),
    ).rejects.toThrow();

    // Explicit bootstrap-deps clones node_modules cleanly and marks ready without dirtying git
    const booted = await captureCli(["wip", "bootstrap-deps", "quick-question", "--json"]);
    expect(booted.code).toBe(0);
    expect(JSON.parse(booted.stdout).bootstrapped).toBe(true);
    expect(
      await fs.readFile(
        path.join(paths.worktreesDir, "quick-question", "node_modules", "sample-pkg", "index.js"),
        "utf8",
      ),
    ).toContain("42");
    expect(
      await git(["status", "--porcelain"], path.join(paths.worktreesDir, "quick-question")),
    ).toBe("");

    // Removing the worktree cleans up lock/ready markers too
    expect(
      (await captureCli(["wip", "rm", "quick-question", "--delete-branch", "--json"])).code,
    ).toBe(0);
    await expect(
      fs.access(path.join(paths.home, "locks", "quick-question.deps.ready")),
    ).rejects.toThrow();
  });

  it("stages and fast-forward ships daemon-only and dual-surface (UI + Daemon) branches while preserving prod surfaces", async () => {
    const root = await makeTempDir("ed-daemon-stage-ship-");
    const originBare = path.join(root, "origin.git");
    const seed = path.join(root, "seed");
    const edHome = path.join(root, "editable-home");

    await fs.mkdir(originBare, { recursive: true });
    await git(["init", "--bare", "-b", "paseo-customizations"], originBare);

    await fs.mkdir(path.join(seed, "packages", "app", "src"), { recursive: true });
    await fs.mkdir(path.join(seed, "packages", "server", "src"), { recursive: true });
    await fs.mkdir(path.join(seed, "packages", "protocol", "src"), { recursive: true });
    await git(["init", "-b", "paseo-customizations"], seed);
    await git(["config", "user.email", "test@example.com"], seed);
    await git(["config", "user.name", "Test User"], seed);
    await fs.writeFile(
      path.join(seed, ".gitignore"),
      "packages/app/dist/\npackages/server/dist/\npackages/protocol/dist/\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(seed, "packages", "app", "src", "home.tsx"),
      "export const h = 1;\n",
    );
    await fs.writeFile(
      path.join(seed, "packages", "server", "src", "index.ts"),
      "export const s = 1;\n",
    );
    await fs.writeFile(
      path.join(seed, "packages", "server", "package.json"),
      '{"name":"@getpaseo/server","type":"module"}\n',
    );
    await fs.writeFile(
      path.join(seed, "packages", "protocol", "package.json"),
      '{"name":"@getpaseo/protocol","type":"module"}\n',
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

    // 1. Seed prod with a UI release first
    expect((await captureCli(["wip", "create", "ui-first", "--json"])).code).toBe(0);
    const wtUi = path.join(paths.worktreesDir, "ui-first");
    await fs.writeFile(path.join(wtUi, "packages", "app", "src", "u.tsx"), "export const u = 1;\n");
    await fs.mkdir(path.join(wtUi, "packages", "app", "dist"), { recursive: true });
    await fs.writeFile(
      path.join(wtUi, "packages", "app", "dist", "index.html"),
      "<html>UI1</html>",
    );
    expect(
      (
        await captureCli([
          "stage",
          "ui-first",
          "--summary",
          "UI v1",
          "--skip-verify",
          "--skip-export",
          "--json",
        ])
      ).code,
    ).toBe(0);
    const shipUi = JSON.parse(
      (await captureCli(["ship", "ui-first", "--skip-verify", "--json"])).stdout,
    );
    expect(shipUi.ok).toBe(true);
    const prodUiDigest = shipUi.electronPublish.releaseDigest as string;

    // 2. Create daemon-only branch, stage it, verify wip-index & fast-forward ship preserves prod's UI pointer
    expect((await captureCli(["wip", "create", "daemon-fix", "--json"])).code).toBe(0);
    const wtDaemon = path.join(paths.worktreesDir, "daemon-fix");
    await fs.writeFile(
      path.join(wtDaemon, "packages", "server", "src", "session.ts"),
      "export const antigravity = true;\n",
    );
    await fs.mkdir(path.join(wtDaemon, "packages", "server", "dist", "scripts"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(wtDaemon, "packages", "server", "dist", "scripts", "supervisor-entrypoint.js"),
      "console.log('daemon-fix');\n",
    );

    const stageDaemon = await captureCli([
      "stage",
      "daemon-fix",
      "--summary",
      "Enable Antigravity metadata",
      "--skip-verify",
      "--skip-export",
      "--json",
    ]);
    expect(stageDaemon.code).toBe(0);
    const stageDaemonJson = JSON.parse(stageDaemon.stdout);
    expect(stageDaemonJson.impact.services).toEqual(["daemon"]);
    expect(stageDaemonJson.electronPublish).toBeNull();
    expect(stageDaemonJson.daemonPublish.releaseDigest).toMatch(/^[a-f0-9]{64}$/);

    const pubKey = await fs.readFile(paths.publicKeyPath, "utf8");
    const wipIdx = await readAndVerifyWipIndex(paths.wipIndexPath, pubKey);
    expect(wipIdx.ok).toBe(true);
    if (wipIdx.ok) {
      expect(wipIdx.envelope.payload.branches[0]?.daemonReleaseDigest).toBe(
        stageDaemonJson.daemonPublish.releaseDigest,
      );
      expect(wipIdx.envelope.payload.branches[0]?.services).toEqual(["daemon"]);
    }

    // Delete server dist to prove fast-forward ship reuses the staged daemon release
    await fs.rm(path.join(wtDaemon, "packages", "server", "dist"), {
      recursive: true,
      force: true,
    });
    const shipDaemon = JSON.parse(
      (await captureCli(["ship", "daemon-fix", "--skip-verify", "--json"])).stdout,
    );
    expect(shipDaemon.ok).toBe(true);
    expect(shipDaemon.fastForwarded).toBe(true);
    expect(shipDaemon.daemonPublish.reusedStagedRelease).toBe(true);
    expect(shipDaemon.daemonPublish.releaseDigest).toBe(
      stageDaemonJson.daemonPublish.releaseDigest,
    );

    // prod channel must now contain BOTH the preserved electron-web pointer AND the new daemon pointer!
    const prodChan = await readAndVerifyChannel(paths.electronChannelPath, pubKey);
    expect(prodChan.ok).toBe(true);
    if (prodChan.ok) {
      expect(prodChan.envelope.payload.generation).toBe(2);
      expect(prodChan.envelope.payload.surfaces["electron-web"]?.releaseDigest).toBe(prodUiDigest);
      expect(prodChan.envelope.payload.surfaces.daemon?.releaseDigest).toBe(
        stageDaemonJson.daemonPublish.releaseDigest,
      );
    }

    // 3. Create a shared protocol branch (impacts BOTH ui + daemon) and verify single generation bump
    expect((await captureCli(["wip", "create", "shared-proto", "--json"])).code).toBe(0);
    const wtProto = path.join(paths.worktreesDir, "shared-proto");
    await fs.mkdir(path.join(wtProto, "packages", "protocol", "src"), { recursive: true });
    await fs.writeFile(
      path.join(wtProto, "packages", "protocol", "src", "msg.ts"),
      "export const v = 2;\n",
    );
    await fs.mkdir(path.join(wtProto, "packages", "app", "dist"), { recursive: true });
    await fs.writeFile(
      path.join(wtProto, "packages", "app", "dist", "index.html"),
      "<html>UI2</html>",
    );
    await fs.mkdir(path.join(wtProto, "packages", "server", "dist", "scripts"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(wtProto, "packages", "server", "dist", "scripts", "supervisor-entrypoint.js"),
      "console.log('daemon-v2');\n",
    );
    await fs.mkdir(path.join(wtProto, "packages", "protocol", "dist"), { recursive: true });
    await fs.writeFile(
      path.join(wtProto, "packages", "protocol", "dist", "msg.js"),
      "export const v = 2;\n",
    );

    const stageProto = JSON.parse(
      (
        await captureCli([
          "stage",
          "shared-proto",
          "--summary",
          "Shared protocol v2",
          "--skip-verify",
          "--skip-export",
          "--json",
        ])
      ).stdout,
    );
    expect(stageProto.impact.services).toEqual(["ui", "daemon"]);
    expect(stageProto.electronPublish.generation).toBe(1);
    expect(stageProto.daemonPublish.generation).toBe(1);

    const shipProto = JSON.parse(
      (await captureCli(["ship", "shared-proto", "--skip-verify", "--json"])).stdout,
    );
    expect(shipProto.fastForwarded).toBe(true);
    expect(shipProto.electronPublish.reusedStagedRelease).toBe(true);
    expect(shipProto.daemonPublish.reusedStagedRelease).toBe(true);
    expect(shipProto.electronPublish.generation).toBe(3);
    expect(shipProto.daemonPublish.generation).toBe(3);
  });
});
