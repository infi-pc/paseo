const { z } = require("zod");

function getTestflightConfig(env) {
  const buildNumber = z
    .string()
    .regex(/^[1-9][0-9]{0,17}$/)
    .parse(env.PASEO_IOS_BUILD_NUMBER ?? "1");
  return {
    name: "Paseo Personal",
    slug: "infi-paseo",
    bundleIdentifier: "cz.infi.paseo",
    appleTeamId: "UQAKP649X7",
    expoProjectId: "f5b7f971-d12b-4e9c-91fa-d9d4c76395ae",
    buildNumber,
  };
}

module.exports = { getTestflightConfig };
