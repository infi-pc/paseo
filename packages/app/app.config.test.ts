import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

// Load the copies the Expo CLI uses for prebuild, not older hoisted ones.
const requireFromExpo = createRequire(require.resolve("expo/package.json"));
const requireFromExpoCli = createRequire(requireFromExpo.resolve("@expo/cli/package.json"));
const { getPrebuildConfigAsync } = requireFromExpoCli("@expo/prebuild-config");
const { compileModsAsync } = requireFromExpoCli(
  "@expo/config-plugins/build/plugins/mod-compiler.js",
);

interface ManifestEntry {
  $: Record<string, string>;
}

const originalFdroidFlag = process.env.PASEO_FDROID_BUILD;
const { getConfig } = requireFromExpo("@expo/config");
const { IOSConfig } = requireFromExpo("expo/config-plugins");

describe("Personal TestFlight identity", () => {
  afterEach(() => vi.unstubAllEnvs());

  function configureTestflight() {
    vi.stubEnv("APP_VARIANT", "testflight");
    vi.stubEnv("PASEO_IOS_BUILD_NUMBER", "2");
    // An upstream Firebase credential must not enter the personal archive.
    vi.stubEnv("GOOGLE_SERVICE_INFO_PLIST_PROD", "/upstream/GoogleService-Info.plist");
  }

  it("uses the personal Apple and Expo identities without upstream Firebase credentials", () => {
    configureTestflight();
    const { exp } = getConfig(__dirname);
    expect(exp).toMatchObject({
      name: "Paseo Personal",
      slug: "infi-paseo",
      ios: { bundleIdentifier: "cz.infi.paseo", appleTeamId: "UQAKP649X7", buildNumber: "2" },
      extra: { eas: { projectId: "f5b7f971-d12b-4e9c-91fa-d9d4c76395ae" } },
    });
    expect(exp.ios.googleServicesFile).toBeUndefined();
    expect(exp.owner).toBeUndefined();
  });

  it("rejects an invalid build number", () => {
    configureTestflight();
    vi.stubEnv("PASEO_IOS_BUILD_NUMBER", "0");
    expect(() => getConfig(__dirname)).toThrow();
  });

  it("keeps the upstream production identity for its existing release jobs", () => {
    vi.stubEnv("APP_VARIANT", "production");
    const { exp } = getConfig(__dirname);
    expect(exp).toMatchObject({
      slug: "voice-mobile",
      owner: "getpaseo",
      ios: { bundleIdentifier: "sh.paseo" },
      extra: { eas: { projectId: "0e7f65ce-0367-46c8-a238-2b65963d235a" } },
    });
  });
});

// FORK(editable): verify the OTA endpoint and signing settings stay personal.
describe("Personal TestFlight OTA updates", () => {
  const url = "https://updates.example.test/ios";
  const certificate = "/personal/expo-codesign.cert.pem";

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    ["production", "sh.paseo"],
    ["development", "sh.paseo.debug"],
  ])("ignores update settings in %s", (variant, bundleIdentifier) => {
    vi.stubEnv("APP_VARIANT", variant);
    vi.stubEnv("PASEO_EXPO_UPDATES_URL", url);
    vi.stubEnv("PASEO_EXPO_CODE_SIGNING_CERT", certificate);

    const { exp } = getConfig(__dirname);
    expect(exp.ios.bundleIdentifier).toBe(bundleIdentifier);
    expect(exp).not.toHaveProperty("updates");
    expect(exp).not.toHaveProperty("runtimeVersion");
  });

  it("embeds the signing certificate and app version in personal iOS builds", async () => {
    const root = await mkdtemp(join(tmpdir(), "paseo-expo-updates-"));
    const certificatePath = join(root, "expo-codesign.cert.pem");
    const certificateContents = "Test certificate contents";
    try {
      await writeFile(certificatePath, certificateContents);
      vi.stubEnv("APP_VARIANT", "testflight");
      vi.stubEnv("PASEO_EXPO_UPDATES_URL", url);
      vi.stubEnv("PASEO_EXPO_CODE_SIGNING_CERT", certificatePath);

      const { exp } = getConfig(__dirname);
      expect(exp.ios.bundleIdentifier).toBe("cz.infi.paseo");
      expect(exp.runtimeVersion).toBe(exp.version);
      expect(exp.updates).toEqual({
        enabled: true,
        url,
        checkAutomatically: "ON_LOAD",
        fallbackToCacheTimeout: 0,
        codeSigningCertificate: relative(__dirname, certificatePath),
        codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
      });

      const plist = await IOSConfig.Updates.setUpdatesConfigAsync(__dirname, exp, {});
      expect(plist).toMatchObject({
        EXUpdatesEnabled: true,
        EXUpdatesURL: url,
        EXUpdatesRuntimeVersion: exp.version,
        EXUpdatesCheckOnLaunch: "ALWAYS",
        EXUpdatesLaunchWaitMs: 0,
        EXUpdatesCodeSigningCertificate: certificateContents,
        EXUpdatesCodeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("supports an endpoint without a signing certificate", () => {
    vi.stubEnv("APP_VARIANT", "testflight");
    vi.stubEnv("PASEO_EXPO_UPDATES_URL", url);
    vi.stubEnv("PASEO_EXPO_CODE_SIGNING_CERT", undefined);

    const { exp } = getConfig(__dirname);
    expect(exp.runtimeVersion).toBe(exp.version);
    expect(exp.updates).toEqual({
      enabled: true,
      url,
      checkAutomatically: "ON_LOAD",
      fallbackToCacheTimeout: 0,
    });
  });

  it("leaves updates unconfigured without an endpoint", () => {
    vi.stubEnv("APP_VARIANT", "testflight");
    vi.stubEnv("PASEO_EXPO_UPDATES_URL", undefined);
    vi.stubEnv("PASEO_EXPO_CODE_SIGNING_CERT", undefined);

    const { exp } = getConfig(__dirname);
    expect(exp).not.toHaveProperty("updates");
    expect(exp).not.toHaveProperty("runtimeVersion");
  });
});

async function resolveAndroidManifest() {
  const { exp } = await getPrebuildConfigAsync(__dirname, { platforms: ["android"] });
  await compileModsAsync(exp, {
    projectRoot: __dirname,
    introspect: true,
    platforms: ["android"],
    assertMissingModProviders: false,
  });
  return exp._internal.modResults.android.manifest.manifest;
}

describe("Android app config", () => {
  afterEach(() => {
    if (originalFdroidFlag === undefined) {
      delete process.env.PASEO_FDROID_BUILD;
    } else {
      process.env.PASEO_FDROID_BUILD = originalFdroidFlag;
    }
  });

  it.each([
    ["Google Play", "0"],
    ["F-Droid", "1"],
  ])(
    "%s build installs on devices without a camera",
    async (_build, fdroidFlag) => {
      process.env.PASEO_FDROID_BUILD = fdroidFlag;
      const manifest = await resolveAndroidManifest();
      const permissions = (manifest["uses-permission"] ?? []).map(
        (entry: ManifestEntry) => entry.$["android:name"],
      );
      const features = (manifest["uses-feature"] ?? []).map((entry: ManifestEntry) => entry.$);

      expect(permissions).toContain("android.permission.CAMERA");
      expect(features).toEqual(
        expect.arrayContaining([
          { "android:name": "android.hardware.camera", "android:required": "false" },
          { "android:name": "android.hardware.camera.autofocus", "android:required": "false" },
        ]),
      );
    },
    30_000,
  );
});

it("follows system rotation on Android", async () => {
  const manifest = await resolveAndroidManifest();
  const activity = manifest.application[0].activity.find(
    (entry: ManifestEntry) => entry.$["android:name"] === ".MainActivity",
  );
  expect(activity.$["android:screenOrientation"]).toBe("unspecified");
}, 30_000);

it("allows all orientations on iPhone and iPad", async () => {
  const root = await mkdtemp(join(tmpdir(), "paseo-ios-config-"));
  try {
    const { exp } = await getPrebuildConfigAsync(__dirname, { platforms: ["ios"] });
    await compileModsAsync(exp, {
      projectRoot: root,
      introspect: true,
      platforms: ["ios"],
      assertMissingModProviders: false,
    });
    const plist = exp._internal.modResults.ios.infoPlist;
    const orientations = [
      "UIInterfaceOrientationPortrait",
      "UIInterfaceOrientationPortraitUpsideDown",
      "UIInterfaceOrientationLandscapeLeft",
      "UIInterfaceOrientationLandscapeRight",
    ];
    expect(plist.UISupportedInterfaceOrientations).toEqual(orientations);
    expect(plist["UISupportedInterfaceOrientations~ipad"]).toEqual(orientations);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

// Scene startup is the integration boundary for the iOS keyboard window.
describe("hardware keyboard scene integration", () => {
  it("installs observation after Expo creates the scene window and is idempotent", () => {
    const {
      configureHardwareKeyboardAppDelegate,
    } = require("./modules/paseo-hardware-keyboard/app.plugin.js");
    const source =
      "import Expo\nclass Scene {\n  super.scene(scene, willConnectTo: session, options: connectionOptions)\n}\n";
    const configured = configureHardwareKeyboardAppDelegate(source);
    expect(configured).toContain("import PaseoHardwareKeyboard");
    expect(configured).toContain("PaseoHardwareKeyboardWindow.observing(window)");
    expect(configured.indexOf("super.scene")).toBeLessThan(
      configured.indexOf(".observing(window)"),
    );
    expect(configureHardwareKeyboardAppDelegate(configured)).toBe(configured);
  });
});
