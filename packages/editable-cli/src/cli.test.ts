import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { getEditablePaths, readAndVerifyChannel, readDeviceState } from "@getpaseo/editable-core";
import { runCli } from "./index.js";

const execFileAsync = promisify(execFile);

async function createMockPaseoOrigin(rootDir: string): Promise<string> {
  const originDir = path.join(rootDir, "origin.git");
  const seedDir = path.join(rootDir, "seed");
  await fs.mkdir(originDir, { recursive: true });
  await fs.mkdir(path.join(seedDir, "packages/app/src"), { recursive: true });
  await fs.mkdir(path.join(seedDir, "packages/app/dist"), { recursive: true });

  await execFileAsync("git", ["init", "--bare", originDir]);
  await execFileAsync("git", ["init", "-b", "paseo-customizations"], { cwd: seedDir });
  await execFileAsync("git", ["config", "user.name", "Test"], { cwd: seedDir });
  await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: seedDir });
  await fs.writeFile(path.join(seedDir, ".gitignore"), "packages/app/dist/\n");
  await fs.writeFile(
    path.join(seedDir, "packages/app/src/button.tsx"),
    "export const color = 'grey';\n",
  );
  await execFileAsync("git", ["add", "-A"], { cwd: seedDir });
  await execFileAsync("git", ["commit", "-m", "initial"], { cwd: seedDir });
  await execFileAsync("git", ["remote", "add", "origin", originDir], { cwd: seedDir });
  await execFileAsync("git", ["push", "-u", "origin", "paseo-customizations"], { cwd: seedDir });
  return originDir;
}

describe("@editable-paseo/cli end-to-end workflow", () => {
  it("runs init -> concurrent WIPs -> ship (git push + signed local publish) -> rollback-local -> revert", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ed-cli-e2e-"));
    const prevHome = process.env.EDITABLE_PASEO_HOME;
    const edHome = path.join(tmp, "editable-home");
    process.env.EDITABLE_PASEO_HOME = edHome;

    try {
      const origin = await createMockPaseoOrigin(tmp);

      expect(
        await runCli(["init", "--repo", origin, "--branch", "paseo-customizations", "--json"]),
      ).toBe(0);
      // Create BOTH concurrent WIP worktrees off the same base commit C0
      expect(await runCli(["wip", "create", "green-btn", "--json"])).toBe(0);
      expect(await runCli(["wip", "create", "blue-btn", "--json"])).toBe(0);

      const paths = getEditablePaths(edHome);
      const wt1 = path.join(paths.worktreesDir, "green-btn");
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: wt1 });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: wt1 });
      await fs.writeFile(
        path.join(wt1, "packages/app/src/button.tsx"),
        "export const color = 'green';\n",
      );
      await fs.mkdir(path.join(wt1, "packages/app/dist"), { recursive: true });
      await fs.writeFile(path.join(wt1, "packages/app/dist/index.html"), "<html>v1-green</html>");

      // Ship v1 (fast-forward)
      expect(
        await runCli([
          "ship",
          "green-btn",
          "--summary",
          "Make PR button green",
          "--push",
          "--skip-verify",
          "--skip-export",
          "--json",
        ]),
      ).toBe(0);

      const pubKey = await fs.readFile(paths.publicKeyPath, "utf8");
      const chan1 = await readAndVerifyChannel(paths.electronChannelPath, pubKey, 1);
      expect(chan1.ok).toBe(true);
      if (!chan1.ok) throw new Error(chan1.error);
      const digest1 = chan1.envelope.payload.surfaces["electron-web"]!.releaseDigest;
      const sha1 = chan1.envelope.payload.surfaces["electron-web"]!.sourceSha;
      expect(chan1.envelope.payload.generation).toBe(1);

      // Verify origin received the pushed commit BEFORE pointer promotion
      const { stdout: originHead } = await execFileAsync("git", [
        "--git-dir",
        origin,
        "rev-parse",
        "refs/heads/paseo-customizations",
      ]);
      expect(originHead.trim()).toBe(sha1);

      // Ship v2 (concurrent diverged WIP branched from C0 -> merges cleanly on top of v1!)
      const wt2 = path.join(paths.worktreesDir, "blue-btn");
      await execFileAsync("git", ["config", "user.name", "Test"], { cwd: wt2 });
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: wt2 });
      await fs.writeFile(path.join(wt2, "packages/app/src/other.tsx"), "export const x = 2;\n");
      await fs.mkdir(path.join(wt2, "packages/app/dist"), { recursive: true });
      await fs.writeFile(path.join(wt2, "packages/app/dist/index.html"), "<html>v2-blue</html>");

      expect(
        await runCli([
          "ship",
          "blue-btn",
          "--summary",
          "Add second tweak",
          "--push",
          "--skip-verify",
          "--skip-export",
          "--json",
        ]),
      ).toBe(0);

      const chan2 = await readAndVerifyChannel(paths.electronChannelPath, pubKey, 2);
      expect(chan2.ok).toBe(true);
      if (!chan2.ok) throw new Error(chan2.error);
      expect(chan2.envelope.payload.generation).toBe(2);
      const digest2 = chan2.envelope.payload.surfaces["electron-web"]!.releaseDigest;
      const sha2 = chan2.envelope.payload.surfaces["electron-web"]!.sourceSha;
      expect(digest2).not.toBe(digest1);

      // Rollback locally -> switches back to digest1 and quarantines digest2
      expect(await runCli(["rollback-local", "--json"])).toBe(0);
      const stateAfterRollback = await readDeviceState(paths.deviceStatePath);
      expect(stateAfterRollback.activeDigest).toBe(digest1);
      expect(stateAfterRollback.quarantinedDigests).toContain(digest2);

      // Source revert handles BOTH regular commits AND merge commits cleanly!
      expect(await runCli(["revert", sha2, "--push", "--json"])).toBe(0);
      expect(await runCli(["revert", sha1, "--push", "--json"])).toBe(0);
      const { stdout: originAfterRevert } = await execFileAsync("git", [
        "--git-dir",
        origin,
        "rev-parse",
        "refs/heads/paseo-customizations",
      ]);
      expect(originAfterRevert.trim()).not.toBe(sha1);
      expect(originAfterRevert.trim()).not.toBe(sha2);
    } finally {
      if (prevHome === undefined) delete process.env.EDITABLE_PASEO_HOME;
      else process.env.EDITABLE_PASEO_HOME = prevHome;
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
