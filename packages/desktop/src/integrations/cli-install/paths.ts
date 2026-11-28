import path from "node:path";
import { createRequire } from "node:module";
import { resolveCliShimPath } from "./path.js";
import os from "node:os";
import { app } from "electron";

export function getLocalBinDir(): string {
  return path.join(os.homedir(), ".local", "bin");
}

export function getCliTargetPath(): string {
  const filename = process.platform === "win32" ? "paseo.cmd" : "paseo";
  return path.join(getLocalBinDir(), filename);
}

// FORK(editable): maintain ~/.local/bin/paseo-ed alongside ~/.local/bin/paseo on POSIX.
export function getEditableCliTargetPath(): string {
  return path.join(getLocalBinDir(), "paseo-ed");
}

export function getBundledCliShimPath(): string {
  return resolveCliShimPath({
    platform: process.platform,
    isPackaged: app.isPackaged,
    executablePath: app.getPath("exe"),
    resolveWorkspaceCli: () => createRequire(__filename).resolve("@getpaseo/cli/bin/paseo"),
  });
}

export function getBundledEditableCliShimPath(): string | null {
  try {
    return resolveCliShimPath({
      platform: process.platform,
      isPackaged: app.isPackaged,
      executablePath: app.getPath("exe"),
      binaryName: "paseo-ed",
      resolveWorkspaceCli: () =>
        createRequire(__filename).resolve("@getpaseo/editable-cli/dist/index.js"),
    });
  } catch {
    return null;
  }
}
