import { readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEditableProtocolHandler, rendererNavigationUrl } from "./protocol.js";
import { editableFixture } from "../../test-support/editable-fixture.js";
import { EditableReleaseStore } from "./release-store.js";

let fixture: ReturnType<typeof editableFixture>;
beforeEach(() => {
  fixture = editableFixture();
});
afterEach(() => {
  vi.unstubAllEnvs();
  fixture.clean();
});

const CHUNK_A = "_expo/static/js/web/chunk-aaa.js";
const CHUNK_B = "_expo/static/js/web/chunk-bbb.js";

function protocol(store: EditableReleaseStore) {
  const handle = createEditableProtocolHandler(
    store,
    async (url) => new Response(new Uint8Array(await readFile(new URL(url)))),
  );
  return (url: string) => handle(new Request(url));
}

describe("editable release store", () => {
  it("loads a saved release while offline and rejects generation rollback and equivocation", async () => {
    const a = fixture.release("release A");
    const b = fixture.release("release B");
    fixture.setChannel(a.digest, 1);
    const store = new EditableReleaseStore(fixture);
    expect(store.activeRelease.releaseDigest).toBe(a.digest);

    fixture.setChannel(b.digest, 2);
    expect(store.reloadChannel().releaseDigest).toBe(b.digest);
    fixture.setChannel(a.digest, 1);
    expect(() => store.reloadChannel()).toThrow("superseded");
    expect(() => store.reloadChannel({ fromMenu: true })).toThrow("superseded");
    fixture.setChannel(a.digest, 2);
    expect(() => store.reloadChannel()).toThrow("superseded");

    await rm(fixture.channelPath);
    const offline = new EditableReleaseStore(fixture);
    expect(offline.getStatus(1)).toMatchObject({ activeGeneration: 2, activeDigest: b.digest });
  });

  it("offers a new local channel release and advances the generation on an IPC-style switch", () => {
    const a = fixture.release("release A");
    const b = fixture.release("release B");
    fixture.setChannel(a.digest, 1);
    const store = new EditableReleaseStore(fixture);
    store.pin(1, store.activeRelease);

    fixture.setChannel(b.digest, 2);
    expect(store.getStatus(1)).toMatchObject({
      activeDigest: a.digest,
      releaseDigest: a.digest,
      availableDigest: b.digest,
      activeGeneration: 1,
    });

    expect(store.switchRelease(b.digest).releaseDigest).toBe(b.digest);
    fixture.setChannel(a.digest, 1);
    expect(store.getStatus(1)).toMatchObject({
      activeDigest: b.digest,
      releaseDigest: a.digest,
      availableDigest: null,
      activeGeneration: 2,
    });
    expect(new EditableReleaseStore(fixture).activeRelease.releaseDigest).toBe(b.digest);
  });

  it("ignores an unsigned channel change and preserves the accepted generation", async () => {
    const a = fixture.release("release A");
    const b = fixture.release("release B");
    fixture.setChannel(a.digest, 1);
    const store = new EditableReleaseStore(fixture);
    const envelope = fixture.setChannel(b.digest, 2);
    await writeFile(fixture.channelPath, JSON.stringify({ ...envelope, keyId: "0".repeat(16) }));
    expect(() => store.reloadChannel()).toThrow("signature");
    expect(new EditableReleaseStore(fixture).getStatus(1)).toMatchObject({
      activeGeneration: 1,
      activeDigest: a.digest,
    });
  });

  it("keeps two windows' documents and content-hashed lazy chunks available on the same origin", async () => {
    const a = fixture.release("release A", {
      [CHUNK_A]: "old chunk",
      "shared.css": "A",
      "_expo/data/blob": "blob",
    });
    const b = fixture.release("release B", { [CHUNK_B]: "new chunk", "shared.css": "B" });
    fixture.setChannel(a.digest, 1);
    const store = new EditableReleaseStore(fixture);
    const releaseA = store.activeRelease;
    store.pin(1, releaseA);
    fixture.setChannel(b.digest, 2);
    const releaseB = store.reloadChannel();
    store.pin(2, releaseB);
    const request = protocol(store);

    const routeA = rendererNavigationUrl("/agents/old", releaseA);
    const routeB = rendererNavigationUrl("/agents/new", releaseB);
    expect(new URL(routeA).host).toBe(new URL(routeB).host);
    expect(await (await request(routeA)).text()).toBe("release A");
    expect(await (await request(routeB)).text()).toBe("release B");
    expect(await (await request(`paseo://app/${CHUNK_A}`)).text()).toBe("old chunk");
    expect(await (await request(`paseo://app/${CHUNK_B}`)).text()).toBe("new chunk");
    expect(await (await request("paseo://app/shared.css")).text()).toBe("B");
    expect(await (await request("paseo://app/_expo/data/blob")).text()).toBe("blob");

    const scoped = `paseo://app/__ed/${a.digest.slice(0, 16)}`;
    expect(await (await request(`${scoped}/index.html`)).text()).toBe("release A");
    expect((await request(`${scoped}/${CHUNK_B}`)).status).toBe(404);
    expect((await request(`${scoped}/nested%2F..%2Fsecret`)).status).toBe(404);
    expect((await request("paseo://outside/shared.css")).status).toBe(404);
    store.unpin(1);
    expect((await request(`paseo://app/${CHUNK_A}`)).status).toBe(404);
  });

  it("serves only signed bytes, including after a verified directory is modified", async () => {
    const a = fixture.release("release A", { [CHUNK_A]: "old chunk", [CHUNK_B]: "new chunk" });
    fixture.setChannel(a.digest, 1);
    const store = new EditableReleaseStore(fixture);
    const request = protocol(store);

    await writeFile(path.join(a.distDir, CHUNK_A), "bad chunk");
    await rm(path.join(a.distDir, CHUNK_B));
    await symlink(path.join(fixture.builtInDistDir, "index.html"), path.join(a.distDir, CHUNK_B));
    await writeFile(path.join(a.distDir, "unsigned.js"), "unsigned");
    expect((await request(`paseo://app/${CHUNK_A}`)).status).toBe(404);
    expect((await request(`paseo://app/${CHUNK_B}`)).status).toBe(404);
    expect((await request("paseo://app/unsigned.js")).status).toBe(404);
    await rm(path.join(a.distDir, "index.html"));
    expect((await request(rendererNavigationUrl("/", store.activeRelease))).type).toBe("error");
  });

  it("uses the built-in renderer with no editable home or with the safe flag", async () => {
    const missingHome = path.join(fixture.root, "missing");
    const offline = new EditableReleaseStore({
      builtInDistDir: fixture.builtInDistDir,
      home: missingHome,
    });
    expect(await (await protocol(offline)("paseo://app/")).text()).toBe("built-in");

    const a = fixture.release("release A");
    fixture.setChannel(a.digest, 1);
    const argv = [...process.argv];
    process.argv.push("--safe-renderer");
    try {
      const safe = new EditableReleaseStore(fixture);
      expect(safe.getStatus(1)).toMatchObject({ safeRenderer: true, activeDigest: null });
      expect(() => safe.switchRelease(a.digest)).toThrow("safe renderer");
      expect(await (await protocol(safe)("paseo://app/")).text()).toBe("built-in");
    } finally {
      process.argv = argv;
    }
    vi.stubEnv("PASEO_SAFE_RENDERER", "1");
    expect(new EditableReleaseStore(fixture).activeRelease.releaseDigest).toBeNull();
  });

  it("keeps a recovery window built-in and can explicitly reload an accepted channel", () => {
    const a = fixture.release("release A");
    fixture.setChannel(a.digest, 1);
    const store = new EditableReleaseStore(fixture);
    store.switchRelease(null);
    expect(new EditableReleaseStore(fixture).activeRelease.releaseDigest).toBe(null);
    expect(store.reloadChannel({ fromMenu: true }).releaseDigest).toBe(a.digest);
    expect(store.useRecoveryRenderer().releaseDigest).toBe(null);
    expect(store.reloadChannel({ fromMenu: true }).releaseDigest).toBe(a.digest);
  });
});
