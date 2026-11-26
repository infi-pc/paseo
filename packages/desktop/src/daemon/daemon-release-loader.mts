import { realpathSync } from "node:fs";
import * as nodeModule from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface ResolveContext {
  parentURL?: string;
}

type NextResolve = (specifier: string, context?: ResolveContext) => unknown;

function isBareSpecifier(specifier: string): boolean {
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !specifier.startsWith("file:") &&
    !specifier.startsWith("node:") &&
    !specifier.startsWith("data:") &&
    !specifier.startsWith("#")
  );
}

function registerEditableDaemonHooks(): void {
  if (process.env.ELECTRON_RUN_AS_NODE !== "1") return;
  const rawDaemonDir = process.env.PASEO_EDITABLE_DAEMON_DIR?.trim();
  const fallbackRoot = process.env.PASEO_EDITABLE_FALLBACK_ROOT?.trim();
  if (!rawDaemonDir || !fallbackRoot) return;

  const maybeRegister = (
    nodeModule as {
      registerHooks?: (hooks: {
        resolve: (specifier: string, context: ResolveContext, nextResolve: NextResolve) => unknown;
      }) => void;
    }
  ).registerHooks;
  if (typeof maybeRegister !== "function") return;

  let daemonDir = rawDaemonDir;
  try {
    daemonDir = realpathSync(rawDaemonDir);
  } catch {
    // Keep original path when canonicalization is unavailable.
  }

  const daemonDirUrl = pathToFileURL(
    daemonDir.endsWith(path.sep) ? daemonDir : `${daemonDir}${path.sep}`,
  ).href;
  const daemonParentUrl = pathToFileURL(path.join(daemonDir, "package.json")).href;
  const fallbackParentPaths = [
    path.join(fallbackRoot, "node_modules", "@getpaseo", "server", "package.json"),
    path.join(fallbackRoot, "packages", "server", "package.json"),
    path.join(fallbackRoot, "package.json"),
  ];
  const fallbackParentUrls = fallbackParentPaths.map((p) => pathToFileURL(p).href);
  const fallbackRequires = fallbackParentPaths.map((p) => nodeModule.createRequire(p));

  const tryFallbackResolve = (
    specifier: string,
    context: ResolveContext,
    nextResolve: NextResolve,
  ): unknown | null => {
    for (const parentURL of fallbackParentUrls) {
      try {
        return nextResolve(specifier, { ...context, parentURL });
      } catch {
        // Try next parent location.
      }
    }
    for (const req of fallbackRequires) {
      try {
        return { url: pathToFileURL(req.resolve(specifier)).href, shortCircuit: true };
      } catch {
        // Try next require base.
      }
    }
    return null;
  };

  maybeRegister({
    resolve(specifier, context, nextResolve) {
      if (specifier.startsWith("@getpaseo/")) {
        try {
          return nextResolve(specifier, { ...context, parentURL: daemonParentUrl });
        } catch {
          // Fall through to default resolution.
        }
      }
      try {
        return nextResolve(specifier, context);
      } catch (err) {
        if (
          isBareSpecifier(specifier) &&
          (!context.parentURL || context.parentURL.startsWith(daemonDirUrl))
        ) {
          const resolved = tryFallbackResolve(specifier, context, nextResolve);
          if (resolved) return resolved;
        }
        throw err;
      }
    },
  });
}

try {
  registerEditableDaemonHooks();
} catch {
  // Never abort child processes if hook registration fails.
}
