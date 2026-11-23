import { createHash, createPublicKey, verify } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";
import { parseReleaseManifest } from "./release-manifest.js";

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(",")}}`;
  }
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Expected a JSON value");
  return serialized;
}

export function computeKeyId(publicKeyPem: string): string {
  const der = createPublicKey(publicKeyPem).export({ type: "spki", format: "der" });
  return createHash("sha256").update(der).digest("hex").slice(0, 16);
}

export function verifySignedEnvelope(
  envelope: unknown,
  publicKeyPem: string,
): envelope is { payload: unknown; keyId: string; signature: string } {
  if (!envelope || typeof envelope !== "object") return false;
  if (!("payload" in envelope) || !("keyId" in envelope) || !("signature" in envelope)) {
    return false;
  }
  if (typeof envelope.signature !== "string" || !/^[A-Za-z0-9+/]{86}==$/.test(envelope.signature)) {
    return false;
  }
  try {
    const key = createPublicKey(publicKeyPem);
    return (
      key.asymmetricKeyType === "ed25519" &&
      envelope.keyId === computeKeyId(publicKeyPem) &&
      verify(
        null,
        Buffer.from(canonicalJson(envelope.payload)),
        key,
        Buffer.from(envelope.signature, "base64"),
      )
    );
  } catch {
    return false;
  }
}

export function isSafeRelativePath(value: string): boolean {
  return (
    !/[\\:\p{Cc}]/u.test(value) &&
    value.split("/").every((part) => part !== "" && !/[. ]$/.test(part))
  );
}

/** Every path component under root must be a real directory or regular file. */
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
) {
  if (!verifySignedEnvelope(signedManifest, publicKeyPem)) {
    throw new Error("Invalid release signature");
  }
  const manifest = parseReleaseManifest(signedManifest.payload);
  if (manifest.runtimeVersion !== expectedRuntimeVersion)
    throw new Error("Desktop runtime mismatch");

  let previousPath = "";
  let hasIndex = false;
  for (const entry of manifest.files) {
    if (entry.path <= previousPath) throw new Error("Release files must be strictly sorted");
    previousPath = entry.path;
    const filePath = resolveRegularFile(releaseDir, entry.path);
    if (!filePath) throw new Error(`Invalid or missing release file: ${entry.path}`);
    const content = readFileSync(filePath);
    if (
      content.length !== entry.bytes ||
      createHash("sha256").update(content).digest("hex") !== entry.sha256
    ) {
      throw new Error(`Release file integrity check failed: ${entry.path}`);
    }
    if (entry.path === "index.html") hasIndex = true;
  }
  if (!hasIndex) throw new Error("Release manifest is missing index.html");
  return manifest;
}
