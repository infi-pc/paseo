import type { EditableService } from "./schema.js";
import type { ImpactPlan, ImpactSurface } from "./types.js";

const SERVER_DEPENDENCY_FILES = new Set([
  "package.json",
  "package-lock.json",
  "packages/server/package.json",
  "packages/cli/package.json",
  "packages/relay/package.json",
  "packages/protocol/package.json",
  "packages/client/package.json",
  "packages/highlight/package.json",
  "packages/plugin/package.json",
]);

const EDITABLE_DEPENDENCY_FILES = new Set([
  "packages/editable-core/package.json",
  "packages/editable-cli/package.json",
]);

interface ImpactAccumulator {
  surfaceSet: Set<ImpactSurface>;
  buildSteps: Set<string>;
  verifySteps: Set<string>;
  warnings: string[];
}

function isDocFile(file: string): boolean {
  return (
    file.startsWith("docs/") ||
    file.startsWith("public-docs/") ||
    file.startsWith("findings/") ||
    file.endsWith(".md")
  );
}

function isNativeMobileFile(file: string): boolean {
  return (
    file.startsWith("packages/app/ios/") ||
    file.startsWith("packages/app/android/") ||
    file.startsWith("packages/app/modules/") ||
    file.startsWith("packages/app/plugins/") ||
    file.startsWith("packages/app/testflight/") ||
    file === "packages/app/app.config.js" ||
    file === "packages/app/package.json" ||
    file.startsWith("packages/expo-two-way-audio/")
  );
}

function isSharedSdkFile(file: string): boolean {
  return (
    file.startsWith("packages/protocol/") ||
    file.startsWith("packages/client/") ||
    file.startsWith("packages/highlight/") ||
    file.startsWith("packages/plugin/") ||
    file.startsWith("packages/relay/")
  );
}

function isDaemonAssetFile(file: string): boolean {
  return (
    file.startsWith("packages/server/") ||
    file.startsWith("packages/cli/") ||
    file.startsWith("plugins/") ||
    file.startsWith("skills/")
  );
}

function classifyServerDependencyFile(file: string, acc: ImpactAccumulator): void {
  acc.surfaceSet.add("native-desktop");
  acc.surfaceSet.add("daemon-cli");
  if (
    file === "package.json" ||
    file === "package-lock.json" ||
    file.startsWith("packages/protocol/") ||
    file.startsWith("packages/client/") ||
    file.startsWith("packages/highlight/") ||
    file.startsWith("packages/plugin/")
  ) {
    acc.surfaceSet.add("electron-web");
    acc.surfaceSet.add("ios-ota");
    acc.buildSteps.add("build:app-deps");
    acc.verifySteps.add("typecheck:app");
  }
  acc.buildSteps.add("build:server");
  acc.verifySteps.add("typecheck:server");
  acc.warnings.push(
    `Dependency/manifest change (${file}): third-party or native dependency updates require rebuilding Paseo.app before hot-swapping the daemon.`,
  );
}

function classifyEditablePackageFile(file: string, acc: ImpactAccumulator): void {
  acc.surfaceSet.add("editable-cli");
  acc.surfaceSet.add("native-desktop");
  acc.buildSteps.add("build:editable");
  acc.verifySteps.add("typecheck:editable");
  acc.verifySteps.add("test:editable");
  if (file.startsWith("packages/editable-core/") || EDITABLE_DEPENDENCY_FILES.has(file)) {
    acc.buildSteps.add("build:desktop:main");
    acc.verifySteps.add("typecheck:desktop");
    acc.verifySteps.add("test:desktop");
  }
  acc.warnings.push(
    `Editable runtime/CLI change (${file}): rebuild Paseo.app to update the bundled pinned paseo-ed and Desktop recovery kernel.`,
  );
}

function classifySingleFile(file: string, acc: ImpactAccumulator): void {
  if (file.startsWith("infra/cloud-shelf/")) {
    acc.surfaceSet.add("cloud-shelf");
    acc.verifySteps.add("test:cloud-shelf");
    acc.warnings.push(
      `Cloud Shelf Worker change (${file}): deploy separately from infra/cloud-shelf via wrangler deploy.`,
    );
    return;
  }

  if (file.startsWith("packages/editable-core/") || file.startsWith("packages/editable-cli/")) {
    classifyEditablePackageFile(file, acc);
    return;
  }

  if (isNativeMobileFile(file)) {
    acc.surfaceSet.add("native-ios");
    acc.surfaceSet.add("electron-web");
    acc.surfaceSet.add("ios-ota");
    acc.buildSteps.add("build:app-deps");
    acc.verifySteps.add("typecheck:app");
    acc.warnings.push(
      `Native/config change (${file}): iOS requires a fresh TestFlight rebuild before OTA updates apply.`,
    );
    return;
  }

  if (file.startsWith("packages/desktop/")) {
    acc.surfaceSet.add("native-desktop");
    acc.buildSteps.add("build:desktop:main");
    acc.verifySteps.add("typecheck:desktop");
    acc.verifySteps.add("test:desktop");
    acc.warnings.push(
      `Electron main/preload change (${file}): requires restarting/rebuilding Desktop shell and checking DESKTOP_RUNTIME_VERSION.`,
    );
    return;
  }

  if (SERVER_DEPENDENCY_FILES.has(file)) {
    classifyServerDependencyFile(file, acc);
    return;
  }

  if (isSharedSdkFile(file)) {
    acc.surfaceSet.add("daemon-cli");
    acc.surfaceSet.add("electron-web");
    acc.surfaceSet.add("ios-ota");
    acc.buildSteps.add("build:server");
    acc.buildSteps.add("build:app-deps");
    acc.verifySteps.add("typecheck:server");
    acc.verifySteps.add("typecheck:app");
    acc.verifySteps.add("test:protocol-compat");
    acc.warnings.push(
      `Shared package change (${file}): verify bidirectional protocol compatibility and feature gating (server_info.features.*).`,
    );
    return;
  }

  if (isDaemonAssetFile(file)) {
    acc.surfaceSet.add("daemon-cli");
    if (file.startsWith("plugins/")) {
      acc.surfaceSet.add("plugins");
    }
    acc.buildSteps.add("build:server");
    acc.verifySteps.add("typecheck:server");
    acc.verifySteps.add("test:server-isolated");
    return;
  }

  if (file.startsWith("packages/app/")) {
    acc.surfaceSet.add("electron-web");
    acc.surfaceSet.add("ios-ota");
    acc.verifySteps.add("typecheck:app");
    acc.verifySteps.add("lint:touched");
    acc.verifySteps.add("test:app-targeted");
    return;
  }

  acc.surfaceSet.add("daemon-cli");
  acc.surfaceSet.add("electron-web");
  acc.surfaceSet.add("ios-ota");
  acc.buildSteps.add("build:server");
  acc.buildSteps.add("build:app-deps");
  acc.verifySteps.add("typecheck:server");
  acc.verifySteps.add("typecheck:app");
  acc.warnings.push(
    `Root/shared config change (${file}): conservative multi-surface verification applied.`,
  );
}

/**
 * Explicit Paseo monorepo path classifier.
 * Deliberately mirrors `.github/workflows/ci.yml` and `packages/server/package.json`
 * packaging copy inputs (plugins/, skills/, generated protocol files, native dirs)
 * rather than trusting TS import traversal alone.
 */
export function classifyPaseoImpact(rawFiles: readonly string[]): ImpactPlan {
  const changedFiles = Array.from(
    new Set(
      rawFiles
        .map((f) => f.trim().replace(/\\/g, "/").replace(/^\.\//, ""))
        .filter((f) => f.length > 0),
    ),
  ).sort();

  const acc: ImpactAccumulator = {
    surfaceSet: new Set<ImpactSurface>(),
    buildSteps: new Set<string>(),
    verifySteps: new Set<string>(),
    warnings: [],
  };

  let touchedNonDocs = false;
  for (const file of changedFiles) {
    if (isDocFile(file)) continue;
    touchedNonDocs = true;
    classifySingleFile(file, acc);
  }

  if (!touchedNonDocs && changedFiles.length > 0) {
    acc.surfaceSet.add("docs-only");
  }

  const surfaces = Array.from(acc.surfaceSet).sort();
  const services: EditableService[] = [];
  if (acc.surfaceSet.has("electron-web")) services.push("ui");
  if (acc.surfaceSet.has("daemon-cli")) services.push("daemon");
  if (acc.surfaceSet.has("native-desktop")) services.push("desktop");
  if (acc.surfaceSet.has("native-ios")) services.push("ios");

  const requiresNativeRebuild =
    acc.surfaceSet.has("native-desktop") || acc.surfaceSet.has("native-ios");
  const requiresDaemonRelease = acc.surfaceSet.has("daemon-cli");

  return {
    changedFiles,
    surfaces,
    services,
    buildSteps: Array.from(acc.buildSteps),
    verifySteps: Array.from(acc.verifySteps),
    requiresNativeRebuild,
    requiresDaemonRelease,
    canPublishElectronRenderer:
      acc.surfaceSet.has("electron-web") && !acc.surfaceSet.has("native-desktop"),
    canPublishDaemon: acc.surfaceSet.has("daemon-cli") && !acc.surfaceSet.has("native-desktop"),
    canPublishIosOta: acc.surfaceSet.has("ios-ota") && !acc.surfaceSet.has("native-ios"),
    warnings: Array.from(new Set(acc.warnings)),
  };
}
