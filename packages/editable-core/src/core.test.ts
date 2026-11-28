import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DAEMON_ENTRYPOINT_REL_PATH,
  DAEMON_RUNTIME_VERSION,
  DESKTOP_RUNTIME_VERSION,
  EDITABLE_READER_VERSION,
  IncompatibleStateError,
  canonicalJson,
  checkOnDiskVersion,
  classifyPaseoImpact,
  defaultDeviceState,
  generateSigningKeyPair,
  packReleaseArchive,
  readAndVerifyChannel,
  readDeviceState,
  readEditableConfig,
  signEnvelope,
  verifyAndExtractReleaseArchive,
  verifySignedEnvelope,
  writeJsonAtomic,
  type ChannelManifestPayload,
} from "./index.js";

describe("@getpaseo/editable-core crypto & canonical JSON", () => {
  it("produces deterministic canonical JSON regardless of key insertion order", () => {
    const a = { z: 1, a: { d: 4, c: [3, { b: 2, a: 1 }] } };
    const b = { a: { c: [3, { a: 1, b: 2 }], d: 4 }, z: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("signs and verifies Ed25519 envelopes and rejects tampering or wrong key", () => {
    const kp1 = generateSigningKeyPair();
    const kp2 = generateSigningKeyPair();
    const env = signEnvelope({ hello: "paseo", n: 42 }, kp1.privateKeyPem, kp1.publicKeyPem);

    const ok = verifySignedEnvelope<{ hello: string; n: number }>(env, kp1.publicKeyPem);
    expect(ok.ok).toBe(true);

    const tampered = verifySignedEnvelope(
      { ...env, payload: { hello: "paseo", n: 43 } },
      kp1.publicKeyPem,
    );
    expect(tampered.ok).toBe(false);

    const wrongKey = verifySignedEnvelope(env, kp2.publicKeyPem);
    expect(wrongKey.ok).toBe(false);
  });
});

describe("@getpaseo/editable-core versioned recovery contract", () => {
  it("accepts matching schemaVersion/minReaderVersion and rejects newer reader requirements", () => {
    expect(checkOnDiskVersion({ schemaVersion: 1 })).toEqual({
      ok: true,
      schemaVersion: 1,
      minReaderVersion: 1,
    });
    expect(checkOnDiskVersion({ schemaVersion: 1, minReaderVersion: 1 })).toEqual({
      ok: true,
      schemaVersion: 1,
      minReaderVersion: 1,
    });
    expect(checkOnDiskVersion({ schemaVersion: 2, minReaderVersion: 1 })).toEqual({
      ok: true,
      schemaVersion: 2,
      minReaderVersion: 1,
    });

    const tooOldByMin = checkOnDiskVersion({ schemaVersion: 1, minReaderVersion: 2 });
    expect(tooOldByMin.ok).toBe(false);
    if (!tooOldByMin.ok) {
      expect(tooOldByMin.reason).toBe("reader_too_old");
      expect(tooOldByMin.minReaderVersion).toBe(2);
    }

    const tooOldBySchema = checkOnDiskVersion({ schemaVersion: 2 });
    expect(tooOldBySchema.ok).toBe(false);
    if (!tooOldBySchema.ok) {
      expect(tooOldBySchema.reason).toBe("reader_too_old");
    }

    const invalid = checkOnDiskVersion({ schemaVersion: "v1" });
    expect(invalid.ok).toBe(false);
    if (!invalid.ok) {
      expect(invalid.reason).toBe("invalid");
    }
  });

  it("writes minReaderVersion in defaultDeviceState and fails closed on newer on-disk state", async () => {
    expect(defaultDeviceState().minReaderVersion).toBe(EDITABLE_READER_VERSION);
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ed-core-ver-"));
    try {
      const statePath = path.join(tmp, "device-state.json");
      await writeJsonAtomic(statePath, {
        schemaVersion: 2,
        minReaderVersion: 99,
        activeDigest: "a".repeat(64),
      });
      await expect(readDeviceState(statePath)).rejects.toBeInstanceOf(IncompatibleStateError);

      const cfgPath = path.join(tmp, "config.json");
      await writeJsonAtomic(cfgPath, {
        schemaVersion: 2,
        minReaderVersion: 99,
        sourceRepoUrl: "https://example.test/paseo.git",
      });
      await expect(readEditableConfig(cfgPath)).rejects.toBeInstanceOf(IncompatibleStateError);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("@getpaseo/editable-core archive signing, verification & security", () => {
  it("packs, signs, verifies and extracts electron-web archive cleanly", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ed-core-test-"));
    try {
      const srcDir = path.join(tmp, "dist");
      await fs.mkdir(path.join(srcDir, "_expo/static/js/web"), { recursive: true });
      await fs.writeFile(path.join(srcDir, "index.html"), "<html><body>ok</body></html>");
      await fs.writeFile(
        path.join(srcDir, "_expo/static/js/web/entry-abc123.js"),
        "console.log('hi');",
      );

      const archivePath = path.join(tmp, "release.tar.gz");
      const manifest = await packReleaseArchive({
        sourceDir: srcDir,
        outputArchivePath: archivePath,
        surface: "electron-web",
        sourceSha: "a".repeat(40),
        runtimeVersion: DESKTOP_RUNTIME_VERSION,
        summary: "Green PR button",
      });

      const kp = generateSigningKeyPair();
      const signed = signEnvelope(manifest, kp.privateKeyPem, kp.publicKeyPem);
      const outDir = path.join(tmp, "extracted");

      const verified = await verifyAndExtractReleaseArchive({
        archivePath,
        signedManifest: signed,
        publicKeyPem: kp.publicKeyPem,
        expectedSurface: "electron-web",
        expectedRuntimeVersion: DESKTOP_RUNTIME_VERSION,
        targetDir: outDir,
      });

      expect(verified.releaseDigest).toBe(manifest.releaseDigest);
      expect(await fs.readFile(path.join(outDir, "index.html"), "utf8")).toContain("ok");

      await expect(
        verifyAndExtractReleaseArchive({
          archivePath,
          signedManifest: signed,
          publicKeyPem: kp.publicKeyPem,
          expectedSurface: "electron-web",
          expectedRuntimeVersion: "desktop-999",
          targetDir: path.join(tmp, "out2"),
        }),
      ).rejects.toThrow(/Runtime version mismatch/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("rejects symlinks in source release directories", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ed-core-sym-"));
    try {
      const srcDir = path.join(tmp, "dist");
      await fs.mkdir(srcDir, { recursive: true });
      await fs.writeFile(path.join(srcDir, "index.html"), "<html/>");
      await fs.symlink("/etc/hosts", path.join(srcDir, "evil.txt"));

      await expect(
        packReleaseArchive({
          sourceDir: srcDir,
          outputArchivePath: path.join(tmp, "out.tar.gz"),
          surface: "electron-web",
          sourceSha: "b".repeat(40),
          runtimeVersion: DESKTOP_RUNTIME_VERSION,
          summary: "Bad symlink",
        }),
      ).rejects.toThrow(/Symlinks are forbidden/);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("packs, signs, verifies and extracts daemon archive cleanly", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ed-core-daemon-"));
    try {
      const srcDir = path.join(tmp, "daemon-stage");
      const entryFile = path.join(srcDir, DAEMON_ENTRYPOINT_REL_PATH);
      await fs.mkdir(path.dirname(entryFile), { recursive: true });
      await fs.writeFile(entryFile, "console.log('supervisor');\n");
      await fs.writeFile(
        path.join(srcDir, "node_modules/@getpaseo/server/package.json"),
        '{"name":"@getpaseo/server","type":"module"}\n',
      );

      const archivePath = path.join(tmp, "daemon.tar.gz");
      const manifest = await packReleaseArchive({
        sourceDir: srcDir,
        outputArchivePath: archivePath,
        surface: "daemon",
        sourceSha: "d".repeat(40),
        runtimeVersion: DAEMON_RUNTIME_VERSION,
        summary: "Antigravity metadata support",
      });

      const kp = generateSigningKeyPair();
      const signed = signEnvelope(manifest, kp.privateKeyPem, kp.publicKeyPem);
      const outDir = path.join(tmp, "extracted");

      const verified = await verifyAndExtractReleaseArchive({
        archivePath,
        signedManifest: signed,
        publicKeyPem: kp.publicKeyPem,
        expectedSurface: "daemon",
        expectedRuntimeVersion: DAEMON_RUNTIME_VERSION,
        targetDir: outDir,
      });

      expect(verified.releaseDigest).toBe(manifest.releaseDigest);
      expect(verified.surface).toBe("daemon");
      expect(await fs.readFile(path.join(outDir, DAEMON_ENTRYPOINT_REL_PATH), "utf8")).toContain(
        "supervisor",
      );
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });

  it("enforces monotonic channel generation to block replay/downgrade", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ed-core-chan-"));
    try {
      const kp = generateSigningKeyPair();
      const channelPath = path.join(tmp, "channel.json");
      const payload: ChannelManifestPayload = {
        schemaVersion: 1,
        kind: "channel",
        channel: "prod",
        generation: 3,
        updatedAt: new Date().toISOString(),
        surfaces: {},
      };
      await writeJsonAtomic(channelPath, signEnvelope(payload, kp.privateKeyPem, kp.publicKeyPem));

      const ok = await readAndVerifyChannel(channelPath, kp.publicKeyPem, 3);
      expect(ok.ok).toBe(true);

      const downgraded = await readAndVerifyChannel(channelPath, kp.publicKeyPem, 4);
      expect(downgraded.ok).toBe(false);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});

describe("@getpaseo/editable-core Paseo impact path classifier", () => {
  it("routes pure app UI edits to electron-web + ios-ota without daemon release", () => {
    const plan = classifyPaseoImpact(["packages/app/src/git/workspace-pull-request-button.tsx"]);
    expect(plan.canPublishElectronRenderer).toBe(true);
    expect(plan.canPublishIosOta).toBe(true);
    expect(plan.requiresDaemonRelease).toBe(false);
    expect(plan.requiresNativeRebuild).toBe(false);
  });

  it("detects plugins/ and skills/ edits as daemon-cli impacts", () => {
    const plan = classifyPaseoImpact([
      "skills/paseo/SKILL.md",
      "plugins/worktree-include/index.server.ts",
    ]);
    expect(plan.requiresDaemonRelease).toBe(true);
    expect(plan.surfaces).toContain("daemon-cli");
  });

  it("blocks renderer-only publish on packages/desktop edits and warns on native iOS edits", () => {
    const desktopPlan = classifyPaseoImpact([
      "packages/desktop/src/main.ts",
      "packages/app/src/a.tsx",
    ]);
    expect(desktopPlan.requiresNativeRebuild).toBe(true);
    expect(desktopPlan.canPublishElectronRenderer).toBe(false);

    const iosPlan = classifyPaseoImpact(["packages/app/app.config.js"]);
    expect(iosPlan.requiresNativeRebuild).toBe(true);
    expect(iosPlan.canPublishIosOta).toBe(false);
  });

  it("classifies editable-core, editable-cli, and infra/cloud-shelf accurately", () => {
    const corePlan = classifyPaseoImpact(["packages/editable-core/src/crypto.ts"]);
    expect(corePlan.surfaces).toEqual(["editable-cli", "native-desktop"]);
    expect(corePlan.requiresNativeRebuild).toBe(true);
    expect(corePlan.requiresDaemonRelease).toBe(false);
    expect(corePlan.verifySteps).toContain("typecheck:editable");
    expect(corePlan.verifySteps).toContain("typecheck:desktop");

    const cliPlan = classifyPaseoImpact(["packages/editable-cli/src/git.ts"]);
    expect(cliPlan.surfaces).toEqual(["editable-cli", "native-desktop"]);
    expect(cliPlan.requiresNativeRebuild).toBe(true);
    expect(cliPlan.requiresDaemonRelease).toBe(false);
    expect(cliPlan.verifySteps).toContain("test:editable");

    const shelfPlan = classifyPaseoImpact(["infra/cloud-shelf/src/worker.ts"]);
    expect(shelfPlan.surfaces).toEqual(["cloud-shelf"]);
    expect(shelfPlan.requiresNativeRebuild).toBe(false);
    expect(shelfPlan.requiresDaemonRelease).toBe(false);
    expect(shelfPlan.canPublishElectronRenderer).toBe(false);
  });

  it("flags protocol edits for bidirectional compatibility checks", () => {
    const plan = classifyPaseoImpact(["packages/protocol/src/messages.ts"]);
    expect(plan.requiresDaemonRelease).toBe(true);
    expect(plan.canPublishDaemon).toBe(true);
    expect(plan.canPublishElectronRenderer).toBe(true);
    expect(plan.services).toEqual(["ui", "daemon"]);
    expect(plan.surfaces).toEqual(["daemon-cli", "electron-web", "ios-ota"]);
    expect(plan.verifySteps).toContain("test:protocol-compat");
  });

  it("blocks daemon hot-swap when server dependencies or lockfile change", () => {
    const plan = classifyPaseoImpact(["packages/server/package.json"]);
    expect(plan.services).toContain("daemon");
    expect(plan.services).toContain("desktop");
    expect(plan.requiresNativeRebuild).toBe(true);
    expect(plan.canPublishDaemon).toBe(false);
  });
});
