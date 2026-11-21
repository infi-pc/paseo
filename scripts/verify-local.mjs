import { spawn, execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const npmCli = process.env.npm_execpath;
const vitestFlags = ["--maxWorkers=1", "--bail=1"];
const plan = [];
function npmStep(name, args) {
  plan.push({ name, args });
}
// FORK(local-verification): one suite/worker at a time, including dependency builds.
for (const name of ["protocol", "client", "highlight", "relay", "plugin"]) {
  npmStep(`build-${name}`, ["run", `build:${name}`]);
}
for (const name of ["server", "cli", "expo-two-way-audio"]) {
  npmStep(`build-${name}`, ["run", "build", `--workspace=@getpaseo/${name}`]);
}
for (const name of ["typecheck", "lint", "format:check"]) npmStep(name, ["run", name]);
npmStep("client-examples", ["run", "typecheck:examples", "--workspace=@getpaseo/client"]);
const contractTests = [
  "ci-workflow",
  "daemon-launch-contract",
  "changelog-utils",
  "release-version-utils",
  "publish-release-packages",
  "push-current-release-tag",
  "reconcile-release",
  "sync-fdroid-changelogs",
  "sync-release-notes-from-changelog",
  "upload-release-assets",
  "postinstall-patches",
  "builtin-plugins-dist",
  "oxlint/paseo-plugin",
];
npmStep("script-contracts", [
  "exec",
  "--",
  "node",
  "--test",
  "--test-concurrency=1",
  ...contractTests.map((name) => `scripts/${name}.test.mjs`),
]);
for (const name of [
  "relay",
  "plugin",
  "protocol",
  "client",
  "highlight",
  "builtin-plugins",
  "app",
  "desktop",
]) {
  npmStep(`${name}-tests`, ["run", "test", `--workspace=@getpaseo/${name}`, "--", ...vitestFlags]);
}
npmStep("server-units", ["run", "test:unit", "--workspace=@getpaseo/server", "--", ...vitestFlags]);
npmStep("server-integration", ["run", "test:integration", "--workspace=@getpaseo/server"]);
npmStep("cli-units", ["run", "test:unit", "--workspace=@getpaseo/cli", "--", ...vitestFlags]);
npmStep("cli-e2e", ["run", "test:local", "--workspace=@getpaseo/cli"]);
npmStep("website-units", ["exec", "--", "vitest", "run", "packages/website/src", ...vitestFlags]);
npmStep("website-browser", [
  "run",
  "test:e2e",
  "--workspace=@getpaseo/website",
  "--",
  "--workers=1",
]);
npmStep("app-browser", ["run", "test:e2e", "--workspace=@getpaseo/app", "--", "--workers=1"]);
for (const suite of ["lifecycle", "renderer", "browser-tabs"]) {
  npmStep(`desktop-${suite}`, ["run", `test:e2e:${suite}`, "--workspace=@getpaseo/desktop"]);
}

const args = process.argv.slice(2);
if (args.length === 1 && args[0] === "--list") {
  console.log(JSON.stringify(plan, null, 2));
  process.exit(0);
}
if (args.length || !npmCli || process.platform === "win32") {
  throw new Error("Use npm run verify:local on macOS or Linux (or append -- --list to preview).");
}
const lock = join(tmpdir(), `paseo-full-verification-${process.getuid()}.lock`);
try {
  mkdirSync(lock);
} catch (error) {
  if (error.code !== "EEXIST") throw error;
  throw new Error(
    `Another full verification owns ${lock}. Inspect its owner.json before removing a stale lock.`,
    { cause: error },
  );
}
let child = null;
let interrupted = false;
let killTimer;
function signalGroup(pid, signal) {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}
function interrupt(signal) {
  interrupted = true;
  if (child) {
    const pid = child.pid;
    clearTimeout(killTimer);
    signalGroup(pid, signal);
    killTimer = setTimeout(() => signalGroup(pid, "SIGKILL"), 10_000);
    killTimer.unref();
  }
}
const onSigint = () => interrupt("SIGINT");
const onSigterm = () => interrupt("SIGTERM");
process.on("SIGINT", onSigint);
process.on("SIGTERM", onSigterm);
try {
  writeFileSync(join(lock, "owner.json"), JSON.stringify({ pid: process.pid, root }));
  const output = join(
    root,
    "artifacts",
    "local-verification",
    `${new Date().toISOString().replaceAll(":", "-")}-${process.pid}`,
  );
  mkdirSync(output, { recursive: true });
  const git = (...gitArgs) => execFileSync("git", gitArgs, { cwd: root, encoding: "utf8" }).trim();
  const report = {
    commit: git("rev-parse", "HEAD"),
    changes: git("status", "--porcelain"),
    platform: process.platform,
    startedAt: new Date().toISOString(),
    steps: [],
  };
  const env = {
    ...process.env,
    E2E_WORKERS: "1",
    PASEO_CLI_TEST_CONCURRENCY: "1",
    PASEO_CLI_TEST_SHARD: "1",
    PASEO_CLI_TEST_SHARD_TOTAL: "1",
    GOMAXPROCS: "2",
  };
  // An inherited CI shard or endpoint would silently turn a full local run into partial coverage.
  for (const key of [
    "CI",
    "PWTEST_SHARD_WEIGHTS",
    "PLAYWRIGHT_SHARD",
    "PASEO_HOME",
    "PASEO_LISTEN",
    "E2E_PASEO_HOME",
    "E2E_FORK_PASEO_HOME_FROM",
    "E2E_BASE_URL",
    "E2E_METRO_PORT",
    "WEBSITE_TEST_URL",
  ])
    delete env[key];
  console.log(`Full local verification: ${output}`);
  for (const step of plan) {
    if (interrupted) break;
    const log = join(output, `${step.name}.log`);
    console.log(`${step.name}: ${log}`);
    const fd = openSync(log, "w");
    const startedAt = Date.now();
    let code;
    try {
      code = await new Promise((resolve, reject) => {
        const display = process.platform === "linux" && step.name === "desktop-lifecycle";
        const command = display ? "xvfb-run" : process.execPath;
        const commandArgs = [npmCli, ...step.args];
        const argv = display ? ["-a", process.execPath, ...commandArgs] : commandArgs;
        child = spawn(command, argv, { cwd: root, env, detached: true, stdio: ["ignore", fd, fd] });
        child.once("error", reject);
        child.once("exit", (status) => {
          clearTimeout(killTimer);
          if (interrupted) signalGroup(child.pid, "SIGKILL");
          resolve(status ?? 1);
        });
      });
    } catch (error) {
      writeFileSync(fd, `${error.stack}\n`);
      code = 1;
    } finally {
      child = null;
      closeSync(fd);
    }
    report.steps.push({ ...step, code, durationMs: Date.now() - startedAt, log });
    writeFileSync(join(output, "summary.json"), JSON.stringify(report, null, 2) + "\n");
    if (code !== 0) {
      console.error(`FAILED: ${step.name}. See ${log}`);
      process.exitCode = 1;
      break;
    }
  }
  if (interrupted) process.exitCode = 130;
  if (!process.exitCode) console.log(`PASS: ${plan.length} stages. Evidence: ${output}`);
} finally {
  process.off("SIGINT", onSigint);
  process.off("SIGTERM", onSigterm);
  rmSync(lock, { recursive: true, force: true });
}
