#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = fileURLToPath(new URL("../", import.meta.url));
const app = path.join(root, "packages/app");
const require = createRequire(import.meta.url);
const { getTestflightConfig } = require("../packages/app/testflight/config.js");
const buildNumber = process.argv[2];
if (process.platform !== "darwin" || !buildNumber || process.argv.length !== 3) {
  throw new Error("On macOS, run: npm run build:ios:testflight -- <new-positive-build-number>");
}
const env = {
  ...process.env,
  CI: "1",
  APP_VARIANT: "testflight",
  PASEO_IOS_BUILD_NUMBER: buildNumber,
};
const identity = getTestflightConfig(env);
const output = path.join(root, "artifacts/ios-testflight", buildNumber);
const archive = path.join(output, "Paseo.xcarchive");

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

// Fail before prebuild if the native toolchain is incomplete.
run("xcodebuild", ["-version"]);
run("pod", ["--version"]);
run("npm", ["run", "build:app-deps"]);
// Clean prebuild is essential: simulator development may have generated sh.paseo.debug.
run("npx", ["expo", "prebuild", "--platform", "ios", "--clean", "--no-install"], app);
run("pod", ["install"], path.join(app, "ios"));
mkdirSync(output, { recursive: true });
run(
  "xcodebuild",
  [
    "-workspace",
    "ios/PaseoPersonal.xcworkspace",
    "-scheme",
    "PaseoPersonal",
    "-configuration",
    "Release",
    "-destination",
    "generic/platform=iOS",
    "-archivePath",
    archive,
    "-derivedDataPath",
    path.join(root, ".dev/ios-testflight"),
    "-allowProvisioningUpdates",
    `DEVELOPMENT_TEAM=${identity.appleTeamId}`,
    "CODE_SIGN_STYLE=Automatic",
    "archive",
  ],
  app,
);

const exportOptions = path.join(output, "ExportOptions.plist");
writeFileSync(
  exportOptions,
  `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>export</string>
  <key>signingStyle</key><string>automatic</string>
  <key>teamID</key><string>${identity.appleTeamId}</string>
</dict></plist>
`,
);
run("xcodebuild", [
  "-exportArchive",
  "-archivePath",
  archive,
  "-exportOptionsPlist",
  exportOptions,
  "-exportPath",
  output,
  "-allowProvisioningUpdates",
]);
process.stdout.write(`TestFlight archive and IPA: ${output}\n`);
