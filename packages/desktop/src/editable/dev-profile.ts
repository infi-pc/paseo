import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const PROFILE_FILENAME = "paseo-dev-profile.json";

interface DevInstanceProfile {
  name: string;
  appId: string;
  defaultHomeDirName: string;
  defaultListen: string;
  deepLinkScheme: string;
  cliName: string;
}

function packagedProfilePath(resourcesPath = process.resourcesPath): string | undefined {
  if (!resourcesPath) return undefined;
  const filename = path.join(resourcesPath, PROFILE_FILENAME);
  return existsSync(filename) ? filename : undefined;
}

export function isDevInstance(): boolean {
  return process.env.PASEO_DEV_INSTANCE === "1" || packagedProfilePath() !== undefined;
}

function resolveExistingParents(filename: string): string {
  try {
    return realpathSync(filename);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return path.join(resolveExistingParents(path.dirname(filename)), path.basename(filename));
  }
}

function isolatedPath(input: string, userHome: string, label: string): string {
  if (!input.trim()) throw new Error(`${label} must not be empty`);
  const expanded =
    input === "~" || input.startsWith("~/") ? path.join(userHome, input.slice(1)) : input;
  const filename = path.resolve(expanded);
  const forbidden = [
    ".paseo",
    ".paseo-workshop",
    ".editable-paseo",
    "library/application support/paseo",
  ];
  const conflicts = (candidate: string, root: string) => {
    const relative = path.relative(root.toLowerCase(), candidate.toLowerCase());
    return forbidden.some((dir) => relative === dir || relative.startsWith(dir + path.sep));
  };
  if (
    conflicts(filename, userHome) ||
    conflicts(resolveExistingParents(filename), realpathSync(userHome))
  ) {
    throw new Error(`${label} must point to a separate Paseo Dev directory`);
  }
  return filename;
}

export function applyDevInstanceProfile({
  env = process.env,
  resourcesPath = process.resourcesPath,
  userHome = os.homedir(),
} = {}): DevInstanceProfile | null {
  const packaged = packagedProfilePath(resourcesPath);
  if (!packaged && env.PASEO_DEV_INSTANCE !== "1") return null;

  const profile: DevInstanceProfile = JSON.parse(
    readFileSync(packaged ?? path.join(__dirname, "../../build", PROFILE_FILENAME), "utf8"),
  );
  const home = isolatedPath(
    env.PASEO_HOME ?? path.join(userHome, profile.defaultHomeDirName),
    userHome,
    "PASEO_HOME",
  );
  const listen = env.PASEO_LISTEN ?? profile.defaultListen;
  const port = Number(/^127\.0\.0\.1:(\d{1,5})$/.exec(listen)?.[1]);
  if (!port || port > 65535 || port === 6767 || port === 6769) {
    throw new Error("PASEO_LISTEN must be a separate Paseo Dev loopback port (127.0.0.1:<port>)");
  }

  const editableHome = isolatedPath(
    env.EDITABLE_PASEO_HOME ?? path.join(home, "editable"),
    userHome,
    "EDITABLE_PASEO_HOME",
  );
  const userData = isolatedPath(
    env.PASEO_ELECTRON_USER_DATA_DIR?.trim() || path.join(home, "desktop"),
    userHome,
    "PASEO_ELECTRON_USER_DATA_DIR",
  );

  if (mkdirSync(home, { recursive: true, mode: 0o700 }) !== undefined) {
    writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ daemon: { listen, relay: { enabled: false } } }, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
  }
  Object.assign(env, {
    PASEO_HOME: home,
    PASEO_LISTEN: listen,
    EDITABLE_PASEO_HOME: editableHome,
    PASEO_ELECTRON_USER_DATA_DIR: userData,
  });
  return profile;
}
