import os from "node:os";
import path from "node:path";
import { isDevInstance } from "./dev-profile.js";

export {
  DAEMON_ENTRYPOINT_REL_PATH,
  DAEMON_RUNTIME_VERSION,
  DESKTOP_RUNTIME_VERSION,
} from "@getpaseo/editable-core";

export const EDITABLE_APP_SCHEME = "paseo";
export const EDITABLE_APP_ORIGIN = `${EDITABLE_APP_SCHEME}://app`;

export function resolveEditableHome(): string {
  return process.env.EDITABLE_PASEO_HOME ?? path.join(os.homedir(), ".editable-paseo");
}

export function isSafeRenderer(argv = process.argv, env = process.env): boolean {
  return argv.includes("--safe-renderer") || env.PASEO_SAFE_RENDERER === "1";
}

export function allowUpstreamDesktopUpdates(env = process.env): boolean {
  return !isDevInstance() && env.PASEO_ALLOW_UPSTREAM_DESKTOP_UPDATES === "1";
}
