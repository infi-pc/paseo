import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DESKTOP_RUNTIME_VERSION,
  generateSigningKeyPair,
  getEditablePaths,
  packReleaseArchive,
  readDeviceState,
  verifyExpoManifestBytes,
  writeJsonAtomic,
} from "@getpaseo/editable-core";
import worker, { type R2BucketLike } from "../../../infra/cloud-shelf/src/worker.js";
import { syncElectronFromCloudShelf } from "./cloud-sync.js";
import { ensureExpoCodeSigningKeys, publishIosOtaUpdate } from "./ios-ota.js";
import { signAndPublishElectronLocal } from "./runner.js";

function createMemoryR2(): R2BucketLike {
  const store = new Map<
    string,
    {
      bytes: Uint8Array;
      etag: string;
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  >();
  let seq = 0;

  return {
    async get(key) {
      const entry = store.get(key);
      if (!entry) return null;
      return {
        etag: entry.etag,
        httpMetadata: entry.httpMetadata,
        customMetadata: entry.customMetadata,
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(entry.bytes);
            controller.close();
          },
        }),
        async arrayBuffer() {
          return entry.bytes.buffer.slice(
            entry.bytes.byteOffset,
            entry.bytes.byteOffset + entry.bytes.byteLength,
          ) as ArrayBuffer;
        },
      };
    },
    async put(key, value, options) {
      const existing = store.get(key);
      const ifNoneMatch = options.onlyIf.get("if-none-match");
      const ifMatch = options.onlyIf.get("if-match");
      if (ifNoneMatch === "*" && existing) return null;
      if (ifMatch && (!existing || `"${existing.etag}"` !== ifMatch)) return null;

      let bytes: Uint8Array;
      if (value instanceof ArrayBuffer) {
        bytes = new Uint8Array(value);
      } else {
        const reader = value.getReader();
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
          const { done, value: chunk } = await reader.read();
          if (done) break;
          chunks.push(chunk);
          total += chunk.byteLength;
        }
        bytes = new Uint8Array(total);
        let offset = 0;
        for (const c of chunks) {
          bytes.set(c, offset);
          offset += c.byteLength;
        }
      }
      const etag = `etag-${++seq}`;
      store.set(key, {
        bytes,
        etag,
        httpMetadata: options.httpMetadata,
        customMetadata: options.customMetadata,
      });
      return { etag };
    },
  };
}

describe("Cloud Shelf end-to-end: Electron upload+sync & iOS Expo Updates v1 signed OTA", () => {
  it("uploads signed electron release to Worker, syncs to second device, and serves signed iOS Expo OTA", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "ed-cloud-e2e-"));
    try {
      const bucket = createMemoryR2();
      const UPLOAD_TOKEN = "test-upload-secret-123";
      const READ_TOKEN = "test-read-secret-456";
      const SHELF_URL = "https://shelf.example.test";

      const workerFetch: typeof fetch = async (input, init) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        return worker.fetch(req, { ARTIFACTS: bucket, UPLOAD_TOKEN, READ_TOKEN });
      };

      // Publisher machine home (Mac mini)
      const pubPaths = getEditablePaths(path.join(tmp, "publisher-home"));
      const kp = generateSigningKeyPair();
      await fs.mkdir(pubPaths.keysDir, { recursive: true });
      await fs.writeFile(pubPaths.privateKeyPath, kp.privateKeyPem, { mode: 0o600 });
      await fs.writeFile(pubPaths.publicKeyPath, kp.publicKeyPem, { mode: 0o644 });

      // Build mock electron-web artifact
      const appDist = path.join(tmp, "app-dist");
      await fs.mkdir(path.join(appDist, "_expo/static/js/web"), { recursive: true });
      await fs.writeFile(path.join(appDist, "index.html"), "<html>cloud-synced-ok</html>");
      await fs.writeFile(
        path.join(appDist, "_expo/static/js/web/entry-999.js"),
        "console.log(999);",
      );

      const archivePath = path.join(tmp, "electron.tar.gz");
      const unsignedManifest = await packReleaseArchive({
        sourceDir: appDist,
        outputArchivePath: archivePath,
        surface: "electron-web",
        sourceSha: "c".repeat(40),
        runtimeVersion: DESKTOP_RUNTIME_VERSION,
        summary: "Cloud Electron release",
      });
      const unsignedManifestPath = path.join(tmp, "electron.manifest.json");
      await writeJsonAtomic(unsignedManifestPath, unsignedManifest);

      // Patch global fetch temporarily for signAndPublishElectronLocal upload
      const origFetch = globalThis.fetch;
      globalThis.fetch = workerFetch;
      let publishedDigest: string;
      try {
        const pub = await signAndPublishElectronLocal({
          paths: pubPaths,
          archivePath,
          unsignedManifestPath,
          channel: "prod",
          cloudShelfUrl: SHELF_URL,
          cloudUploadToken: UPLOAD_TOKEN,
        });
        expect(pub.uploadedToCloud).toBe(true);
        expect(pub.generation).toBe(1);
        publishedDigest = pub.releaseDigest;
      } finally {
        globalThis.fetch = origFetch;
      }

      // Second device (primary Mac) holds ONLY the public key and syncs from Cloud Shelf!
      const devPaths = getEditablePaths(path.join(tmp, "device-home"));
      await fs.mkdir(devPaths.keysDir, { recursive: true });
      await fs.writeFile(devPaths.publicKeyPath, kp.publicKeyPem, { mode: 0o644 });

      const synced = await syncElectronFromCloudShelf({
        paths: devPaths,
        cloudShelfUrl: SHELF_URL,
        channel: "prod",
        readToken: READ_TOKEN,
        fetchImpl: workerFetch,
      });
      expect(synced.updated).toBe(true);
      expect(synced.releaseDigest).toBe(publishedDigest);
      expect(synced.generation).toBe(1);

      const devState = await readDeviceState(devPaths.deviceStatePath);
      expect(devState.activeDigest).toBe(publishedDigest);
      const syncedHtml = await fs.readFile(
        path.join(devPaths.electronReleasesDir, publishedDigest, "index.html"),
        "utf8",
      );
      expect(syncedHtml).toContain("cloud-synced-ok");

      // Now publish a signed iOS Expo Updates v1 OTA bundle through the same Worker!
      const worktree = path.join(tmp, "wt");
      const iosExportDir = path.join(worktree, "packages/app/dist-ios-ota");
      await fs.mkdir(path.join(iosExportDir, "_expo/static/js/ios"), { recursive: true });
      await fs.mkdir(path.join(iosExportDir, "assets"), { recursive: true });
      await fs.writeFile(
        path.join(iosExportDir, "_expo/static/js/ios/entry.hbc"),
        "HERMES_BYTECODE_V1",
      );
      await fs.writeFile(path.join(iosExportDir, "assets/icon.png"), "PNG_BYTES");
      await fs.writeFile(
        path.join(iosExportDir, "metadata.json"),
        JSON.stringify({
          version: 0,
          bundler: "metro",
          fileMetadata: {
            ios: {
              bundle: "_expo/static/js/ios/entry.hbc",
              assets: [{ path: "assets/icon.png", ext: "png" }],
            },
          },
        }),
      );

      const iosPub = await publishIosOtaUpdate({
        paths: pubPaths,
        worktreeDir: worktree,
        sourceSha: "d".repeat(40),
        runtimeVersion: "0.17.1",
        summary: "iOS OTA update test",
        channel: "prod",
        cloudShelfUrl: SHELF_URL,
        cloudUploadToken: UPLOAD_TOKEN,
        skipExport: true,
        fetchImpl: workerFetch,
      });
      expect(iosPub.generation).toBe(2);
      expect(iosPub.assetsUploaded).toBe(2);

      // Simulate real iPhone `expo-updates` client requesting /expo-updates/prod
      const expoReq = new Request(`${SHELF_URL}/expo-updates/prod`, {
        headers: {
          "expo-platform": "ios",
          "expo-runtime-version": "0.17.1",
          "expo-protocol-version": "1",
          "expo-expect-signature": 'sig, keyid="main", alg="rsa-v1_5-sha256"',
          accept: "multipart/mixed",
        },
      });
      const expoRes = await workerFetch(expoReq);
      expect(expoRes.status).toBe(200);
      const sigHeader = expoRes.headers.get("expo-signature");
      expect(sigHeader).toBeTruthy();

      // Verify the returned multipart manifest bytes against the pinned X.509 certificate!
      const bodyText = await expoRes.text();
      const jsonStart = bodyText.indexOf("{");
      const jsonEnd = bodyText.lastIndexOf("}");
      const manifestBytes = Buffer.from(bodyText.slice(jsonStart, jsonEnd + 1), "utf8");
      const expoKeys = await ensureExpoCodeSigningKeys(pubPaths, false);
      const certPem = await fs.readFile(expoKeys.certificatePath, "utf8");
      expect(verifyExpoManifestBytes(manifestBytes, sigHeader!, certPem)).toBe(true);

      // Verify mismatched runtimeVersion returns 204 No Content (safe against native skew!)
      const mismatchRes = await workerFetch(
        new Request(`${SHELF_URL}/expo-updates/prod`, {
          headers: {
            "expo-platform": "ios",
            "expo-runtime-version": "0.16.0",
            "expo-protocol-version": "1",
            accept: "multipart/mixed",
          },
        }),
      );
      expect(mismatchRes.status).toBe(204);
    } finally {
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
