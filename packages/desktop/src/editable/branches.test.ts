import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditableBranchManager } from "./branches.js";
import { computeKeyId } from "./crypto.js";
import { EditableReleaseStore } from "./release-store.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-branches-test-"));
  tempDirs.push(dir);
  return dir;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function signEnvelope(payload: unknown, privateKeyPem: string, publicKeyPem: string) {
  const keyId = computeKeyId(publicKeyPem);
  const signature = sign(null, Buffer.from(canonicalJson(payload)), privateKeyPem).toString(
    "base64",
  );
  return { payload, signature, keyId };
}

function writeSignedRelease(
  baseHome: string,
  privateKeyPem: string,
  publicKeyPem: string,
  input: { sourceSha: string; summary: string; html: string },
) {
  const htmlBytes = Buffer.from(input.html, "utf8");
  const fileSha = createHash("sha256").update(htmlBytes).digest("hex");
  const files = [{ path: "index.html", sha256: fileSha, bytes: htmlBytes.length }];
  const releaseDigest = createHash("sha256")
    .update(canonicalJson({ surface: "electron-web", runtimeVersion: "desktop-1", files }))
    .digest("hex");
  const releaseDir = path.join(baseHome, "releases", "electron-web", releaseDigest);
  mkdirSync(releaseDir, { recursive: true });
  writeFileSync(path.join(releaseDir, "index.html"), htmlBytes);
  const manifestPayload = {
    schemaVersion: 1,
    kind: "release",
    surface: "electron-web",
    releaseDigest,
    sourceSha: input.sourceSha,
    runtimeVersion: "desktop-1",
    archiveSha256: "0".repeat(64),
    archiveBytes: 100,
    files,
    summary: input.summary,
    createdAt: "2026-11-25T10:00:00.000Z",
  };
  writeFileSync(
    path.join(releaseDir, "manifest.json"),
    JSON.stringify(signEnvelope(manifestPayload, privateKeyPem, publicKeyPem)),
  );
  return { releaseDigest, manifestPayload };
}

function writeSignedChannel(
  filePath: string,
  privateKeyPem: string,
  publicKeyPem: string,
  input: {
    channel: string;
    generation: number;
    releaseDigest: string;
    sourceSha: string;
    summary: string;
  },
) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const payload = {
    schemaVersion: 1,
    kind: "channel",
    channel: input.channel,
    generation: input.generation,
    updatedAt: "2026-11-25T10:00:00.000Z",
    surfaces: {
      "electron-web": {
        releaseDigest: input.releaseDigest,
        sourceSha: input.sourceSha,
        runtimeVersion: "desktop-1",
        archiveUrl: `https://example.test/releases/electron-web/${input.releaseDigest}/archive.tar.gz`,
        manifestUrl: `https://example.test/releases/electron-web/${input.releaseDigest}/manifest.json`,
        summary: input.summary,
        updatedAt: "2026-11-25T10:00:00.000Z",
      },
    },
  };
  writeFileSync(filePath, JSON.stringify(signEnvelope(payload, privateKeyPem, publicKeyPem)));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("EditableBranchManager", () => {
  it("lists main + WIP branches, detects fast-forward vs behind-main, and honors auto-load rules on ship", async () => {
    const root = makeTempDir();
    const home = path.join(root, "dev-editable");
    const configHome = path.join(root, "shared-editable");
    const builtIn = path.join(root, "builtin");
    mkdirSync(builtIn, { recursive: true });
    writeFileSync(path.join(builtIn, "index.html"), "<html>builtin</html>");

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    mkdirSync(path.join(configHome, "keys"), { recursive: true });
    writeFileSync(path.join(configHome, "keys", "signing.public.pem"), publicKeyPem);
    writeFileSync(
      path.join(configHome, "config.json"),
      JSON.stringify({ baseBranch: "main", channel: "prod" }),
    );

    // Seed a tiny real git repo with main + 1 fast-forward WIP + 1 behind-main WIP
    const repoDir = path.join(configHome, "repo");
    mkdirSync(repoDir, { recursive: true });
    const git = (args: string[], cwd = repoDir) =>
      execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(path.join(repoDir, "a.txt"), "base\n");
    git(["add", "-A"]);
    git(["commit", "-m", "base"]);
    const baseSha = git(["rev-parse", "HEAD"]);

    const wtOld = path.join(configHome, "worktrees", "behind-branch");
    git(["worktree", "add", "-b", "ed/wip/behind-branch", wtOld, baseSha]);
    writeFileSync(path.join(wtOld, "old.txt"), "old\n");
    git(["add", "-A"], wtOld);
    git(["commit", "-m", "old branch"], wtOld);
    const oldSha = git(["rev-parse", "HEAD"], wtOld);

    // Advance main by 1 commit so `behind-branch` is behind main
    writeFileSync(path.join(repoDir, "main2.txt"), "main2\n");
    git(["add", "-A"]);
    git(["commit", "-m", "main2"]);
    const mainSha = git(["rev-parse", "HEAD"]);

    // Create a fresh WIP off latest main (fast-forward eligible!)
    const wtFast = path.join(configHome, "worktrees", "fast-branch");
    git(["worktree", "add", "-b", "ed/wip/fast-branch", wtFast, mainSha]);
    writeFileSync(path.join(wtFast, "fast.txt"), "fast\n");
    git(["add", "-A"], wtFast);
    git(["commit", "-m", "fast branch"], wtFast);
    const fastSha = git(["rev-parse", "HEAD"], wtFast);

    // Create a clean worktree with no changes (discussion-only branch)
    const wtClean = path.join(configHome, "worktrees", "question-branch");
    git(["worktree", "add", "-b", "ed/wip/question-branch", wtClean, mainSha]);

    // Sign releases for main, fast-branch, and behind-branch
    const mainRel = writeSignedRelease(configHome, privateKeyPem, publicKeyPem, {
      sourceSha: mainSha,
      summary: "Main v2",
      html: "<html>main</html>",
    });
    const fastRel = writeSignedRelease(configHome, privateKeyPem, publicKeyPem, {
      sourceSha: fastSha,
      summary: "Fast WIP",
      html: "<html>fast</html>",
    });
    const oldRel = writeSignedRelease(configHome, privateKeyPem, publicKeyPem, {
      sourceSha: oldSha,
      summary: "Behind WIP",
      html: "<html>behind</html>",
    });

    writeSignedChannel(
      path.join(configHome, "releases", "electron-web", "channel.json"),
      privateKeyPem,
      publicKeyPem,
      {
        channel: "prod",
        generation: 2,
        releaseDigest: mainRel.releaseDigest,
        sourceSha: mainSha,
        summary: "Main v2",
      },
    );
    writeSignedChannel(
      path.join(configHome, "releases", "electron-web", "channels", "wip-fast-branch.json"),
      privateKeyPem,
      publicKeyPem,
      {
        channel: "wip-fast-branch",
        generation: 1,
        releaseDigest: fastRel.releaseDigest,
        sourceSha: fastSha,
        summary: "Fast WIP",
      },
    );
    writeSignedChannel(
      path.join(configHome, "releases", "electron-web", "channels", "wip-behind-branch.json"),
      privateKeyPem,
      publicKeyPem,
      {
        channel: "wip-behind-branch",
        generation: 1,
        releaseDigest: oldRel.releaseDigest,
        sourceSha: oldSha,
        summary: "Behind WIP",
      },
    );

    mkdirSync(path.join(configHome, "branches"), { recursive: true });
    writeFileSync(
      path.join(configHome, "branches", "fast-branch.json"),
      JSON.stringify({
        schemaVersion: 1,
        slug: "fast-branch",
        branch: "ed/wip/fast-branch",
        channel: "wip-fast-branch",
        status: "ready",
        summary: "Fast WIP",
        releaseDigest: fastRel.releaseDigest,
        sourceSha: fastSha,
        generation: 1,
        uploadedToCloud: true,
        requiresDaemon: false,
        requiresNative: false,
        agentId: "agent-fast",
        error: null,
        updatedAt: "2026-11-25T10:01:00.000Z",
      }),
    );
    writeFileSync(
      path.join(configHome, "branches", "behind-branch.json"),
      JSON.stringify({
        schemaVersion: 1,
        slug: "behind-branch",
        branch: "ed/wip/behind-branch",
        channel: "wip-behind-branch",
        status: "ready",
        summary: "Behind WIP",
        releaseDigest: oldRel.releaseDigest,
        sourceSha: oldSha,
        generation: 1,
        uploadedToCloud: true,
        requiresDaemon: false,
        requiresNative: false,
        agentId: "agent-old",
        error: null,
        updatedAt: "2026-11-25T10:00:00.000Z",
      }),
    );

    const store = new EditableReleaseStore({
      builtInDistDir: builtIn,
      home,
      publicKeyHome: configHome,
    });
    const execCli = vi.fn();
    const manager = new EditableBranchManager({ home, configHome, store, execCli });

    const snap = await manager.getSnapshot({
      loadedChannel: "prod",
      loadedDigest: mainRel.releaseDigest,
      safeRenderer: false,
    });
    expect(snap.main).toMatchObject({
      slug: "main",
      loaded: true,
      hasUpdate: false,
      generation: 2,
    });
    const fast = snap.branches.find((b) => b.slug === "fast-branch");
    const behind = snap.branches.find((b) => b.slug === "behind-branch");
    expect(fast).toMatchObject({
      status: "ready",
      hasChanges: true,
      canFastForward: true,
      behindMain: false,
    });
    expect(behind).toMatchObject({
      status: "ready",
      hasChanges: true,
      canFastForward: false,
      behindMain: true,
    });

    // Attach an agent to the clean question-only worktree and verify it reports idle + hasChanges: false
    expect(manager.attachBranchAgent("question-branch", "agent-question")).toEqual({ ok: true });
    const snapWithQuestion = await manager.getSnapshot({
      loadedChannel: "prod",
      loadedDigest: mainRel.releaseDigest,
      safeRenderer: false,
    });
    const question = snapWithQuestion.branches.find((b) => b.slug === "question-branch");
    expect(question).toMatchObject({
      status: "idle",
      hasChanges: false,
      canFastForward: false,
      releaseDigest: null,
      agentId: "agent-question",
    });

    // createBranch reuses an existing worktree idempotently and calls CLI for a new one
    expect(await manager.createBranch({ slug: "question-branch" })).toEqual({
      ok: true,
      slug: "question-branch",
      branch: "ed/wip/question-branch",
      worktreePath: wtClean,
    });
    execCli.mockResolvedValueOnce(
      JSON.stringify({
        slug: "fresh-branch",
        branch: "ed/wip/fresh-branch",
        worktreeDir: path.join(configHome, "worktrees", "fresh-branch"),
      }),
    );
    expect(
      await manager.createBranch({ slug: "fresh-branch", summary: "Ask about button" }),
    ).toEqual({
      ok: true,
      slug: "fresh-branch",
      branch: "ed/wip/fresh-branch",
      worktreePath: path.join(configHome, "worktrees", "fresh-branch"),
    });

    // Switch to wip-fast-branch and verify prod generation high-water mark is preserved
    const loadedWip = await manager.loadBranch("wip-fast-branch");
    expect(loadedWip.release.releaseDigest).toBe(fastRel.releaseDigest);
    const loadedMain = await manager.loadBranch("prod");
    expect(loadedMain.release.releaseDigest).toBe(mainRel.releaseDigest);

    // Fast-forward ship from main -> shouldAutoLoad = true
    execCli.mockResolvedValueOnce(
      JSON.stringify({
        ok: true,
        fastForwarded: true,
        electronPublish: { releaseDigest: fastRel.releaseDigest, generation: 3 },
      }),
    );
    const fastShip = await manager.shipBranch("fast-branch", { loadedChannel: "prod" });
    expect(fastShip).toMatchObject({ ok: true, fastForwarded: true, shouldAutoLoad: true });

    // Slow parallel merge ship -> shouldAutoLoad = false (must NOT auto-switch!)
    execCli.mockResolvedValueOnce(
      JSON.stringify({
        ok: true,
        fastForwarded: false,
        electronPublish: { releaseDigest: oldRel.releaseDigest, generation: 4 },
      }),
    );
    const slowShip = await manager.shipBranch("behind-branch", { loadedChannel: "prod" });
    expect(slowShip).toMatchObject({ ok: true, fastForwarded: false, shouldAutoLoad: false });

    // Staged daemon-only branch (requiresDaemon: true, releaseDigest: null) reports ready + canFastForward
    const wtDaemon = path.join(configHome, "worktrees", "daemon-only");
    git(["worktree", "add", "-b", "ed/wip/daemon-only", wtDaemon, "main"], repoDir);
    writeFileSync(path.join(wtDaemon, "daemon.txt"), "server-only change\n");
    git(["add", "daemon.txt"], wtDaemon);
    git(["commit", "-m", "daemon only"], wtDaemon);
    const daemonSha = git(["rev-parse", "HEAD"], wtDaemon);
    writeFileSync(
      path.join(configHome, "branches", "daemon-only.json"),
      JSON.stringify({
        schemaVersion: 1,
        slug: "daemon-only",
        branch: "ed/wip/daemon-only",
        channel: "wip-daemon-only",
        status: "ready",
        summary: "Enable Antigravity response metadata",
        releaseDigest: null,
        sourceSha: daemonSha,
        generation: null,
        uploadedToCloud: false,
        requiresDaemon: true,
        requiresNative: false,
        agentId: "agent-daemon",
        error: null,
        updatedAt: "2026-11-26T09:53:00.000Z",
      }),
    );
    const snapDaemon = await manager.getSnapshot({
      loadedChannel: "prod",
      loadedDigest: mainRel.releaseDigest,
      safeRenderer: false,
    });
    const daemonBranch = snapDaemon.branches.find((b) => b.slug === "daemon-only");
    expect(daemonBranch).toMatchObject({
      status: "ready",
      hasChanges: true,
      requiresDaemon: true,
      releaseDigest: null,
      canFastForward: true,
    });

    // Fast-forward ship of a daemon-only branch does not auto-reload renderer (no electronPublish)
    execCli.mockResolvedValueOnce(
      JSON.stringify({
        ok: true,
        fastForwarded: true,
        electronPublish: null,
      }),
    );
    const daemonShip = await manager.shipBranch("daemon-only", { loadedChannel: "prod" });
    expect(daemonShip).toMatchObject({ ok: true, fastForwarded: true, shouldAutoLoad: false });
  });

  it("computes Paseo diffStat breakdown vs baseBranch, persists branch title/icon, and picks newest main surface summary", async () => {
    const root = makeTempDir();
    const home = path.join(root, "dev-editable");
    const configHome = path.join(root, "shared-editable");
    const builtIn = path.join(root, "builtin");
    mkdirSync(builtIn, { recursive: true });
    writeFileSync(path.join(builtIn, "index.html"), "<html>builtin</html>");

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    mkdirSync(path.join(configHome, "keys"), { recursive: true });
    writeFileSync(path.join(configHome, "keys", "signing.public.pem"), publicKeyPem);
    writeFileSync(
      path.join(configHome, "config.json"),
      JSON.stringify({ baseBranch: "main", channel: "prod" }),
    );

    const repoDir = path.join(configHome, "repo");
    mkdirSync(repoDir, { recursive: true });
    const git = (args: string[], cwd = repoDir) =>
      execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
    git(["init", "-b", "main"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(path.join(repoDir, "app.ts"), "export const a = 1;\n");
    git(["add", "-A"]);
    git(["commit", "-m", "base"]);
    const baseSha = git(["rev-parse", "HEAD"]);

    // Create WIP with production .ts code + .test.ts + .md docs
    const wt = path.join(configHome, "worktrees", "feature-icons");
    git(["worktree", "add", "-b", "ed/wip/feature-icons", wt, baseSha]);
    writeFileSync(path.join(wt, "app.ts"), "export const a = 1;\nexport const b = 2;\n");
    writeFileSync(path.join(wt, "app.test.ts"), "expect(1).toBe(1);\nexpect(2).toBe(2);\n");
    writeFileSync(path.join(wt, "README.md"), "# Notes\n");
    git(["add", "-A"], wt);
    git(["commit", "-m", "Add b with tests and docs"], wt);
    const wipSha = git(["rev-parse", "HEAD"], wt);

    // Channel where daemon surface is NEWER than electron-web surface
    const uiRel = writeSignedRelease(configHome, privateKeyPem, publicKeyPem, {
      sourceSha: baseSha,
      summary: "Older UI change",
      html: "<html>ui</html>",
    });
    const prodChannelPath = path.join(configHome, "releases", "electron-web", "channel.json");
    mkdirSync(path.dirname(prodChannelPath), { recursive: true });
    writeFileSync(
      prodChannelPath,
      JSON.stringify(
        signEnvelope(
          {
            schemaVersion: 1,
            kind: "channel",
            channel: "prod",
            generation: 21,
            updatedAt: "2026-11-26T17:04:32.000Z",
            surfaces: {
              "electron-web": {
                releaseDigest: uiRel.releaseDigest,
                sourceSha: baseSha,
                runtimeVersion: "desktop-1",
                archiveUrl: "https://example.test/ui.tar.gz",
                manifestUrl: "https://example.test/ui.json",
                summary: "Older UI change",
                updatedAt: "2026-11-26T16:00:00.000Z",
              },
              daemon: {
                releaseDigest: "d".repeat(64),
                sourceSha: wipSha,
                runtimeVersion: "daemon-1",
                archiveUrl: "https://example.test/daemon.tar.gz",
                manifestUrl: "https://example.test/daemon.json",
                summary: "Enable Antigravity response metadata",
                updatedAt: "2026-11-26T17:04:32.000Z",
              },
            },
          },
          privateKeyPem,
          publicKeyPem,
        ),
      ),
    );

    const store = new EditableReleaseStore({
      builtInDistDir: builtIn,
      home,
      publicKeyHome: configHome,
    });
    const manager = new EditableBranchManager({ home, configHome, store });
    expect(manager.attachBranchAgent("feature-icons", "agent-icons")).toEqual({ ok: true });
    expect(
      manager.updateBranchMeta("feature-icons", { title: "PR Link Icons", icon: "🔗" }),
    ).toEqual({ ok: true });

    const snap = await manager.getSnapshot({
      loadedChannel: "prod",
      loadedDigest: uiRel.releaseDigest,
      safeRenderer: false,
    });
    expect(snap.main.summary).toBe("Enable Antigravity response metadata");

    const branch = snap.branches.find((b) => b.slug === "feature-icons");
    expect(branch?.title).toBe("PR Link Icons");
    expect(branch?.icon).toBe("🔗");
    expect(branch?.diffStat?.additions).toBe(4);
    expect(branch?.diffStat?.deletions).toBe(0);
    expect(branch?.diffStat?.breakdown?.code).toEqual({ additions: 1, deletions: 0 });
    expect(branch?.diffStat?.breakdown?.tests).toEqual({ additions: 2, deletions: 0 });
    expect(branch?.diffStat?.breakdown?.docs).toEqual({ additions: 1, deletions: 0 });
  });
});
