import assert from "node:assert/strict";

const sha256 = /^[a-f0-9]{64}$/;

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === "object" && !Array.isArray(value), "Expected manifest object");
  return value as Record<string, unknown>;
}

function stringMatching(value: unknown, pattern: RegExp, label: string): string {
  assert(typeof value === "string" && pattern.test(value), `Invalid manifest ${label}`);
  return value;
}

function bytes(value: unknown): number {
  assert(
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0,
    "Invalid byte count",
  );
  return value;
}

export function parseReleaseManifest(payload: unknown) {
  const manifest = record(payload);
  assert.equal(manifest.schemaVersion, 1, "Unsupported release schema");
  assert.equal(manifest.kind, "release", "Unexpected manifest kind");
  assert.equal(manifest.surface, "electron-web", "Unexpected release surface");
  const releaseDigest = stringMatching(manifest.releaseDigest, sha256, "release digest");
  stringMatching(manifest.sourceSha, /^[a-f0-9]{40}$/, "source SHA");
  stringMatching(manifest.archiveSha256, sha256, "archive SHA");
  bytes(manifest.archiveBytes);
  assert(typeof manifest.runtimeVersion === "string", "Missing runtime version");
  assert(
    typeof manifest.summary === "string" && manifest.summary.length <= 200,
    "Invalid release summary",
  );
  assert(
    typeof manifest.createdAt === "string" &&
      /^\d{4}-\d{2}-\d{2}T/.test(manifest.createdAt) &&
      Number.isFinite(Date.parse(manifest.createdAt)),
    "Invalid release timestamp",
  );
  assert(Array.isArray(manifest.files), "Missing release file list");

  const files = manifest.files.map((value: unknown) => {
    const entry = record(value);
    assert(typeof entry.path === "string", "Invalid file path");
    return {
      path: entry.path,
      sha256: stringMatching(entry.sha256, sha256, "file SHA"),
      bytes: bytes(entry.bytes),
    };
  });
  return { releaseDigest, runtimeVersion: manifest.runtimeVersion, files };
}
