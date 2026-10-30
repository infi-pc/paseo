import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
export const forkPackages = ["highlight", "relay", "protocol", "client", "plugin", "server", "cli"];

function publishedName(name) {
  if (name === "cli") return "@infi-pc/paseo";
  return `@infi-pc/paseo-${name}`;
}

export function forkManifest(source, version) {
  const name = source.name.slice("@getpaseo/".length);
  if (!forkPackages.includes(name) || source.name !== `@getpaseo/${name}`) {
    throw new Error(`Unknown fork workspace: ${source.name}`);
  }
  const manifest = structuredClone(source);
  manifest.name = publishedName(name);
  manifest.version = version;
  manifest.repository = { type: "git", url: "git+https://github.com/infi-pc/paseo.git" };
  manifest.publishConfig = { access: "public", registry: "https://registry.npmjs.org" };
  delete manifest.scripts;
  delete manifest.devDependencies;
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies"]) {
    for (const dependency of Object.keys(manifest[field] ?? {})) {
      if (!dependency.startsWith("@getpaseo/")) continue;
      const workspace = dependency.slice("@getpaseo/".length);
      if (!forkPackages.includes(workspace)) {
        throw new Error(`Unpublished workspace dependency: ${dependency}`);
      }
      const selector = `npm:${publishedName(workspace)}@${version}`;
      // npm peer dependencies cannot use aliases. Install internal peers explicitly.
      if (field === "peerDependencies") {
        delete manifest.peerDependencies[dependency];
        delete manifest.peerDependenciesMeta?.[dependency];
        manifest.dependencies ??= {};
        manifest.dependencies[dependency] = selector;
      } else {
        manifest[field][dependency] = selector;
      }
    }
  }
  return manifest;
}

function npm(args, cwd) {
  return execFileSync("npm", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    stdio: args[0] === "publish" ? "inherit" : ["ignore", "pipe", "inherit"],
  });
}

export function packForkPackages({ root = repositoryRoot, output, version }) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid fork version: ${version}`);
  }
  mkdirSync(output, { recursive: true });
  const staging = mkdtempSync(path.join(tmpdir(), "paseo-fork-pack-"));
  const releases = [];
  try {
    for (const name of forkPackages) {
      const source = path.join(root, "packages", name);
      const [packed] = JSON.parse(
        npm(["pack", "--ignore-scripts", "--json", "--pack-destination", staging], source),
      );
      const directory = path.join(staging, name);
      mkdirSync(directory);
      execFileSync("tar", [
        "-xzf",
        path.join(staging, packed.filename),
        "-C",
        directory,
        "--strip-components=1",
      ]);
      const manifestPath = path.join(directory, "package.json");
      const manifest = forkManifest(JSON.parse(readFileSync(manifestPath, "utf8")), version);
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      copyFileSync(path.join(root, "LICENSE"), path.join(directory, "LICENSE"));
      if (name === "cli") {
        writeFileSync(
          path.join(directory, "README.md"),
          "# Michael's Paseo fork\n\nInstall with `npm install -g @infi-pc/paseo`, then run `paseo` to start and pair the daemon.\n\nUse **Update daemon** in your host settings to install this fork's latest release.\n\nSource: https://github.com/infi-pc/paseo/tree/paseo-customizations\n",
        );
      }
      const [artifact] = JSON.parse(
        npm(["pack", "--ignore-scripts", "--json", "--pack-destination", output], directory),
      );
      releases.push({
        name: manifest.name,
        version,
        filename: artifact.filename,
        integrity: artifact.integrity,
      });
    }
    writeFileSync(path.join(output, "release.json"), `${JSON.stringify(releases, null, 2)}\n`);
    return releases;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const publish = args.includes("--publish");
  const versionIndex = args.indexOf("--version");
  const version = versionIndex < 0 ? null : args[versionIndex + 1];
  const output = path.join(repositoryRoot, "artifacts", "fork-npm", version ?? "");
  if (
    !version ||
    args.some(
      (arg, index) => !["--version", "--publish"].includes(arg) && index !== versionIndex + 1,
    )
  ) {
    throw new Error("Usage: npm run fork:npm:pack -- --version <version> [--publish]");
  }
  const releases = packForkPackages({ output, version });
  if (publish) {
    for (const release of releases) {
      npm(
        [
          "publish",
          path.join(output, release.filename),
          "--access",
          "public",
          "--tag",
          "latest",
          "--registry=https://registry.npmjs.org",
        ],
        repositoryRoot,
      );
      process.stdout.write(`Published ${release.name}@${version}\n`);
    }
  }
  process.stdout.write(`Fork packages: ${output}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main();
