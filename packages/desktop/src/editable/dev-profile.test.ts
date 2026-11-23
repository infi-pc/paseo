import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyDevInstanceProfile } from "./dev-profile.js";

describe("Paseo Dev instance profile", () => {
  let userHome: string;

  beforeEach(() => {
    userHome = mkdtempSync(path.join(os.tmpdir(), "paseo-dev-profile-"));
  });
  afterEach(() => rmSync(userHome, { recursive: true, force: true }));

  it("leaves ordinary desktop launches alone", () => {
    const env = {};
    expect(applyDevInstanceProfile({ env, userHome })).toBeNull();
    expect(env).toEqual({});
    expect(existsSync(path.join(userHome, ".paseo-dev"))).toBe(false);
  });

  it("uses the marker shipped in the bundle and seeds a new daemon home", () => {
    const resourcesPath = path.join(userHome, "resources");
    mkdirSync(resourcesPath);
    const filename = "paseo-dev-profile.json";
    writeFileSync(
      path.join(resourcesPath, filename),
      readFileSync(path.join(__dirname, "../../build", filename)),
    );
    const env = {};
    const home = path.join(userHome, ".paseo-dev");
    expect(applyDevInstanceProfile({ env, resourcesPath, userHome })).toMatchObject({
      name: "Paseo Dev",
      appId: "cz.infi.paseo.dev",
      deepLinkScheme: "paseo-dev",
      cliName: "paseo-dev",
    });
    expect(env).toEqual({
      PASEO_HOME: home,
      PASEO_LISTEN: "127.0.0.1:6770",
      PASEO_ELECTRON_USER_DATA_DIR: path.join(home, "desktop"),
      EDITABLE_PASEO_HOME: path.join(home, "editable"),
    });
    expect(JSON.parse(readFileSync(path.join(home, "config.json"), "utf8"))).toEqual({
      daemon: { listen: "127.0.0.1:6770", relay: { enabled: false } },
    });
  });

  it("honors safe explicit overrides and preserves existing config", () => {
    const home = path.join(userHome, "custom");
    mkdirSync(home);
    const config = path.join(home, "config.json");
    writeFileSync(config, "{}");
    const env = {
      PASEO_DEV_INSTANCE: "1",
      PASEO_HOME: home,
      PASEO_LISTEN: "127.0.0.1:6775",
      EDITABLE_PASEO_HOME: path.join(userHome, "other-editable"),
    };
    expect(applyDevInstanceProfile({ env, userHome })).not.toBeNull();
    expect(env.PASEO_HOME).toBe(home);
    expect(env.PASEO_LISTEN).toBe("127.0.0.1:6775");
    expect(env.EDITABLE_PASEO_HOME).toBe(path.join(userHome, "other-editable"));
    expect(readFileSync(config, "utf8")).toBe("{}");
  });

  it.each(["127.0.0.1:6767", "127.0.0.1:6769"])(
    "rejects a reserved listen address %s",
    (listen) => {
      expect(() =>
        applyDevInstanceProfile({
          env: { PASEO_DEV_INSTANCE: "1", PASEO_LISTEN: listen },
          userHome,
        }),
      ).toThrow("separate Paseo Dev loopback port");
      expect(existsSync(path.join(userHome, ".paseo-dev"))).toBe(false);
    },
  );

  it("rejects paths that alias production state", () => {
    const production = path.join(userHome, ".paseo");
    mkdirSync(production);
    const alias = path.join(userHome, "alias");
    symlinkSync(production, alias, "dir");
    expect(() =>
      applyDevInstanceProfile({
        env: { PASEO_DEV_INSTANCE: "1", PASEO_HOME: alias },
        userHome,
      }),
    ).toThrow("PASEO_HOME must point to a separate");
    expect(existsSync(path.join(production, "config.json"))).toBe(false);
  });
});
