import crypto from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import {
  DAEMON_ENTRYPOINT_REL_PATH,
  isSafeRelativePath,
  parseReleaseManifest,
  type EditableReleaseSurface,
  type SignedEnvelope,
} from "./types.js";
import type { ReleaseManifestPayload } from "./schema.js";

const ED25519_SIG_RE = /^[A-Za-z0-9+/]{86}==$/;

/**
 * Deterministic JSON serialization with lexicographically sorted keys.
 * Single canonical implementation shared by CLI signing and Electron verification.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record)
      .filter((k) => record[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("Expected a JSON value");
  }
  return serialized;
}

export function sha256Hex(data: Buffer | string): string {
  return crypto.createHash("sha256").update(data).digest("hex");
}

export function computeKeyId(publicKeyPem: string): string {
  const pubKey = crypto.createPublicKey(publicKeyPem);
  const der = pubKey.export({ type: "spki", format: "der" });
  return sha256Hex(der).slice(0, 16);
}

export function generateSigningKeyPair(): {
  privateKeyPem: string;
  publicKeyPem: string;
  keyId: string;
} {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  return {
    privateKeyPem,
    publicKeyPem,
    keyId: computeKeyId(publicKeyPem),
  };
}

export function signEnvelope<T>(
  payload: T,
  privateKeyPem: string,
  publicKeyPem?: string,
): SignedEnvelope<T> {
  const privKey = crypto.createPrivateKey(privateKeyPem);
  const derivedPubPem =
    publicKeyPem ??
    crypto.createPublicKey(privKey).export({ type: "spki", format: "pem" }).toString();
  const canonical = canonicalJson(payload);
  const signature = crypto.sign(null, Buffer.from(canonical, "utf8"), privKey).toString("base64");
  return {
    payload,
    signature,
    keyId: computeKeyId(derivedPubPem),
  };
}

export function verifySignedEnvelope<T>(
  envelope: unknown,
  publicKeyPem: string,
): { ok: true; payload: T; keyId: string } | { ok: false; error: string } {
  if (!envelope || typeof envelope !== "object") {
    return { ok: false, error: "Signed envelope must be an object" };
  }
  const env = envelope as Record<string, unknown>;
  if (!("payload" in env) || typeof env.signature !== "string" || typeof env.keyId !== "string") {
    return { ok: false, error: "Signed envelope missing payload, signature, or keyId" };
  }
  if (!ED25519_SIG_RE.test(env.signature)) {
    return { ok: false, error: "Malformed Ed25519 base64 signature" };
  }
  let expectedKeyId: string;
  let pubKey: crypto.KeyObject;
  try {
    pubKey = crypto.createPublicKey(publicKeyPem);
    if (pubKey.asymmetricKeyType !== "ed25519") {
      return { ok: false, error: "Public key must be an Ed25519 key" };
    }
    const der = pubKey.export({ type: "spki", format: "der" });
    expectedKeyId = sha256Hex(der).slice(0, 16);
  } catch (err) {
    return {
      ok: false,
      error: `Invalid public key PEM: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (env.keyId !== expectedKeyId) {
    return {
      ok: false,
      error: `Key ID mismatch: envelope has ${env.keyId}, expected ${expectedKeyId}`,
    };
  }
  const canonical = canonicalJson(env.payload);
  const valid = crypto.verify(
    null,
    Buffer.from(canonical, "utf8"),
    pubKey,
    Buffer.from(env.signature, "base64"),
  );
  if (!valid) {
    return { ok: false, error: "Ed25519 signature verification failed" };
  }
  return { ok: true, payload: env.payload as T, keyId: expectedKeyId };
}

export function isSignedEnvelopeValid(
  envelope: unknown,
  publicKeyPem: string,
): envelope is SignedEnvelope<unknown> {
  return verifySignedEnvelope(envelope, publicKeyPem).ok;
}

/** Every path component under root must be a real directory or regular file (no symlinks). */
export function resolveRegularFile(root: string, relative: string): string | null {
  if (!isSafeRelativePath(relative)) return null;
  try {
    if (!lstatSync(root).isDirectory()) return null;
    const segments = relative.split("/");
    let resolved = root;
    for (const [index, segment] of segments.entries()) {
      resolved = path.join(resolved, segment);
      const stats = lstatSync(resolved);
      if (index === segments.length - 1 ? !stats.isFile() : !stats.isDirectory()) return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

export function verifyReleaseDirectory(
  releaseDir: string,
  signedManifest: unknown,
  publicKeyPem: string,
  expectedRuntimeVersion: string,
  expectedSurface: EditableReleaseSurface = "electron-web",
): ReleaseManifestPayload {
  const verified = verifySignedEnvelope(signedManifest, publicKeyPem);
  if (!verified.ok) {
    throw new Error("Invalid release signature");
  }
  const manifest = parseReleaseManifest(verified.payload, expectedSurface);
  if (manifest.runtimeVersion !== expectedRuntimeVersion) {
    throw new Error(
      expectedSurface === "daemon" ? "Daemon runtime mismatch" : "Desktop runtime mismatch",
    );
  }

  const requiredEntrypoint =
    expectedSurface === "daemon" ? DAEMON_ENTRYPOINT_REL_PATH : "index.html";
  let previousPath = "";
  let hasRequiredEntrypoint = false;
  for (const entry of manifest.files) {
    if (entry.path <= previousPath) throw new Error("Release files must be strictly sorted");
    previousPath = entry.path;
    const filePath = resolveRegularFile(releaseDir, entry.path);
    if (!filePath) throw new Error(`Invalid or missing release file: ${entry.path}`);
    const content = readFileSync(filePath);
    if (content.length !== entry.bytes || sha256Hex(content) !== entry.sha256) {
      throw new Error(`Release file integrity check failed: ${entry.path}`);
    }
    if (entry.path === requiredEntrypoint) hasRequiredEntrypoint = true;
  }
  if (!hasRequiredEntrypoint) {
    throw new Error(`Release manifest is missing ${requiredEntrypoint}`);
  }
  return manifest;
}
