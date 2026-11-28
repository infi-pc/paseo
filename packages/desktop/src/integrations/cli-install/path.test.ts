import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import path from "node:path";
import {
  resolveCliInstallSourcePath,
  resolveCliShimPath,
  resolveEditableCliInstallSourcePath,
} from "./path";

describe("cli-install-path", () => {
  it("uses the bundled shim for packaged macOS installs", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
        shimPath: "/Applications/Paseo.app/Contents/Resources/bin/paseo",
      }),
    ).toBe("/Applications/Paseo.app/Contents/Resources/bin/paseo");
  });

  it("prefers the original AppImage path on linux", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/tmp/.mount_paseo123/paseo",
        shimPath: "/tmp/.mount_paseo123/resources/bin/paseo",
        appImagePath: "/home/user/Applications/Paseo.AppImage",
      }),
    ).toBe("/home/user/Applications/Paseo.AppImage");
  });

  it("uses the bundled shim for packaged linux installs outside an AppImage", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/opt/Paseo/Paseo",
        shimPath: "/opt/Paseo/resources/bin/paseo",
      }),
    ).toBe("/opt/Paseo/resources/bin/paseo");
  });

  it("falls back to the shim on windows and in development", () => {
    expect(
      resolveCliInstallSourcePath({
        platform: "win32",
        isPackaged: true,
        executablePath: "C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\Paseo.exe",
        shimPath: "C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.cmd",
      }),
    ).toBe("C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo.cmd");

    expect(
      resolveCliInstallSourcePath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/opt/Paseo/paseo",
        shimPath: "/opt/Paseo/resources/bin/paseo",
      }),
    ).toBe("/opt/Paseo/resources/bin/paseo");
  });

  it("resolves paseo-ed shim on macOS and non-AppImage Linux, skipping AppImage and Windows", () => {
    expect(
      resolveEditableCliInstallSourcePath({
        platform: "darwin",
        isPackaged: true,
        shimPath: "/Applications/Paseo.app/Contents/Resources/bin/paseo-ed",
      }),
    ).toBe("/Applications/Paseo.app/Contents/Resources/bin/paseo-ed");
    expect(
      resolveEditableCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        shimPath: "/opt/Paseo/resources/bin/paseo-ed",
      }),
    ).toBe("/opt/Paseo/resources/bin/paseo-ed");
    expect(
      resolveEditableCliInstallSourcePath({
        platform: "linux",
        isPackaged: true,
        shimPath: "/tmp/.mount_paseo123/resources/bin/paseo-ed",
        appImagePath: "/home/user/Applications/Paseo.AppImage",
      }),
    ).toBeNull();
    expect(
      resolveEditableCliInstallSourcePath({
        platform: "win32",
        isPackaged: true,
        shimPath: "C:\\Users\\user\\AppData\\Local\\Programs\\Paseo\\resources\\bin\\paseo-ed",
      }),
    ).toBeNull();
  });
});

describe("CLI executable selection", () => {
  const resolveWorkspaceCli = () =>
    createRequire(import.meta.url).resolve("@getpaseo/cli/bin/paseo");

  it("uses the workspace CLI for an unpackaged Electron launcher", () => {
    expect(
      resolveCliShimPath({
        platform: "linux",
        isPackaged: false,
        executablePath: "/nix/store/electron/bin/electron",
        resolveWorkspaceCli,
      }),
    ).toBe(resolveWorkspaceCli());
  });

  it("uses the application shim for a packaged launcher", () => {
    expect(
      resolveCliShimPath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/opt/Paseo/paseo",
        resolveWorkspaceCli,
      }),
    ).toBe(path.join("/opt/Paseo", "resources", "bin", "paseo"));
    expect(
      resolveCliShimPath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
        resolveWorkspaceCli,
      }),
    ).toBe(path.join("/Applications/Paseo.app", "Contents", "Resources", "bin", "paseo"));
    expect(
      resolveCliShimPath({
        platform: "darwin",
        isPackaged: true,
        executablePath: "/Applications/Paseo.app/Contents/MacOS/Paseo",
        binaryName: "paseo-ed",
        resolveWorkspaceCli,
      }),
    ).toBe(path.join("/Applications/Paseo.app", "Contents", "Resources", "bin", "paseo-ed"));
    expect(
      resolveCliShimPath({
        platform: "linux",
        isPackaged: true,
        executablePath: "/opt/Paseo/paseo",
        binaryName: "paseo-ed",
        resolveWorkspaceCli,
      }),
    ).toBe(path.join("/opt/Paseo", "resources", "bin", "paseo-ed"));
  });
});
