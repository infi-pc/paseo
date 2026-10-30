import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import {
  forkManifest,
  forkPackages,
  packForkPackages,
} from "../../../../../../scripts/fork-npm.mjs";
import { startNpmRegistry } from "../../../../../../scripts/test-support/npm-registry.mts";

const run = promisify(execFile);
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});

test.skipIf(process.platform === "win32")(
  "installs packed fork workspaces through aliases without requesting upstream packages",
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), "paseo-fork-npm-test-"));
    directories.push(root);
    await writeFile(path.join(root, "LICENSE"), "Fixture license");
    const version = "0.13.1-infi.1";
    const fixtures = [];
    for (const name of forkPackages) {
      const source = {
        name: `@getpaseo/${name}`,
        version: "0.13.1",
        type: "module",
        main: "index.js",
        dependencies: name === "cli" ? { "@getpaseo/server": "0.13.1" } : {},
        peerDependencies: name === "server" ? { "@getpaseo/protocol": "0.13.1" } : {},
      };
      const contents =
        name === "cli"
          ? 'export { default } from "@getpaseo/server";'
          : `export default ${JSON.stringify(name)};`;
      const directory = path.join(root, "packages", name);
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, "package.json"), JSON.stringify(source));
      await writeFile(path.join(directory, "index.js"), contents);
      const manifest = forkManifest(source, version);
      fixtures.push({ ...manifest, files: { "index.js": contents } });
    }
    const output = path.join(root, "artifacts");
    const releases = packForkPackages({ root, output, version });
    expect(releases.map((release) => release.name)).toEqual([
      "@infi-pc/paseo-highlight",
      "@infi-pc/paseo-relay",
      "@infi-pc/paseo-protocol",
      "@infi-pc/paseo-client",
      "@infi-pc/paseo-plugin",
      "@infi-pc/paseo-server",
      "@infi-pc/paseo",
    ]);
    const serverTarball = path.join(output, releases[5].filename);
    const { stdout: packedManifest } = await run("tar", [
      "-xOf",
      serverTarball,
      "package/package.json",
    ]);
    expect(JSON.parse(packedManifest).dependencies).toEqual({
      "@getpaseo/protocol": `npm:@infi-pc/paseo-protocol@${version}`,
    });
    const registry = await startNpmRegistry(fixtures);
    try {
      const prefix = path.join(root, "prefix");
      await run(
        "npm",
        [
          "install",
          "-g",
          path.join(output, releases[6].filename),
          "--prefix",
          prefix,
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
        ],
        {
          env: { ...process.env, ...registry.env },
        },
      );
      const installed = path.join(prefix, "lib/node_modules/@infi-pc/paseo");
      const { stdout } = await run(process.execPath, [
        "--input-type=module",
        "-e",
        `import value from ${JSON.stringify(path.join(installed, "index.js"))}; process.stdout.write(value);`,
      ]);
      expect(stdout).toBe("server");
      expect(registry.requests.filter((request) => request.startsWith("/@getpaseo/"))).toEqual([]);
      expect(registry.requests).toContain("/@infi-pc/paseo-server");
      expect(registry.requests).toContain("/@infi-pc/paseo-protocol");
      const unchanged = JSON.parse(
        await readFile(path.join(root, "packages/cli/package.json"), "utf8"),
      );
      expect(unchanged.name).toBe("@getpaseo/cli");
      expect(unchanged.version).toBe("0.13.1");
    } finally {
      await registry.close();
    }
  },
  60_000,
);

test("refuses an internal dependency missing from the fork release", () => {
  expect(() =>
    forkManifest(
      { name: "@getpaseo/cli", dependencies: { "@getpaseo/new-package": "1.0.0" } },
      "1.0.0",
    ),
  ).toThrow("Unpublished workspace dependency: @getpaseo/new-package");
});
