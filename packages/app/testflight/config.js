const { homedir } = require("node:os");
const path = require("node:path");
const { z } = require("zod");

function getTestflightConfig(env) {
  const buildNumber = z
    .string()
    .regex(/^[1-9][0-9]{0,17}$/)
    .parse(env.PASEO_IOS_BUILD_NUMBER ?? "1");
  const certificate = env.PASEO_EXPO_CODE_SIGNING_CERT?.trim();
  const certificatePath = certificate?.startsWith("~/")
    ? path.join(homedir(), certificate.slice(2))
    : certificate;
  return {
    name: "Paseo Personal",
    slug: "infi-paseo",
    bundleIdentifier: "cz.infi.paseo",
    appleTeamId: "UQAKP649X7",
    expoProjectId: "f5b7f971-d12b-4e9c-91fa-d9d4c76395ae",
    buildNumber,
    updatesUrl: env.PASEO_EXPO_UPDATES_URL?.trim() || undefined,
    // Expo prebuild joins the certificate path to the app directory.
    codeSigningCertificate:
      certificatePath && path.isAbsolute(certificatePath)
        ? path.relative(path.resolve(__dirname, ".."), certificatePath)
        : certificatePath,
  };
}

function getTestflightUpdates(testflight, appVersion) {
  if (!testflight?.updatesUrl) return {};
  const { updatesUrl, codeSigningCertificate } = testflight;
  return {
    runtimeVersion: appVersion,
    updates: {
      enabled: true,
      url: updatesUrl,
      checkAutomatically: "ON_LOAD",
      fallbackToCacheTimeout: 0,
      ...(codeSigningCertificate
        ? {
            codeSigningCertificate,
            codeSigningMetadata: { keyid: "main", alg: "rsa-v1_5-sha256" },
          }
        : {}),
    },
  };
}

module.exports = { getTestflightConfig, getTestflightUpdates };
