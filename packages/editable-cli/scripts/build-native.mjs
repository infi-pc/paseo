#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

if (process.platform !== "darwin") {
  process.exit(0);
}

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, "..");
const src = path.join(pkgRoot, "native", "clonefile.c");
const outDir = path.join(pkgRoot, "dist", "bin");
const out = path.join(outDir, "clonefile-darwin");

if (!fs.existsSync(src)) {
  process.exit(0);
}

fs.mkdirSync(outDir, { recursive: true });
try {
  execFileSync("cc", ["-O2", "-Wall", "-Wextra", src, "-o", out], { stdio: "inherit" });
  fs.chmodSync(out, 0o755);
} catch (err) {
  // Gracefully allow fallback to `cp -cRP` if Command Line Tools are not installed.
  console.warn(
    `[editable-paseo] Skipping native clonefile-darwin build (will fall back to cp -cRP): ${
      err instanceof Error ? err.message : String(err)
    }`,
  );
}
