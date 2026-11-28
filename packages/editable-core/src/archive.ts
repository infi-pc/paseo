import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { canonicalJson, sha256Hex, verifySignedEnvelope } from "./crypto.js";
import type { ReleaseFileEntry, ReleaseManifestPayload } from "./schema.js";
import {
  DAEMON_ENTRYPOINT_REL_PATH,
  isSafeRelativePath,
  validateReleaseManifestPayload,
  type ReleaseSurface,
  type SignedEnvelope,
} from "./types.js";

const execFileAsync = promisify(execFile);
const TAR_MAX_BUFFER = 32 * 1024 * 1024;

const MAX_RELEASE_FILES = 10_000;
const MAX_SINGLE_FILE_BYTES = 32 * 1024 * 1024;
const MAX_TOTAL_BYTES = 128 * 1024 * 1024;

function compareLexicographically(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

export async function collectDirectoryFiles(rootDir: string): Promise<ReleaseFileEntry[]> {
  const entries: ReleaseFileEntry[] = [];
  let totalBytes = 0;

  async function walk(currentDir: string, relPrefix: string): Promise<void> {
    const dirEntries = await fs.readdir(currentDir, { withFileTypes: true });
    dirEntries.sort((a, b) => compareLexicographically(a.name, b.name));

    for (const entry of dirEntries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      if (!isSafeRelativePath(relPath)) {
        throw new Error(`Unsafe relative path in release directory: ${relPath}`);
      }
      const stat = await fs.lstat(fullPath);
      if (stat.isSymbolicLink()) {
        throw new Error(`Symlinks are forbidden in release artifacts: ${relPath}`);
      }
      if (stat.isDirectory()) {
        await walk(fullPath, relPath);
      } else if (stat.isFile()) {
        if (entries.length >= MAX_RELEASE_FILES) {
          throw new Error(`Release exceeds maximum file count (${MAX_RELEASE_FILES})`);
        }
        if (stat.size > MAX_SINGLE_FILE_BYTES) {
          throw new Error(`File exceeds max size (${MAX_SINGLE_FILE_BYTES} bytes): ${relPath}`);
        }
        totalBytes += stat.size;
        if (totalBytes > MAX_TOTAL_BYTES) {
          throw new Error(`Release exceeds max total bytes (${MAX_TOTAL_BYTES})`);
        }
        const bytes = await fs.readFile(fullPath);
        entries.push({
          path: relPath,
          sha256: sha256Hex(bytes),
          bytes: bytes.byteLength,
        });
      } else {
        throw new Error(`Unsupported special file in release directory: ${relPath}`);
      }
    }
  }

  await walk(rootDir, "");
  entries.sort((a, b) => compareLexicographically(a.path, b.path));
  return entries;
}

export function computeReleaseDigest(input: {
  surface: ReleaseSurface;
  sourceSha: string;
  runtimeVersion: string;
  files: ReleaseFileEntry[];
}): string {
  return sha256Hex(
    canonicalJson({
      surface: input.surface,
      sourceSha: input.sourceSha,
      runtimeVersion: input.runtimeVersion,
      files: input.files,
    }),
  );
}

export async function packReleaseArchive(options: {
  sourceDir: string;
  outputArchivePath: string;
  surface: ReleaseSurface;
  sourceSha: string;
  runtimeVersion: string;
  summary: string;
  createdAt?: string;
}): Promise<ReleaseManifestPayload> {
  const files = await collectDirectoryFiles(options.sourceDir);
  if (options.surface === "electron-web" && !files.some((f) => f.path === "index.html")) {
    throw new Error("electron-web release directory is missing required index.html");
  }
  if (options.surface === "daemon" && !files.some((f) => f.path === DAEMON_ENTRYPOINT_REL_PATH)) {
    throw new Error(`daemon release directory is missing required ${DAEMON_ENTRYPOINT_REL_PATH}`);
  }

  await fs.mkdir(path.dirname(options.outputArchivePath), { recursive: true });
  const listDir = await fs.mkdtemp(path.join(os.tmpdir(), "ed-tar-list-"));
  try {
    const fileListPath = path.join(listDir, "files.txt");
    await fs.writeFile(fileListPath, `${files.map((f) => f.path).join("\n")}\n`, "utf8");
    const env: NodeJS.ProcessEnv = { ...process.env, COPYFILE_DISABLE: "1" };
    delete env.TAR_OPTIONS;
    await execFileAsync(
      "tar",
      ["-czf", options.outputArchivePath, "-C", options.sourceDir, "-T", fileListPath],
      { env, maxBuffer: TAR_MAX_BUFFER },
    );
  } finally {
    await fs.rm(listDir, { recursive: true, force: true });
  }

  const archiveBytes = await fs.readFile(options.outputArchivePath);
  const archiveSha256 = sha256Hex(archiveBytes);
  const releaseDigest = computeReleaseDigest({
    surface: options.surface,
    sourceSha: options.sourceSha,
    runtimeVersion: options.runtimeVersion,
    files,
  });

  const payload: ReleaseManifestPayload = {
    schemaVersion: 1,
    kind: "release",
    surface: options.surface,
    releaseDigest,
    sourceSha: options.sourceSha,
    runtimeVersion: options.runtimeVersion,
    archiveSha256,
    archiveBytes: archiveBytes.byteLength,
    files,
    summary: options.summary.slice(0, 200),
    createdAt: options.createdAt ?? new Date().toISOString(),
  };

  const validation = validateReleaseManifestPayload(payload);
  if (!validation.ok) {
    throw new Error(`Constructed invalid release manifest: ${validation.error}`);
  }
  return payload;
}

/**
 * Inspects a tar.gz archive before extraction, rejecting any path traversal,
 * leading slashes, symlinks, hardlinks, or unexpected file entries.
 */
async function validateArchiveEntriesBeforeExtract(
  archivePath: string,
  expectedPaths: Set<string>,
): Promise<void> {
  const { stdout } = await execFileAsync("tar", ["-tzvf", archivePath], {
    maxBuffer: TAR_MAX_BUFFER,
  });
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (const line of lines) {
    const modeChar = line[0];
    if (modeChar !== "-" && modeChar !== "d") {
      throw new Error(`Archive contains forbidden non-regular entry: ${line}`);
    }
    // Extract path field: standard `tar -tvf` has 8 whitespace-separated columns before path (macOS bsdtar / GNU tar)
    // Use `tar -tzf` separately for exact filenames without whitespace ambiguity.
  }

  const { stdout: namesOut } = await execFileAsync("tar", ["-tzf", archivePath], {
    maxBuffer: TAR_MAX_BUFFER,
  });
  const names = namesOut
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  for (const rawName of names) {
    const normalized = rawName.replace(/^\.\//, "").replace(/\/$/, "");
    if (!normalized) continue;
    if (!isSafeRelativePath(normalized)) {
      throw new Error(`Archive contains unsafe path: ${rawName}`);
    }
    if (!rawName.endsWith("/") && !expectedPaths.has(normalized)) {
      throw new Error(`Archive contains undeclared file not in signed manifest: ${normalized}`);
    }
  }
}

export async function verifyAndExtractReleaseArchive(options: {
  archivePath: string;
  signedManifest: SignedEnvelope<ReleaseManifestPayload>;
  publicKeyPem: string;
  expectedSurface: ReleaseSurface;
  expectedRuntimeVersion: string;
  targetDir: string;
}): Promise<ReleaseManifestPayload> {
  const sigResult = verifySignedEnvelope<ReleaseManifestPayload>(
    options.signedManifest,
    options.publicKeyPem,
  );
  if (!sigResult.ok) {
    throw new Error(`Release manifest signature invalid: ${sigResult.error}`);
  }
  const validPayload = validateReleaseManifestPayload(sigResult.payload);
  if (!validPayload.ok) {
    throw new Error(`Release manifest invalid: ${validPayload.error}`);
  }
  const manifest = validPayload.value;

  if (manifest.surface !== options.expectedSurface) {
    throw new Error(
      `Release surface mismatch: expected ${options.expectedSurface}, got ${manifest.surface}`,
    );
  }
  if (manifest.runtimeVersion !== options.expectedRuntimeVersion) {
    throw new Error(
      `Runtime version mismatch: expected ${options.expectedRuntimeVersion}, got ${manifest.runtimeVersion}`,
    );
  }
  const expectedDigest = computeReleaseDigest({
    surface: manifest.surface,
    sourceSha: manifest.sourceSha,
    runtimeVersion: manifest.runtimeVersion,
    files: manifest.files,
  });
  if (manifest.releaseDigest !== expectedDigest) {
    throw new Error("Release digest does not match manifest file table");
  }

  const archiveBuf = await fs.readFile(options.archivePath);
  if (
    archiveBuf.byteLength !== manifest.archiveBytes ||
    sha256Hex(archiveBuf) !== manifest.archiveSha256
  ) {
    throw new Error("Archive bytes/SHA-256 mismatch against signed manifest");
  }

  const expectedPaths = new Set(manifest.files.map((f) => f.path));
  await validateArchiveEntriesBeforeExtract(options.archivePath, expectedPaths);

  const parentDir = path.dirname(options.targetDir);
  await fs.mkdir(parentDir, { recursive: true });
  const stagingDir = await fs.mkdtemp(path.join(parentDir, ".stage-"));
  try {
    await execFileAsync("tar", ["-xzf", options.archivePath, "-C", stagingDir], {
      maxBuffer: TAR_MAX_BUFFER,
    });
    await verifyExtractedDirectory(stagingDir, manifest);
    await fs.writeFile(
      path.join(stagingDir, "manifest.json"),
      `${JSON.stringify(options.signedManifest, null, 2)}\n`,
      "utf8",
    );
    await fs.rm(options.targetDir, { recursive: true, force: true });
    await fs.rename(stagingDir, options.targetDir);
    return manifest;
  } catch (err) {
    await fs.rm(stagingDir, { recursive: true, force: true });
    throw err;
  }
}

export async function verifyExtractedDirectory(
  dir: string,
  manifest: ReleaseManifestPayload,
): Promise<void> {
  const actualFiles = await collectDirectoryFiles(dir);
  const filteredActual = actualFiles.filter((f) => f.path !== "manifest.json");
  if (filteredActual.length !== manifest.files.length) {
    throw new Error(
      `Extracted file count mismatch: expected ${manifest.files.length}, got ${filteredActual.length}`,
    );
  }
  for (let i = 0; i < manifest.files.length; i++) {
    const expected = manifest.files[i]!;
    const actual = filteredActual[i]!;
    if (
      actual.path !== expected.path ||
      actual.sha256 !== expected.sha256 ||
      actual.bytes !== expected.bytes
    ) {
      throw new Error(`Extracted file mismatch at ${expected.path}`);
    }
  }
}
