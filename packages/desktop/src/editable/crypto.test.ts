import { generateKeyPairSync } from "node:crypto";
import { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DESKTOP_RUNTIME_VERSION } from "./constants.js";
import { canonicalJson, verifyReleaseDirectory } from "./crypto.js";
import { editableFixture } from "../../test-support/editable-fixture.js";

let fixture: ReturnType<typeof editableFixture>;
beforeEach(() => {
  fixture = editableFixture();
});
afterEach(() => fixture.clean());

describe("signed renderer manifest", () => {
  it("sorts keys recursively, including keys JavaScript treats as numeric", () => {
    expect(canonicalJson({ z: [null, { b: true, a: "x" }], 2: "two", 10: "ten" })).toBe(
      '{"10":"ten","2":"two","z":[null,{"a":"x","b":true}]}',
    );
  });

  it("checks the signed file list with the pinned Ed25519 key", () => {
    const release = fixture.release("hello", { "_expo/chunk.js": "chunk" });
    expect(
      verifyReleaseDirectory(
        release.distDir,
        release.manifest,
        fixture.publicKeyPem,
        DESKTOP_RUNTIME_VERSION,
      ),
    ).toMatchObject({ releaseDigest: release.digest, files: release.manifest.payload.files });
  });

  it("rejects tampered signatures, payloads, key IDs, public keys and file bytes", () => {
    const { distDir, manifest } = fixture.release("hello");
    const verify = (input: unknown, pem = fixture.publicKeyPem) =>
      verifyReleaseDirectory(distDir, input, pem, DESKTOP_RUNTIME_VERSION);
    const first = manifest.signature.startsWith("a") ? "b" : "a";
    expect(() => verify({ ...manifest, signature: first + manifest.signature.slice(1) })).toThrow(
      "signature",
    );
    expect(() =>
      verify({ ...manifest, payload: { ...manifest.payload, summary: "different" } }),
    ).toThrow("signature");
    expect(() => verify({ ...manifest, keyId: "0".repeat(16) })).toThrow("signature");
    const wrongKey = generateKeyPairSync("ed25519").publicKey.export({
      type: "spki",
      format: "pem",
    });
    expect(() => verify(manifest, wrongKey.toString())).toThrow("signature");
    writeFileSync(path.join(distDir, "index.html"), "HELLO");
    expect(() => verify(manifest)).toThrow("integrity");
  });

  it("rejects incompatible runtimes and manifests without a signed index", () => {
    const { distDir, manifest } = fixture.release("hello");
    expect(() =>
      verifyReleaseDirectory(distDir, manifest, fixture.publicKeyPem, "desktop-2"),
    ).toThrow("runtime mismatch");
    expect(() =>
      verifyReleaseDirectory(
        distDir,
        fixture.signed({ ...manifest.payload, files: [] }),
        fixture.publicKeyPem,
        DESKTOP_RUNTIME_VERSION,
      ),
    ).toThrow("missing index.html");
  });

  it.each([
    "../index.html",
    "/index.html",
    "nested/../index.html",
    "nested\\index.html",
    "nested/.. /index.html",
    "index\u0000.html",
  ])("rejects unsafe signed file paths (%j)", (unsafePath) => {
    const { distDir, manifest } = fixture.release("hello");
    const files = [{ ...manifest.payload.files[0], path: unsafePath }];
    expect(() =>
      verifyReleaseDirectory(
        distDir,
        fixture.signed({ ...manifest.payload, files }),
        fixture.publicKeyPem,
        DESKTOP_RUNTIME_VERSION,
      ),
    ).toThrow("Invalid or missing release file");
  });

  it("rejects symlinked files and intermediate directories even with matching bytes", () => {
    const { distDir, manifest } = fixture.release("hello", { "nested/chunk.js": "chunk" });
    const verify = () =>
      verifyReleaseDirectory(distDir, manifest, fixture.publicKeyPem, DESKTOP_RUNTIME_VERSION);

    const originalIndex = path.join(distDir, "index.html");
    renameSync(originalIndex, path.join(fixture.root, "outside.html"));
    symlinkSync(path.join(fixture.root, "outside.html"), originalIndex);
    expect(verify).toThrow("Invalid or missing release file: index.html");

    const second = fixture.release("another", { "nested/chunk.js": "chunk" });
    const outside = path.join(fixture.root, "outside");
    mkdirSync(outside);
    renameSync(path.join(second.distDir, "nested"), path.join(outside, "nested"));
    symlinkSync(path.join(outside, "nested"), path.join(second.distDir, "nested"), "junction");
    expect(() =>
      verifyReleaseDirectory(
        second.distDir,
        second.manifest,
        fixture.publicKeyPem,
        DESKTOP_RUNTIME_VERSION,
      ),
    ).toThrow("Invalid or missing release file: nested/chunk.js");
  });
});
