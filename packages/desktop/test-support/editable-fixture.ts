import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DESKTOP_RUNTIME_VERSION } from "../src/editable/constants.js";
import { canonicalJson, computeKeyId } from "../src/editable/crypto.js";

const now = "2026-01-01T00:00:00Z";

export function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

export function editableFixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "paseo-editable-test-"));
  const home = path.join(root, "editable");
  const builtInDistDir = path.join(root, "builtin");
  const channelDir = path.join(home, "releases", "electron-web");
  const channelPath = path.join(channelDir, "channel.json");
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  mkdirSync(path.join(home, "keys"), { recursive: true });
  mkdirSync(channelDir, { recursive: true });
  mkdirSync(builtInDistDir);
  writeFileSync(path.join(home, "keys", "signing.public.pem"), publicKeyPem);
  writeFileSync(path.join(builtInDistDir, "index.html"), "built-in");
  writeFileSync(path.join(builtInDistDir, "shared.css"), "built-in CSS");

  function signed<T>(payload: T) {
    return {
      payload,
      keyId: computeKeyId(publicKeyPem),
      signature: sign(null, Buffer.from(canonicalJson(payload)), privateKey).toString("base64"),
    };
  }

  function release(label: string, extra: Record<string, string> = {}) {
    const digest = sha256(label);
    const distDir = path.join(channelDir, digest);
    const files = { ...extra, "index.html": label };
    const payload = {
      schemaVersion: 1,
      kind: "release",
      surface: "electron-web",
      runtimeVersion: DESKTOP_RUNTIME_VERSION,
      releaseDigest: digest,
      sourceSha: "a".repeat(40),
      archiveSha256: "b".repeat(64),
      archiveBytes: 200,
      summary: label,
      createdAt: now,
      files: Object.keys(files)
        .sort()
        .map((file) => {
          const content = files[file as keyof typeof files];
          const filename = path.join(distDir, file);
          mkdirSync(path.dirname(filename), { recursive: true });
          writeFileSync(filename, content);
          return { path: file, bytes: Buffer.byteLength(content), sha256: sha256(content) };
        }),
    };
    const manifest = signed(payload);
    writeFileSync(path.join(distDir, "manifest.json"), JSON.stringify(manifest));
    return { digest, distDir, manifest };
  }

  function setChannel(digest: string, generation: number) {
    const envelope = signed({
      schemaVersion: 1,
      kind: "channel",
      channel: "prod",
      generation,
      updatedAt: now,
      surfaces: {
        "electron-web": {
          releaseDigest: digest,
          sourceSha: "a".repeat(40),
          runtimeVersion: DESKTOP_RUNTIME_VERSION,
          archiveUrl: "https://example.test/release.tar.gz",
          manifestUrl: "https://example.test/manifest.json",
          summary: "release",
          updatedAt: now,
        },
      },
    });
    writeFileSync(channelPath, JSON.stringify(envelope));
    return envelope;
  }

  return {
    root,
    home,
    builtInDistDir,
    publicKeyPem,
    channelPath,
    signed,
    release,
    setChannel,
    clean: () => rmSync(root, { recursive: true, force: true }),
  };
}
