import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { app } from "electron";
import {
  createNodeEntrypointInvocation as createSharedNodeEntrypointInvocation,
  type NodeEntrypointArgvMode,
  type NodeEntrypointInvocation,
  type NodeEntrypointSpec,
} from "./node-entrypoint-launcher.js";
import {
  assertPathExists,
  findPackageRootFromResolvedPath,
  resolvePackagedAsarPath,
  type PackageInfo,
} from "./package-paths.js";

const SERVER_PACKAGE_NAME = "@getpaseo/server";

const esmRequire = createRequire(__filename);

function resolveServerPackageInfo(): PackageInfo {
  const serverExportPath = esmRequire.resolve(SERVER_PACKAGE_NAME);
  return findPackageRootFromResolvedPath({
    resolvedPath: serverExportPath,
    packageName: SERVER_PACKAGE_NAME,
  });
}

export function resolvePackagedNodeEntrypointRunnerPath(): string {
  return path.join(
    process.resourcesPath,
    "app.asar.unpacked",
    "dist",
    "daemon",
    "node-entrypoint-runner.js",
  );
}

export function resolveDaemonReleaseLoaderPath(): string {
  if (app.isPackaged) {
    return assertPathExists({
      label: "Bundled daemon release loader",
      filePath: path.join(
        process.resourcesPath,
        "app.asar.unpacked",
        "dist",
        "daemon",
        "daemon-release-loader.mjs",
      ),
    });
  }
  return assertPathExists({
    label: "Daemon release loader",
    filePath: path.join(__dirname, "daemon-release-loader.mjs"),
  });
}

export function resolveDaemonReleaseFallbackRoot(): string {
  if (app.isPackaged) {
    return resolvePackagedAsarPath();
  }
  const serverPackage = resolveServerPackageInfo();
  return path.resolve(serverPackage.root, "..", "..");
}

export interface EditableDaemonLaunchOverride {
  releaseDir: string;
  entryPath: string;
  digest: string;
  channel: string;
}

export function buildEditableDaemonEnv(
  baseEnv: NodeJS.ProcessEnv,
  override: EditableDaemonLaunchOverride,
  fallbackRoot = resolveDaemonReleaseFallbackRoot(),
): NodeJS.ProcessEnv {
  const existingOptions = (baseEnv.NODE_OPTIONS ?? "")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !token.includes("daemon-release-loader.mjs"));
  return {
    ...baseEnv,
    NODE_OPTIONS: existingOptions.join(" "),
    PASEO_EDITABLE_DAEMON_DIR: override.releaseDir,
    PASEO_EDITABLE_FALLBACK_ROOT: fallbackRoot,
    PASEO_EDITABLE_DAEMON_DIGEST: override.digest,
  };
}

export function resolveDaemonRunnerEntrypoint(): NodeEntrypointSpec {
  if (app.isPackaged) {
    return {
      entryPath: assertPathExists({
        label: "Bundled daemon runner",
        filePath: path.join(
          resolvePackagedAsarPath(),
          "node_modules",
          "@getpaseo",
          "server",
          "dist",
          "scripts",
          "supervisor-entrypoint.js",
        ),
      }),
      execArgv: [],
    };
  }

  const serverPackage = resolveServerPackageInfo();
  const distRunner = path.join(serverPackage.root, "dist", "scripts", "supervisor-entrypoint.js");
  if (existsSync(distRunner)) {
    return {
      entryPath: distRunner,
      execArgv: [],
    };
  }

  return {
    entryPath: assertPathExists({
      label: "Daemon runner source",
      filePath: path.join(serverPackage.root, "scripts", "supervisor-entrypoint.ts"),
    }),
    execArgv: ["--import", "tsx"],
  };
}

export function resolveNodeExecPath(): string {
  if (app.isPackaged && process.platform === "darwin") {
    const marker = ".app/Contents/MacOS/";
    const markerIndex = process.execPath.indexOf(marker);
    if (markerIndex !== -1) {
      const bundleRoot = process.execPath.substring(0, markerIndex + ".app".length);
      const name = path.basename(process.execPath);
      const helperPath = path.posix.join(
        bundleRoot,
        "Contents",
        "Frameworks",
        `${name} Helper.app`,
        "Contents",
        "MacOS",
        `${name} Helper`,
      );
      if (existsSync(helperPath)) {
        return helperPath;
      }
    }
  }
  return process.execPath;
}

export function createNodeEntrypointInvocation(input: {
  entrypoint: NodeEntrypointSpec;
  argvMode: NodeEntrypointArgvMode;
  args: string[];
  baseEnv: NodeJS.ProcessEnv;
  editableDaemon?: boolean;
}): NodeEntrypointInvocation {
  return createSharedNodeEntrypointInvocation({
    execPath: resolveNodeExecPath(),
    isPackaged: app.isPackaged,
    packagedRunnerPath: app.isPackaged
      ? assertPathExists({
          label: "Bundled node entrypoint runner",
          filePath: resolvePackagedNodeEntrypointRunnerPath(),
        })
      : null,
    nodeArgs: input.editableDaemon
      ? [`--import=${pathToFileURL(resolveDaemonReleaseLoaderPath()).href}`]
      : undefined,
    entrypoint: input.entrypoint,
    argvMode: input.argvMode,
    args: input.args,
    baseEnv: input.baseEnv,
  });
}
