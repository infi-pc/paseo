import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DaemonInstance } from "@getpaseo/server/daemon-control";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DesktopDaemonStatus } from "../daemon/daemon-manager.js";
import { keepsTerminalsOnStop } from "../daemon/daemon-manager.js";
import { EditableBranchManager } from "./branches.js";
import { DAEMON_ENTRYPOINT_REL_PATH, DAEMON_RUNTIME_VERSION } from "./constants.js";
import { computeKeyId } from "./crypto.js";
import { assertIsolatedDevDaemonHome, EditableDaemonController } from "./daemon-swap.js";
import { EditableReleaseStore } from "./release-store.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-daemon-swap-test-"));
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

function writeSignedDaemonRelease(
  baseHome: string,
  privateKeyPem: string,
  publicKeyPem: string,
  input: { sourceSha: string; summary: string; scriptBody: string },
) {
  const bytes = Buffer.from(input.scriptBody, "utf8");
  const fileSha = createHash("sha256").update(bytes).digest("hex");
  const files = [{ path: DAEMON_ENTRYPOINT_REL_PATH, sha256: fileSha, bytes: bytes.length }];
  const releaseDigest = createHash("sha256")
    .update(canonicalJson({ surface: "daemon", runtimeVersion: DAEMON_RUNTIME_VERSION, files }))
    .digest("hex");
  const releaseDir = path.join(baseHome, "releases", "daemon", releaseDigest);
  const entryFull = path.join(releaseDir, DAEMON_ENTRYPOINT_REL_PATH);
  mkdirSync(path.dirname(entryFull), { recursive: true });
  writeFileSync(entryFull, bytes);
  const manifestPayload = {
    schemaVersion: 1,
    kind: "release",
    surface: "daemon",
    releaseDigest,
    sourceSha: input.sourceSha,
    runtimeVersion: DAEMON_RUNTIME_VERSION,
    archiveSha256: "0".repeat(64),
    archiveBytes: 100,
    files,
    summary: input.summary,
    createdAt: "2026-11-26T10:00:00.000Z",
  };
  writeFileSync(
    path.join(releaseDir, "manifest.json"),
    JSON.stringify(signEnvelope(manifestPayload, privateKeyPem, publicKeyPem)),
  );
  return { releaseDigest, releaseDir, entryFull };
}

function makeRunningStatus(home: string, pid: number, startedAt: string): DesktopDaemonStatus {
  return {
    serverId: "srv-dev",
    status: "running",
    listen: "127.0.0.1:6770",
    hostname: "dev-host",
    pid,
    home,
    version: "0.17.1",
    desktopManaged: true,
    ownedByDesktop: true,
    startedAt,
    error: null,
  };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("EditableDaemonController & daemon hot-swap", () => {
  it("keeps terminals alive on macOS/Linux for editable_swap stops", () => {
    expect(keepsTerminalsOnStop("editable_swap", "darwin")).toBe(true);
    expect(keepsTerminalsOnStop("editable_swap", "linux")).toBe(true);
    expect(keepsTerminalsOnStop("editable_swap", "win32")).toBe(false);
  });

  it("blocks hot-swap against non-dev instances, production ~/.paseo (:6767), and workshop (:6769)", () => {
    const fakeUser = makeTempDir();
    expect(() =>
      assertIsolatedDevDaemonHome({
        isDev: false,
        paseoHome: path.join(fakeUser, ".paseo-dev"),
        paseoListen: "127.0.0.1:6770",
        userHome: fakeUser,
      }),
    ).toThrow(/isolated Paseo Dev/);

    expect(() =>
      assertIsolatedDevDaemonHome({
        isDev: true,
        paseoHome: path.join(fakeUser, ".paseo"),
        paseoListen: "127.0.0.1:6770",
        userHome: fakeUser,
      }),
    ).toThrow(/protected/);

    expect(() =>
      assertIsolatedDevDaemonHome({
        isDev: true,
        paseoHome: path.join(fakeUser, ".paseo-workshop"),
        paseoListen: "127.0.0.1:6770",
        userHome: fakeUser,
      }),
    ).toThrow(/protected/);

    expect(() =>
      assertIsolatedDevDaemonHome({
        isDev: true,
        paseoHome: path.join(fakeUser, ".paseo-dev"),
        paseoListen: "127.0.0.1:6767",
        userHome: fakeUser,
      }),
    ).toThrow(/6767/);

    expect(() =>
      assertIsolatedDevDaemonHome({
        isDev: true,
        paseoHome: path.join(fakeUser, ".paseo-dev"),
        paseoListen: "127.0.0.1:6769",
        userHome: fakeUser,
      }),
    ).toThrow(/6769/);

    expect(() =>
      assertIsolatedDevDaemonHome({
        isDev: true,
        paseoHome: path.join(fakeUser, ".paseo-dev"),
        paseoListen: "127.0.0.1:6770",
        userHome: fakeUser,
      }),
    ).not.toThrow();

    // Production opt-in allows official Editable Paseo on ~/.paseo (:6767), while still blocking workshop (:6769)
    expect(() =>
      assertIsolatedDevDaemonHome({
        isDev: false,
        allowProductionSwap: true,
        paseoHome: path.join(fakeUser, ".paseo"),
        paseoListen: "127.0.0.1:6767",
        userHome: fakeUser,
      }),
    ).not.toThrow();

    expect(() =>
      assertIsolatedDevDaemonHome({
        isDev: false,
        allowProductionSwap: true,
        paseoHome: path.join(fakeUser, ".paseo-workshop"),
        paseoListen: "127.0.0.1:6769",
        userHome: fakeUser,
      }),
    ).toThrow(/protected/);
  });

  it("swaps running dev daemon cleanly, skips restart when digest already matches, and quarantines + rolls back on crash", async () => {
    const root = makeTempDir();
    const userHome = path.join(root, "user");
    const devHome = path.join(userHome, ".paseo-dev");
    const editableHome = path.join(devHome, "editable");
    const configHome = path.join(root, "shared-editable");
    const builtIn = path.join(root, "builtin");
    mkdirSync(devHome, { recursive: true });
    mkdirSync(builtIn, { recursive: true });
    writeFileSync(path.join(builtIn, "index.html"), "<html>builtin</html>");

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    mkdirSync(path.join(configHome, "keys"), { recursive: true });
    writeFileSync(path.join(configHome, "keys", "signing.public.pem"), publicKeyPem);

    const goodRel = writeSignedDaemonRelease(configHome, privateKeyPem, publicKeyPem, {
      sourceSha: "1".repeat(40),
      summary: "Good daemon v1",
      scriptBody: "console.log('good-v1');\n",
    });
    const brokenRel = writeSignedDaemonRelease(configHome, privateKeyPem, publicKeyPem, {
      sourceSha: "2".repeat(40),
      summary: "Broken daemon v2",
      scriptBody: "throw new Error('boom');\n",
    });

    const store = new EditableReleaseStore({
      builtInDistDir: builtIn,
      home: editableHome,
      publicKeyHome: configHome,
    });

    let liveInstance: DaemonInstance | null = {
      pid: 1001,
      startedAt: "2026-11-26T10:00:00.000Z",
      listen: "127.0.0.1:6770",
      serverId: "srv-dev",
      desktopManaged: true,
    };
    let nextPid = 1002;
    const stopDaemon = vi.fn(async () => {
      liveInstance = null;
      return { ...makeRunningStatus(devHome, 0, ""), status: "stopped" as const, pid: null };
    });
    const startDaemon = vi.fn(async (override) => {
      if (override?.digest === brokenRel.releaseDigest) {
        return {
          ...makeRunningStatus(devHome, 0, ""),
          status: "errored" as const,
          pid: null,
          error: "Process exited with code 1",
        };
      }
      const pid = nextPid++;
      const startedAt = `2026-11-26T10:0${pid - 1000}:00.000Z`;
      liveInstance = {
        pid,
        startedAt,
        listen: "127.0.0.1:6770",
        serverId: "srv-dev",
        desktopManaged: true,
      };
      return makeRunningStatus(devHome, pid, startedAt);
    });

    const controller = new EditableDaemonController({
      store,
      paseoHome: () => devHome,
      paseoListen: () => "127.0.0.1:6770",
      userHome,
      isDevProfile: () => true,
      readInstance: async () => liveInstance,
      isProcessAlive: () => liveInstance !== null,
      stopDaemon,
      startDaemon,
    });

    // 1. Swap from built-in (null) -> goodRel
    const swap1 = await controller.applyDaemonTarget({
      targetDigest: goodRel.releaseDigest,
      channel: "wip-good",
    });
    expect(swap1).toEqual({
      ok: true,
      swapped: true,
      daemonRunning: true,
      activeDigest: goodRel.releaseDigest,
    });
    expect(stopDaemon).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledTimes(1);
    expect((await controller.getRunningState()).runningDigest).toBe(goodRel.releaseDigest);

    // 2. Re-applying the exact same digest (e.g., after fast-forward ship to prod) does NOT restart!
    const swapSame = await controller.applyDaemonTarget({
      targetDigest: goodRel.releaseDigest,
      channel: "prod",
      generation: 1,
    });
    expect(swapSame).toEqual({
      ok: true,
      swapped: false,
      daemonRunning: true,
      activeDigest: goodRel.releaseDigest,
    });
    expect(stopDaemon).toHaveBeenCalledTimes(1);
    expect(startDaemon).toHaveBeenCalledTimes(1);

    // 3. Swapping to brokenRel fails -> quarantines brokenRel and rolls back to goodRel automatically
    const swapBroken = await controller.applyDaemonTarget({
      targetDigest: brokenRel.releaseDigest,
      channel: "wip-broken",
    });
    expect(swapBroken.ok).toBe(false);
    expect(swapBroken.rolledBackTo).toBe(goodRel.releaseDigest);
    expect(store.isDaemonQuarantined(brokenRel.releaseDigest)).toBe(true);
    expect(store.activeDaemonDigest).toBe(goodRel.releaseDigest);
    // Start was called for brokenRel (failed) and then for goodRel rollback (succeeded)
    expect(startDaemon).toHaveBeenCalledTimes(3);
    expect(startDaemon.mock.calls[2]?.[0]?.digest).toBe(goodRel.releaseDigest);

    // 4. Resetting to built-in swaps back to null
    const resetRes = await controller.resetToBuiltIn();
    expect(resetRes).toMatchObject({ ok: true, swapped: true, activeDigest: null });
    expect(startDaemon.mock.calls[3]?.[0]).toBeNull();
  });

  it("loads a daemon-only WIP branch without reloading UI and flags running-daemon warning", async () => {
    const root = makeTempDir();
    const userHome = path.join(root, "user");
    const devHome = path.join(userHome, ".paseo-dev");
    const editableHome = path.join(devHome, "editable");
    const configHome = path.join(root, "shared-editable");
    const builtIn = path.join(root, "builtin");
    mkdirSync(devHome, { recursive: true });
    mkdirSync(builtIn, { recursive: true });
    writeFileSync(path.join(builtIn, "index.html"), "<html>builtin</html>");

    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    mkdirSync(path.join(configHome, "keys"), { recursive: true });
    writeFileSync(path.join(configHome, "keys", "signing.public.pem"), publicKeyPem);

    const daemonRel = writeSignedDaemonRelease(configHome, privateKeyPem, publicKeyPem, {
      sourceSha: "a".repeat(40),
      summary: "Antigravity metadata",
      scriptBody: "console.log('antigravity');\n",
    });

    const wipChanPath = path.join(
      configHome,
      "releases",
      "electron-web",
      "channels",
      "wip-antigravity.json",
    );
    mkdirSync(path.dirname(wipChanPath), { recursive: true });
    writeFileSync(
      wipChanPath,
      JSON.stringify(
        signEnvelope(
          {
            schemaVersion: 1,
            kind: "channel",
            channel: "wip-antigravity",
            generation: 1,
            updatedAt: "2026-11-26T10:00:00.000Z",
            surfaces: {
              daemon: {
                releaseDigest: daemonRel.releaseDigest,
                sourceSha: "a".repeat(40),
                runtimeVersion: DAEMON_RUNTIME_VERSION,
                archiveUrl: `https://example.test/releases/daemon/${daemonRel.releaseDigest}/archive.tar.gz`,
                manifestUrl: `https://example.test/releases/daemon/${daemonRel.releaseDigest}/manifest.json`,
                summary: "Antigravity metadata",
                updatedAt: "2026-11-26T10:00:00.000Z",
              },
            },
          },
          privateKeyPem,
          publicKeyPem,
        ),
      ),
    );
    const wipIndexPath = path.join(
      configHome,
      "releases",
      "electron-web",
      "channels",
      "wip-index.json",
    );
    writeFileSync(
      wipIndexPath,
      JSON.stringify(
        signEnvelope(
          {
            schemaVersion: 1,
            kind: "wip-index",
            generation: 1,
            updatedAt: "2026-11-26T10:00:00.000Z",
            branches: [
              {
                slug: "antigravity",
                branch: "ed/wip/antigravity",
                channel: "wip-antigravity",
                releaseDigest: null,
                daemonReleaseDigest: daemonRel.releaseDigest,
                services: ["daemon"],
                sourceSha: "a".repeat(40),
                summary: "Antigravity metadata",
                requiresDaemon: true,
                requiresNative: false,
                updatedAt: "2026-11-26T10:00:00.000Z",
              },
            ],
          },
          privateKeyPem,
          publicKeyPem,
        ),
      ),
    );

    const store = new EditableReleaseStore({
      builtInDistDir: builtIn,
      home: editableHome,
      publicKeyHome: configHome,
    });

    let liveInstance: DaemonInstance | null = {
      pid: 2001,
      startedAt: "2026-11-26T10:00:00.000Z",
      listen: "127.0.0.1:6770",
      serverId: "srv-dev",
      desktopManaged: true,
    };
    const controller = new EditableDaemonController({
      store,
      paseoHome: () => devHome,
      paseoListen: () => "127.0.0.1:6770",
      userHome,
      isDevProfile: () => true,
      readInstance: async () => liveInstance,
      isProcessAlive: () => liveInstance !== null,
      stopDaemon: async () => {
        liveInstance = null;
        return { ...makeRunningStatus(devHome, 0, ""), status: "stopped" as const, pid: null };
      },
      startDaemon: async () => {
        liveInstance = {
          pid: 2002,
          startedAt: "2026-11-26T10:01:00.000Z",
          listen: "127.0.0.1:6770",
          serverId: "srv-dev",
          desktopManaged: true,
        };
        return makeRunningStatus(devHome, 2002, "2026-11-26T10:01:00.000Z");
      },
    });

    const manager = new EditableBranchManager({
      home: editableHome,
      configHome,
      store,
      daemonController: controller,
    });

    const snapBefore = await manager.getSnapshot({
      loadedChannel: "prod",
      loadedDigest: null,
      safeRenderer: false,
    });
    expect(snapBefore.daemonRunning).toBe(true);
    const branch = snapBefore.branches.find((b) => b.slug === "antigravity");
    expect(branch).toMatchObject({
      status: "ready",
      services: ["daemon"],
      daemonReleaseDigest: daemonRel.releaseDigest,
      requiresDaemonRestartOnLoad: true,
    });

    const loaded = await manager.loadBranch("wip-antigravity", { currentLoadedDigest: null });
    expect(loaded.daemonSwapped).toBe(true);
    expect(loaded.uiChanged).toBe(false);
    expect((await controller.getRunningState()).runningDigest).toBe(daemonRel.releaseDigest);
  });
});
