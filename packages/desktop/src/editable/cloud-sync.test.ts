import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editableFixture } from "../../test-support/editable-fixture.js";
import { syncFromCloudShelf } from "./cloud-sync.js";
import { EditableReleaseStore } from "./release-store.js";

const base = "https://shelf.example.test";
const channelUrl = `${base}/channels/prod.json`;

describe("Editable Cloud Shelf sync", () => {
  let fixture: ReturnType<typeof editableFixture>;
  let home: string;
  let store: EditableReleaseStore;
  let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    fixture = editableFixture();
    home = path.join(fixture.root, "desktop-editable");
    store = new EditableReleaseStore({
      home,
      publicKeyHome: fixture.home,
      builtInDistDir: fixture.builtInDistDir,
    });
    fetchImpl = vi.fn<typeof fetch>();
    writeFileSync(path.join(fixture.home, "config.json"), JSON.stringify({ cloudShelfUrl: base }));
    writeFileSync(path.join(fixture.home, "cloud.env"), "EDITABLE_CLOUD_READ_TOKEN='test-token'\n");
  });
  afterEach(() => fixture.clean());

  function mockRelease(entry = "index.html", symlink = false) {
    const { digest, manifest } = fixture.release("cloud renderer");
    const content = path.join(fixture.root, "contents");
    mkdirSync(content);
    const outside = path.join(fixture.root, "outside");
    writeFileSync(outside, "cloud renderer");
    const index = path.join(content, "index.html");
    if (symlink) symlinkSync(outside, index, "file");
    else writeFileSync(index, "cloud renderer");
    const archiveFile = path.join(fixture.root, "release.tar.gz");
    execFileSync("tar", ["-Pczf", archiveFile, "-C", content, entry]);
    const archive = readFileSync(archiveFile);
    const channel = fixture.setChannel(digest, 2);
    const release = fixture.signed({
      ...manifest.payload,
      archiveSha256: createHash("sha256").update(archive).digest("hex"),
      archiveBytes: archive.length,
    });
    const releaseUrl = `${base}/releases/electron-web/${digest}`;
    const responses = new Map<string, () => Response>([
      [channelUrl, () => Response.json(channel)],
      [`${releaseUrl}/manifest.json`, () => Response.json(release)],
      [`${releaseUrl}/archive.tar.gz`, () => new Response(Uint8Array.from(archive))],
    ]);
    fetchImpl.mockImplementation(async (url) => {
      const response = responses.get(String(url));
      if (!response) throw new Error(`Unexpected URL ${String(url)}`);
      return response();
    });
    return { digest, release, archive, channel };
  }

  const sync = () =>
    syncFromCloudShelf({
      home,
      configHome: fixture.home,
      publicKey: () => store.publicKey(),
      shouldInstall: (candidate) => store.shouldInstallCloudChannel(candidate),
      fetchImpl,
    });

  it("installs a signed release for the local runtime with the Shelf read token", async () => {
    const { digest } = mockRelease();
    expect(await sync()).toBe(true);
    expect(fetchImpl).toHaveBeenNthCalledWith(
      1,
      channelUrl,
      expect.objectContaining({
        headers: { Authorization: "Bearer test-token" },
        redirect: "error",
      }),
    );
    expect(store.reloadChannel({ fromMenu: true }).releaseDigest).toBe(digest);
    expect(store.getStatus(1).activeGeneration).toBe(2);
    fetchImpl.mockClear();
    expect(await sync()).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a tampered signed channel before downloading artifacts", async () => {
    const { channel } = mockRelease();
    channel.payload.generation++;
    await expect(sync()).rejects.toThrow("Invalid Cloud Shelf channel signature");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(existsSync(home)).toBe(false);
  });

  it("rejects a tampered signed release before downloading its archive", async () => {
    const { release } = mockRelease();
    release.payload.archiveSha256 = "0".repeat(64);
    await expect(sync()).rejects.toThrow("Invalid Cloud Shelf release signature");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(existsSync(home)).toBe(false);
  });

  it("rejects an archive with a mismatched digest", async () => {
    const { archive } = mockRelease();
    archive[0] ^= 1;
    await expect(sync()).rejects.toThrow("archive integrity check failed");
    expect(existsSync(home)).toBe(false);
  });

  it.each([
    ["path traversal", "../outside", false],
    ["symlinks", "index.html", true],
  ])("rejects %s even in a signed archive", async (_label, entry, symlink) => {
    const { digest } = mockRelease(entry, symlink);
    await expect(sync()).rejects.toThrow("unsafe or undeclared entries");
    expect(existsSync(path.join(home, "releases/electron-web", digest))).toBe(false);
    expect(existsSync(path.join(home, "releases/electron-web/channel.json"))).toBe(false);
  });

  it("skips a signed channel older than the active generation", async () => {
    const { channel } = mockRelease();
    await sync();
    store.reloadChannel({ fromMenu: true });
    const older = fixture.setChannel("a".repeat(64), channel.payload.generation - 1);
    fetchImpl.mockReset().mockResolvedValue(Response.json(older));
    expect(await sync()).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(store.getStatus(1).activeGeneration).toBe(2);
  });

  it("skips quarantined digests even when published at a newer generation", async () => {
    const { digest, channel } = mockRelease();
    await sync();
    store.reloadChannel({ fromMenu: true });
    store.quarantine(digest);
    fetchImpl.mockReset().mockResolvedValue(
      Response.json(
        fixture.signed({
          ...channel.payload,
          generation: 3,
        }),
      ),
    );
    expect(await sync()).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
