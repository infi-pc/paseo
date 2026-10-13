import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import type { AgentTimelineItem } from "../agent-sdk-types.js";

const execute = promisify(execFile);
const MAX_FILES = 10000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_DIFF = 128 * 1024;

interface Snapshot {
  files: Map<string, Buffer>;
  excluded: Set<string>;
  omitted: number;
  startedAt: string;
  completedAt: string;
  error?: string;
}

async function capture(cwd: string): Promise<Snapshot> {
  const snapshot: Snapshot = {
    files: new Map(),
    excluded: new Set(),
    omitted: 0,
    startedAt: new Date().toISOString(),
    completedAt: "",
  };
  try {
    const { stdout } = await execute(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "."],
      { cwd, timeout: 5000, maxBuffer: 2 * 1024 * 1024 },
    );
    const files = [...new Set(stdout.split("\0").filter(Boolean))].sort();
    const root = await fs.realpath(cwd);
    snapshot.omitted = Math.max(0, files.length - MAX_FILES);
    snapshot.excluded = new Set(files.slice(MAX_FILES));
    let bytes = 0;
    for (const name of files.slice(0, MAX_FILES)) {
      if (bytes >= MAX_BYTES) {
        snapshot.omitted += 1;
        snapshot.excluded.add(name);
        continue;
      }
      const content = await readSnapshotFile(root, name, MAX_BYTES - bytes);
      if (content === undefined) continue;
      if (content === null) {
        snapshot.omitted += 1;
        snapshot.excluded.add(name);
        continue;
      }
      bytes += content.length;
      snapshot.files.set(name, content);
    }
  } catch (error) {
    snapshot.error = error instanceof Error ? error.message : String(error);
  }
  snapshot.completedAt = new Date().toISOString();
  return snapshot;
}

async function readSnapshotFile(
  root: string,
  name: string,
  remaining: number,
): Promise<Buffer | null | undefined> {
  const parts = name.split(/[\\/]/);
  if (
    parts.includes("..") ||
    path.isAbsolute(name) ||
    parts.some((part) => part === ".env" || part === ".git")
  )
    return null;
  const target = path.join(root, name);
  try {
    const before = await fs.lstat(target);
    if (!before.isFile() || before.size > Math.min(MAX_FILE_BYTES, remaining)) return null;
    const real = await fs.realpath(target);
    if (!real.startsWith(`${root}${path.sep}`)) return null;
    const handle = await fs.open(target, "r");
    const content = Buffer.alloc(before.size);
    try {
      const read = await handle.read(content, 0, content.length, 0);
      if (read.bytesRead !== before.size) return null;
    } finally {
      await handle.close();
    }
    const after = await fs.lstat(target);
    const changedDuringRead =
      before.mtimeMs !== after.mtimeMs || before.size !== after.size || before.ino !== after.ino;
    if (
      changedDuringRead ||
      content.includes(0) ||
      content.length > Math.min(MAX_FILE_BYTES, remaining)
    )
      return null;
    return content;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    if (error instanceof Error && "code" in error && error.code === "EACCES") return null;
    throw error;
  }
}

async function writeSnapshot(directory: string, snapshot: Snapshot): Promise<void> {
  await fs.mkdir(directory);
  for (const [name, content] of snapshot.files) {
    const target = path.join(directory, name);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

async function compare(before: Snapshot, after: Snapshot): Promise<string> {
  for (const name of before.excluded) after.files.delete(name);
  for (const name of after.excluded) before.files.delete(name);
  for (const [name, content] of before.files) {
    const current = after.files.get(name);
    if (current && content.equals(current)) {
      before.files.delete(name);
      after.files.delete(name);
    }
  }
  if (before.files.size === 0 && after.files.size === 0) return "";
  const directory = await fs.mkdtemp(path.join(tmpdir(), "paseo-turn-"));
  try {
    await writeSnapshot(path.join(directory, "before"), before);
    await writeSnapshot(path.join(directory, "after"), after);
    try {
      const result = await execute(
        "git",
        ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--", "before", "after"],
        { cwd: directory, maxBuffer: MAX_DIFF, timeout: 5000 },
      );
      return result.stdout;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === 1 &&
        "stdout" in error &&
        typeof error.stdout === "string"
      )
        return error.stdout;
      throw error;
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

/** Captures interval changes without touching the workspace's Git index or commits. */
export class TurnChanges {
  private readonly pending = new Map<string, Snapshot>();

  async begin(agentId: string, cwd: string): Promise<void> {
    this.pending.set(agentId, await capture(cwd));
  }

  discard(agentId: string): void {
    this.pending.delete(agentId);
  }

  async finish(agentId: string, cwd: string): Promise<AgentTimelineItem | null> {
    const before = this.pending.get(agentId);
    this.pending.delete(agentId);
    if (!before) return null;
    const after = await capture(cwd);
    let diff: string | undefined;
    let error = before.error ?? after.error;
    if (!error) {
      try {
        diff = await compare(before, after);
      } catch (failure) {
        error = failure instanceof Error ? failure.message : String(failure);
      }
    }
    const omitted = before.omitted + after.omitted;
    const partial = omitted > 0 || error !== undefined;
    const summary = error ? "Turn changes unavailable" : "Changes during this turn";
    const id = randomUUID();
    return {
      type: "notification",
      level: error ? "warning" : "info",
      message: summary,
      activity: {
        id,
        provider: "Paseo",
        omitted: 0,
        records: [
          {
            id,
            event: "paseo/turn/changes",
            timestamp: after.completedAt,
            summary,
            level: partial ? "warning" : "info",
            truncated: partial,
            diff,
            payload: JSON.stringify(
              {
                before: { startedAt: before.startedAt, completedAt: before.completedAt },
                after: { startedAt: after.startedAt, completedAt: after.completedAt },
                omitted,
                error,
                scope:
                  "Git tracked and non-ignored untracked text files; excludes .env, symlinks and binary files. At most 10000 files, 1 MiB per file, 64 MiB per snapshot. Includes concurrent workspace edits. Captures are not atomic.",
              },
              null,
              2,
            ),
          },
        ],
      },
    };
  }
}
