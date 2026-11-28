import { beforeEach, describe, expect, it, vi } from "vitest";
import worker, { type R2BucketLike } from "./worker.js";

interface StoredObject {
  bytes: ArrayBuffer;
  etag: string;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

class MemoryBucket implements R2BucketLike {
  readonly objects = new Map<string, StoredObject>();
  private version = 0;

  seed(
    key: string,
    body: string | ArrayBuffer,
    metadata: Omit<StoredObject, "bytes" | "etag"> = {},
  ) {
    const bytes = typeof body === "string" ? new TextEncoder().encode(body).buffer : body;
    const object = { bytes, etag: String(++this.version), ...metadata };
    this.objects.set(key, object);
    return object;
  }

  async get(key: string) {
    const object = this.objects.get(key);
    if (!object) return null;
    return {
      ...object,
      body: new Blob([object.bytes]).stream(),
      arrayBuffer: async () => object.bytes.slice(0),
    };
  }

  async put(
    key: string,
    value: ArrayBuffer | ReadableStream<Uint8Array>,
    { onlyIf, httpMetadata }: Parameters<R2BucketLike["put"]>[2],
  ) {
    const bytes = await new Response(value).arrayBuffer();
    const current = this.objects.get(key);
    if (onlyIf.get("if-none-match") === "*" && current) return null;
    const match = onlyIf.get("if-match");
    if (match && (!current || match !== `"${current.etag}"`)) return null;
    return this.seed(key, bytes, { httpMetadata });
  }
}

const uploadToken = "upload-secret";
const archiveAuth = { authorization: `Bearer ${uploadToken}` };
const releaseDigest = "a".repeat(64);
const assetDigest = "b".repeat(64);
const desktopRelease = `/releases/electron-web/${releaseDigest}`;
const daemonRelease = `/releases/daemon/${releaseDigest}`;
const iosRelease = `/releases/ios-ota/${releaseDigest}`;
const archive = `${desktopRelease}/archive.tar.gz`;
const daemonArchive = `${daemonRelease}/archive.tar.gz`;
const daemonManifest = `${daemonRelease}/manifest.json`;
const releaseManifest = `${desktopRelease}/manifest.json`;
const expoManifest = `${iosRelease}/expo-manifest.json`;
const channel = "/channels/prod.json";
const expo = "/expo-updates/prod";
const updateId = "99999999-aabb-4ccd-8def-111111111111";
const runtimeVersion = "ios-runtime-1";
const sourceSha = "c".repeat(40);
const createdAt = "2026-11-23T15:00:00.000Z";
const expoHeaders = {
  accept: "application/expo+json;q=0.9, application/json;q=0.8, multipart/mixed",
  "expo-platform": "ios",
  "expo-runtime-version": runtimeVersion,
  "expo-protocol-version": "1",
};
const expoSignature = 'sig="abc123==", keyid="root", alg="rsa-v1_5-sha256"';

function envelope(payload: object): string {
  return JSON.stringify({ payload, signature: "c2lnbmF0dXJl", keyId: "0123456789abcdef" });
}

function channelEnvelope(generation: number, includeIos = true): string {
  return envelope({
    schemaVersion: 1,
    kind: "channel",
    channel: "prod",
    generation,
    updatedAt: createdAt,
    surfaces: includeIos
      ? {
          "ios-ota": {
            releaseDigest,
            sourceSha,
            runtimeVersion,
            summary: "iOS update",
            updatedAt: createdAt,
            archiveUrl: `https://shelf.example${iosRelease}/archive.tar.gz`,
            manifestUrl: `https://shelf.example${iosRelease}/manifest.json`,
          },
        }
      : {},
  });
}

const releaseEnvelope = envelope({
  schemaVersion: 1,
  kind: "release",
  surface: "electron-web",
  releaseDigest,
  sourceSha,
  runtimeVersion: "desktop-1",
  archiveSha256: assetDigest,
  archiveBytes: 4,
  files: [],
  summary: "Desktop update",
  createdAt,
});

const expoBody =
  JSON.stringify(
    {
      id: updateId,
      createdAt,
      runtimeVersion,
      launchAsset: {
        key: assetDigest,
        contentType: "application/javascript",
        url: `https://shelf.example${iosRelease}/assets/${assetDigest}`,
      },
      assets: [],
      metadata: {},
      extra: {},
    },
    null,
    2,
  ) + "\n";

describe("cloud shelf", () => {
  let bucket: MemoryBucket;
  let env: { ARTIFACTS: MemoryBucket; UPLOAD_TOKEN: string; READ_TOKEN?: string };

  beforeEach(() => {
    bucket = new MemoryBucket();
    env = { ARTIFACTS: bucket, UPLOAD_TOKEN: uploadToken };
  });

  function request(path: string, init?: RequestInit) {
    return worker.fetch(new Request(`https://shelf.example${path}`, init), env);
  }

  function put(path: string, body: BodyInit, headers = archiveAuth) {
    return request(path, { method: "PUT", body, headers });
  }

  function seedExpo(body = expoBody, signature = expoSignature) {
    bucket.seed(channel.slice(1), channelEnvelope(1));
    bucket.seed(expoManifest.slice(1), body, { customMetadata: { "expo-signature": signature } });
  }

  it("reports health without storage access or authorization", async () => {
    const response = await request("/health");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });

  it.each([archive, releaseManifest, channel])("requires the upload token for %s", async (path) => {
    expect((await put(path, "body", { authorization: "" })).status).toBe(401);
    expect((await put(path, "body", { authorization: "Bearer upload-secreu" })).status).toBe(401);
    expect((await put(path, "body", { authorization: "Basic upload-secret" })).status).toBe(401);
    expect(bucket.objects.size).toBe(0);
  });

  it("creates an immutable archive and rejects overwrites", async () => {
    const original = new Uint8Array([0, 0xff, 1, 2]);
    expect((await put(archive, original)).status).toBe(201);
    expect((await put(archive, "different bytes")).status).toBe(409);
    const response = await request(archive);
    expect(response.headers.get("content-type")).toBe("application/gzip");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(original);
  });

  it("creates immutable daemon release archives and manifests and rejects expo-manifest under daemon", async () => {
    const payload = new Uint8Array([1, 2, 3, 4]);
    expect((await put(daemonArchive, payload)).status).toBe(201);
    expect((await put(daemonArchive, payload)).status).toBe(409);
    expect((await put(daemonManifest, releaseEnvelope)).status).toBe(201);
    expect((await put(`${daemonRelease}/expo-manifest.json`, expoBody)).status).toBe(400);
    const fetched = await request(daemonArchive);
    expect(fetched.status).toBe(200);
    expect(fetched.headers.get("content-type")).toBe("application/gzip");
    expect(fetched.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(new Uint8Array(await fetched.arrayBuffer())).toEqual(payload);
  });

  it("allows only one concurrent release upload to create the object", async () => {
    const results = await Promise.all([put(archive, "first"), put(archive, "second")]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 409]);
    const winner = results[0]?.status === 201 ? "first" : "second";
    expect(await (await request(archive)).text()).toBe(winner);
  });

  it("validates release envelopes and returns the original signed JSON", async () => {
    expect((await put(releaseManifest, "invalid")).status).toBe(400);
    expect((await put(releaseManifest, '{"payload":{},"keyId":"signer"}')).status).toBe(400);
    const original = releaseEnvelope + "\n";
    expect((await put(releaseManifest, original)).status).toBe(201);
    expect((await put(releaseManifest, releaseEnvelope)).status).toBe(409);
    const response = await request(releaseManifest);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe(original);
  });

  it("advances channel generations and rejects equal, stale and invalid writes", async () => {
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect((await put(channel, channelEnvelope(invalid))).status).toBe(400);
    }
    expect((await put(channel, envelope({ generation: "1" }))).status).toBe(400);
    expect((await put(channel, channelEnvelope(1))).status).toBe(201);
    expect((await put(channel, channelEnvelope(2))).status).toBe(201);
    expect((await put(channel, channelEnvelope(2))).status).toBe(409);
    expect((await put(channel, channelEnvelope(1))).status).toBe(409);

    const response = await request(channel);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(channelEnvelope(2));
  });

  it("prevents a concurrent stale write from rolling the channel backward", async () => {
    expect((await put(channel, channelEnvelope(1))).status).toBe(201);
    const reachedWrite = Promise.withResolvers<void>();
    const allowWrite = Promise.withResolvers<void>();
    const write = bucket.put.bind(bucket);
    vi.spyOn(bucket, "put").mockImplementationOnce(async (...args) => {
      reachedWrite.resolve();
      await allowWrite.promise;
      return write(...args);
    });

    const older = put(channel, channelEnvelope(2));
    await reachedWrite.promise;
    const newer = await put(channel, channelEnvelope(3));
    allowWrite.resolve();

    expect(newer.status).toBe(201);
    expect((await older).status).toBe(409);
    expect(await (await request(channel)).text()).toBe(channelEnvelope(3));
  });

  it("requires the read token for raw channel GETs when configured", async () => {
    env.READ_TOKEN = "read-secret";
    expect((await put(channel, channelEnvelope(1))).status).toBe(201);
    const denied = await request(channel, { headers: archiveAuth });
    expect(denied.status).toBe(401);
    expect(denied.headers.get("cache-control")).toBe("no-store");
    const allowed = await request(channel, { headers: { authorization: "Bearer read-secret" } });
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("cache-control")).toBe("no-store");
  });

  it("serves content-addressed Expo assets with their stored MIME type", async () => {
    const path = `${iosRelease}/assets/${assetDigest}`;
    bucket.seed(path.slice(1), "bundle", {
      httpMetadata: { contentType: "application/javascript" },
    });
    const response = await request(path);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/javascript");
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(await response.text()).toBe("bundle");
  });

  it.each([
    "/releases/android/" + releaseDigest + "/archive.tar.gz",
    "/releases/ios-ota/short/archive.tar.gz",
    desktopRelease + "/expo-manifest.json",
    iosRelease + "/assets/short",
    iosRelease + "/archive.tar.gz/extra",
    iosRelease + "/assets/..%2fmanifest.json",
    iosRelease + "/assets/%252e%252e",
    iosRelease + "//manifest.json",
    "/channels/bad%00.json",
    "/expo-updates/prod/extra",
  ])("rejects invalid paths with 400 (%s)", async (path) => {
    expect((await request(path)).status).toBe(400);
  });

  it("does not cache missing artifacts as immutable", async () => {
    const response = await request(archive);
    expect(response.status).toBe(404);
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("serves the exact Expo manifest bytes and signature in a v1 multipart response", async () => {
    seedExpo();
    const response = await request(expo, {
      headers: { ...expoHeaders, "expo-expect-signature": "sig" },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("expo-protocol-version")).toBe("1");
    expect(response.headers.get("expo-sfv-version")).toBe("0");
    expect(response.headers.get("expo-signature")).toBe(expoSignature);
    const type = response.headers.get("content-type");
    expect(type).toMatch(/^multipart\/mixed; boundary=[a-f0-9-]+$/);
    const boundary = type?.split("boundary=")[1];
    expect(await response.text()).toBe(
      [
        `--${boundary}`,
        'content-disposition: form-data; name="manifest"',
        "content-type: application/json",
        `expo-signature: ${expoSignature}`,
        "",
        expoBody,
        `--${boundary}--`,
        "",
      ].join("\r\n"),
    );
  });

  it.each([
    { "expo-runtime-version": "other-runtime" },
    { "expo-current-update-id": updateId.toUpperCase() },
  ])("returns an empty v1 response when no update applies (%j)", async (override) => {
    seedExpo();
    const response = await request(expo, { headers: { ...expoHeaders, ...override } });
    expect(response.status).toBe(204);
    expect(response.headers.get("expo-protocol-version")).toBe("1");
    expect(response.headers.get("content-type")).toBeNull();
    expect(await response.text()).toBe("");
  });

  it("returns no update for missing channels, missing iOS pointers, and missing Expo manifests", async () => {
    const check = () => request(expo, { headers: expoHeaders });
    expect((await check()).status).toBe(204);
    bucket.seed(channel.slice(1), channelEnvelope(1, false));
    expect((await check()).status).toBe(204);
    bucket.seed(channel.slice(1), channelEnvelope(2));
    expect((await check()).status).toBe(204);
  });

  it("checks the stored manifest runtime independently of the channel pointer", async () => {
    seedExpo(expoBody.replace(runtimeVersion, "other-runtime"));
    expect((await request(expo, { headers: expoHeaders })).status).toBe(204);
  });

  it("rejects an unsupported Expo protocol, platform, or response format", async () => {
    seedExpo();
    expect(
      (await request(expo, { headers: { ...expoHeaders, "expo-protocol-version": "0" } })).status,
    ).toBe(406);
    expect(
      (await request(expo, { headers: { ...expoHeaders, "expo-platform": "android" } })).status,
    ).toBe(400);
    expect(
      (await request(expo, { headers: { ...expoHeaders, accept: "multipart/mixed;q=0, */*" } }))
        .status,
    ).toBe(406);
  });

  it("fails closed when the client expects signing and the stored signature is missing", async () => {
    seedExpo(expoBody, "");
    const response = await request(expo, {
      headers: { ...expoHeaders, "expo-expect-signature": "sig" },
    });
    expect(response.status).toBe(502);
  });
});
