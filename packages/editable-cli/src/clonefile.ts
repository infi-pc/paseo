import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CowCloneMethod = "clonefile" | "cp-cow" | "cp";

let cachedHelperPath: string | null | undefined;

async function resolveDarwinClonefileHelper(): Promise<string | null> {
  if (cachedHelperPath !== undefined) return cachedHelperPath;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const asarSegment = `${path.sep}app.asar${path.sep}`;
  const unpackedHere = here.includes(asarSegment)
    ? here.replace(asarSegment, `${path.sep}app.asar.unpacked${path.sep}`)
    : null;
  const candidates = [
    ...(unpackedHere
      ? [
          path.join(unpackedHere, "bin", "clonefile-darwin"),
          path.resolve(unpackedHere, "..", "dist", "bin", "clonefile-darwin"),
        ]
      : []),
    path.join(here, "bin", "clonefile-darwin"),
    path.resolve(here, "..", "dist", "bin", "clonefile-darwin"),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate, fs.constants.X_OK);
      cachedHelperPath = candidate;
      return candidate;
    } catch {
      // Try next candidate
    }
  }
  cachedHelperPath = null;
  return null;
}

/**
 * Copy-on-write clones a directory or file from `src` to `dst` without following symlinks.
 * On macOS APFS, invokes the kernel `clonefile(2)` syscall directly (~4x faster than `cp -cRP`
 * on large node_modules trees), falling back cleanly to `cp -cRP` / `cp -RP` (or Linux reflink).
 */
export async function cloneDirectoryCow(src: string, dst: string): Promise<CowCloneMethod> {
  await fs.mkdir(path.dirname(dst), { recursive: true });

  if (process.platform === "darwin") {
    const helper = await resolveDarwinClonefileHelper();
    if (helper) {
      try {
        await execFileAsync(helper, [src, dst], { maxBuffer: 4 * 1024 * 1024 });
        return "clonefile";
      } catch {
        // E.g. EXDEV across mount points or non-APFS volume — remove any partial target and fall back.
        await fs.rm(dst, { recursive: true, force: true }).catch(() => undefined);
      }
    }
    try {
      await execFileAsync("cp", ["-cRP", src, dst], { maxBuffer: 16 * 1024 * 1024 });
      return "cp-cow";
    } catch {
      await fs.rm(dst, { recursive: true, force: true }).catch(() => undefined);
      await execFileAsync("cp", ["-RP", src, dst], { maxBuffer: 16 * 1024 * 1024 });
      return "cp";
    }
  }

  await execFileAsync("cp", ["-a", "--reflink=auto", src, dst], { maxBuffer: 16 * 1024 * 1024 });
  return "cp-cow";
}
