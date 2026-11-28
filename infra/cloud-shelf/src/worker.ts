interface R2ObjectLike {
  etag: string;
  body: ReadableStream<Uint8Array>;
  arrayBuffer(): Promise<ArrayBuffer>;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
}

export interface R2BucketLike {
  get(key: string): Promise<R2ObjectLike | null>;
  put(
    key: string,
    value: ArrayBuffer | ReadableStream<Uint8Array>,
    options: {
      onlyIf: Headers;
      httpMetadata: { contentType: string };
      customMetadata?: Record<string, string>;
    },
  ): Promise<{ etag: string } | null>;
}

interface Env {
  ARTIFACTS: R2BucketLike;
  UPLOAD_TOKEN: string;
  READ_TOKEN?: string;
}

const channelPath = /^\/channels\/[a-z0-9][a-z0-9_-]{0,62}\.json$/;
const expoPath = /^\/expo-updates\/([a-z0-9][a-z0-9_-]{0,62})$/;
const releasePath =
  /^\/releases\/(electron-web|ios-ota|daemon)\/[a-f0-9]{64}\/(archive\.tar\.gz|manifest\.json|expo-manifest\.json|assets\/[a-f0-9]{64})$/;
const digest = /^[a-f0-9]{64}$/;
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const json = "application/json";
const noStore = "no-store";
const immutable = "public, max-age=31536000, immutable";
const expoHeaders = {
  "cache-control": noStore,
  "expo-protocol-version": "1",
  "expo-sfv-version": "0",
};

function problem(status: number, error: string, headers?: HeadersInit): Response {
  return Response.json({ error }, { status, headers });
}

async function authorized(request: Request, token?: string): Promise<boolean> {
  const candidate = /^Bearer ([!-~]+)$/i.exec(request.headers.get("authorization") ?? "")?.[1];
  if (!token || !candidate) return false;

  // Web Crypto verifies fixed-length MACs without a string or prefix comparison.
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  const candidateMac = await crypto.subtle.sign("HMAC", key, encoder.encode(candidate));
  return crypto.subtle.verify("HMAC", key, candidateMac, encoder.encode(token));
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseObject(bytes: ArrayBuffer): Record<string, unknown> | undefined {
  try {
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (record(value)) return value;
  } catch {
    return undefined;
  }
}

function signedPayload(bytes: ArrayBuffer): Record<string, unknown> | undefined {
  const envelope = parseObject(bytes);
  if (
    envelope &&
    record(envelope.payload) &&
    typeof envelope.signature === "string" &&
    envelope.signature.length > 0 &&
    typeof envelope.keyId === "string" &&
    envelope.keyId.length > 0
  ) {
    return envelope.payload;
  }
}

function generation(payload?: Record<string, unknown>): number | undefined {
  const value = payload?.generation;
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return value;
}

function contentType(filename: string): string {
  if (filename.endsWith(".json")) return json;
  if (filename === "archive.tar.gz") return "application/gzip";
  return "application/octet-stream";
}

async function serve(
  bucket: R2BucketLike,
  key: string,
  filename: string,
  cacheControl: string,
): Promise<Response> {
  const headers = new Headers({ "cache-control": noStore });
  const object = await bucket.get(key);
  if (!object) return problem(404, "Object not found", headers);

  headers.set("cache-control", cacheControl);
  headers.set(
    "content-type",
    filename.startsWith("assets/")
      ? (object.httpMetadata?.contentType ?? contentType(filename))
      : contentType(filename),
  );
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}

type PreparedUpload =
  | {
      ok: true;
      bytes: ArrayBuffer | ReadableStream<Uint8Array>;
      uploadContentType: string;
      currentETag?: string;
      customMetadata?: Record<string, string>;
    }
  | { ok: false; response: Response };

async function prepareExpoManifestUpload(request: Request): Promise<PreparedUpload> {
  const bytes = await request.arrayBuffer();
  const manifest = parseObject(bytes);
  if (
    !manifest ||
    typeof manifest.id !== "string" ||
    !uuid.test(manifest.id) ||
    typeof manifest.runtimeVersion !== "string" ||
    manifest.runtimeVersion.length === 0
  ) {
    return { ok: false, response: problem(400, "Expected a valid Expo Updates v1 manifest JSON") };
  }
  const sig = request.headers.get("expo-signature")?.trim();
  if (sig && /[^\x20-\x7e]/.test(sig)) {
    return { ok: false, response: problem(400, "Invalid expo-signature header") };
  }
  return {
    ok: true,
    bytes,
    uploadContentType: json,
    ...(sig ? { customMetadata: { "expo-signature": sig } } : {}),
  };
}

async function prepareSignedJsonUpload(
  request: Request,
  bucket: R2BucketLike,
  key: string,
  isChannel: boolean,
): Promise<PreparedUpload> {
  const bytes = await request.arrayBuffer();
  const payload = signedPayload(bytes);
  if (!payload) return { ok: false, response: problem(400, "Expected a signed JSON envelope") };

  let currentETag: string | undefined;
  if (isChannel) {
    const next = generation(payload);
    if (next === undefined) {
      return { ok: false, response: problem(400, "Generation must be a positive safe integer") };
    }
    const current = await bucket.get(key);
    if (current) {
      const previous = generation(signedPayload(await current.arrayBuffer()));
      if (previous === undefined || next <= previous) {
        return { ok: false, response: problem(409, "Channel generation must increase") };
      }
      currentETag = current.etag;
    }
  }
  return { ok: true, bytes, uploadContentType: json, currentETag };
}

function prepareBinaryUpload(request: Request, filename: string): PreparedUpload {
  if (!request.body) return { ok: false, response: problem(400, "Missing upload body") };
  let uploadContentType = contentType(filename);
  if (filename.startsWith("assets/")) {
    const headerCt = request.headers.get("content-type")?.trim();
    if (headerCt) uploadContentType = headerCt;
  }
  return { ok: true, bytes: request.body, uploadContentType };
}

async function publish(
  request: Request,
  bucket: R2BucketLike,
  key: string,
  filename?: string,
): Promise<Response> {
  let prepared: PreparedUpload;
  if (filename === "archive.tar.gz" || filename?.startsWith("assets/")) {
    prepared = prepareBinaryUpload(request, filename);
  } else if (filename === "expo-manifest.json") {
    prepared = await prepareExpoManifestUpload(request);
  } else {
    prepared = await prepareSignedJsonUpload(request, bucket, key, filename === undefined);
  }
  if (!prepared.ok) return prepared.response;

  // R2 checks this precondition atomically, including when multiple Workers write at once.
  const onlyIf = new Headers(
    prepared.currentETag === undefined
      ? [["if-none-match", "*"]]
      : [["if-match", `"${prepared.currentETag}"`]],
  );
  const object = await bucket.put(key, prepared.bytes, {
    onlyIf,
    httpMetadata: { contentType: prepared.uploadContentType },
    ...(prepared.customMetadata ? { customMetadata: prepared.customMetadata } : {}),
  });
  if (object) return new Response(null, { status: 201 });

  return problem(409, filename ? "Release object already exists" : "Channel changed during upload");
}

function acceptsMultipart(accept: string | null): boolean {
  if (!accept) return true;
  const types = new Map(
    accept
      .toLowerCase()
      .split(",")
      .map((range) => {
        const [type, ...parameters] = range.trim().split(";");
        const quality = parameters
          .map((parameter) => parameter.trim())
          .find((parameter) => parameter.startsWith("q="));
        return [type?.trim(), quality === undefined ? 1 : Number(quality.slice(2))];
      }),
  );
  return (types.get("multipart/mixed") ?? types.get("multipart/*") ?? types.get("*/*") ?? 0) > 0;
}

function validateExpoUpdateRequest(
  request: Request,
): { ok: true; runtime: string } | { ok: false; response: Response } {
  const runtime = request.headers.get("expo-runtime-version");
  const platform = request.headers.get("expo-platform");
  if (platform !== "ios" || !runtime) {
    return { ok: false, response: problem(400, "Expected iOS and a runtime version", expoHeaders) };
  }
  if (
    request.headers.get("expo-protocol-version") !== "1" ||
    !acceptsMultipart(request.headers.get("accept"))
  ) {
    return {
      ok: false,
      response: problem(406, "Requires Expo Updates v1 with multipart/mixed", expoHeaders),
    };
  }
  return { ok: true, runtime };
}

async function resolveIosOtaReleaseDigest(
  bucket: R2BucketLike,
  channel: string,
  runtime: string,
): Promise<string | null> {
  const channelObject = await bucket.get(`channels/${channel}.json`);
  if (!channelObject) return null;
  const payload = signedPayload(await channelObject.arrayBuffer());
  const surfaces = payload?.surfaces;
  const pointer = record(surfaces) ? surfaces["ios-ota"] : undefined;
  if (
    !record(pointer) ||
    pointer.runtimeVersion !== runtime ||
    typeof pointer.releaseDigest !== "string" ||
    !digest.test(pointer.releaseDigest)
  ) {
    return null;
  }
  return pointer.releaseDigest;
}

async function expoUpdate(
  request: Request,
  bucket: R2BucketLike,
  channel: string,
): Promise<Response> {
  const validated = validateExpoUpdateRequest(request);
  if (!validated.ok) return validated.response;
  const { runtime } = validated;

  const noUpdate = () => new Response(null, { status: 204, headers: expoHeaders });
  const releaseDigest = await resolveIosOtaReleaseDigest(bucket, channel, runtime);
  if (!releaseDigest) return noUpdate();

  const object = await bucket.get(`releases/ios-ota/${releaseDigest}/expo-manifest.json`);
  if (!object) return noUpdate();

  const bytes = await object.arrayBuffer();
  const manifest = parseObject(bytes);
  if (!manifest || typeof manifest.id !== "string" || !uuid.test(manifest.id)) {
    return problem(502, "Invalid stored Expo manifest", expoHeaders);
  }
  if (
    manifest.runtimeVersion !== runtime ||
    manifest.id.toLowerCase() === request.headers.get("expo-current-update-id")?.toLowerCase()
  ) {
    return noUpdate();
  }

  const signature = object.customMetadata?.["expo-signature"];
  if (
    (signature && /[^\x20-\x7e]/.test(signature)) ||
    (!signature && request.headers.has("expo-expect-signature"))
  ) {
    return problem(502, "Missing or invalid stored Expo signature", expoHeaders);
  }

  const boundary = crypto.randomUUID();
  const headers = new Headers(expoHeaders);
  headers.set("content-type", `multipart/mixed; boundary=${boundary}`);
  if (signature) headers.set("expo-signature", signature);
  const part = [
    `--${boundary}`,
    'content-disposition: form-data; name="manifest"',
    "content-type: application/json",
  ];
  if (signature) part.push(`expo-signature: ${signature}`);
  // The signature covers the exact uploaded bytes, including JSON whitespace.
  return new Response(
    new Blob([part.join("\r\n") + "\r\n\r\n", bytes, `\r\n--${boundary}--\r\n`]),
    {
      headers,
    },
  );
}

type ParsedRoute =
  | { kind: "error"; response: Response }
  | { kind: "health" }
  | { kind: "channel"; key: string }
  | { kind: "release"; key: string; filename: string }
  | { kind: "expo"; channel: string }
  | { kind: "not-found" };

function parseRoute(pathname: string, method: string): ParsedRoute {
  if (/[^/a-zA-Z0-9_.-]|(?:^|\/)\.{1,2}(?:\/|$)|\/\//.test(pathname)) {
    return { kind: "error", response: problem(400, "Invalid path") };
  }
  if (pathname === "/health" && method === "GET") return { kind: "health" };

  const key = pathname.slice(1);
  if (pathname === "/releases" || pathname.startsWith("/releases/")) {
    const release = releasePath.exec(pathname);
    const filename = release?.[2];
    if (!filename || (filename === "expo-manifest.json" && release[1] !== "ios-ota")) {
      return { kind: "error", response: problem(400, "Invalid release path") };
    }
    return { kind: "release", key, filename };
  }
  if (pathname === "/channels" || pathname.startsWith("/channels/")) {
    if (!channelPath.test(pathname)) {
      return { kind: "error", response: problem(400, "Invalid channel path") };
    }
    return { kind: "channel", key };
  }
  if (pathname === "/expo-updates" || pathname.startsWith("/expo-updates/")) {
    const expo = expoPath.exec(pathname)?.[1];
    if (!expo) {
      return { kind: "error", response: problem(400, "Invalid Expo channel path") };
    }
    return { kind: "expo", channel: expo };
  }
  return { kind: "not-found" };
}

export default {
  async fetch(request: Request, { ARTIFACTS, UPLOAD_TOKEN, READ_TOKEN }: Env): Promise<Response> {
    const route = parseRoute(new URL(request.url).pathname, request.method);
    if (route.kind === "error") return route.response;
    if (route.kind === "health") return Response.json({ ok: true });

    if (request.method === "PUT" && (route.kind === "channel" || route.kind === "release")) {
      if (!(await authorized(request, UPLOAD_TOKEN))) return problem(401, "Unauthorized");
      return publish(
        request,
        ARTIFACTS,
        route.key,
        route.kind === "release" ? route.filename : undefined,
      );
    }
    if (request.method === "GET") {
      if (route.kind === "channel") {
        if (READ_TOKEN && !(await authorized(request, READ_TOKEN))) {
          return problem(401, "Unauthorized", { "cache-control": noStore });
        }
        return serve(ARTIFACTS, route.key, "channel.json", noStore);
      }
      if (route.kind === "release") return serve(ARTIFACTS, route.key, route.filename, immutable);
      if (route.kind === "expo") return expoUpdate(request, ARTIFACTS, route.channel);
    }
    return problem(404, "Route not found");
  },
};
