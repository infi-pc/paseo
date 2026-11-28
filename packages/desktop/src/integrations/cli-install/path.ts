import path from "node:path";

export function resolveCliInstallSourcePath(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  executablePath: string;
  shimPath: string;
  appImagePath?: string | null;
}): string {
  if (input.platform === "win32") {
    return input.shimPath;
  }

  if (!input.isPackaged) {
    return input.shimPath;
  }

  if (input.platform === "darwin") {
    return input.shimPath;
  }

  if (input.platform === "linux") {
    const appImagePath = input.appImagePath?.trim();
    if (appImagePath) {
      return appImagePath;
    }
    return input.shimPath;
  }

  return input.executablePath;
}

// FORK(editable): AppImage mounts are ephemeral and Paseo.AppImage dispatches `paseo`, not `paseo-ed`.
export function resolveEditableCliInstallSourcePath(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  shimPath: string;
  appImagePath?: string | null;
}): string | null {
  if (input.platform === "win32") {
    return null;
  }
  if (input.platform === "linux" && input.isPackaged && input.appImagePath?.trim()) {
    return null;
  }
  return input.shimPath;
}

export function resolveCliShimPath(input: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  executablePath: string;
  resolveWorkspaceCli: () => string;
  binaryName?: "paseo" | "paseo-ed";
}): string {
  if (!input.isPackaged) return input.resolveWorkspaceCli();

  const binaryName = input.binaryName ?? "paseo";
  const filename = input.platform === "win32" && binaryName === "paseo" ? "paseo.cmd" : binaryName;
  if (input.platform === "darwin") {
    const bundle = input.executablePath.replace(/\/Contents\/MacOS\/.+$/, "");
    return path.join(bundle, "Contents", "Resources", "bin", filename);
  }
  return path.join(path.dirname(input.executablePath), "resources", "bin", filename);
}
