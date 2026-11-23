import path from "node:path";
import { pathToFileURL } from "node:url";
import { applyDevInstanceProfile } from "./dev-profile.js";

async function main(): Promise<void> {
  const profile = applyDevInstanceProfile({ resourcesPath: path.resolve(__dirname, "../../..") });
  if (!profile) throw new Error("Paseo Dev CLI requires the bundled dev profile");
  const entrypoint = path.resolve(__dirname, "../../node_modules/@getpaseo/cli/dist/index.js");
  await import(pathToFileURL(entrypoint).href);
}

void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
