import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { relative as relativePath } from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { PUBLISH_WORKSPACES } from "./publish-release-packages.mjs";

const repoRoot = new URL("../", import.meta.url);
const ciWorkflowPath = new URL(".github/workflows/ci.yml", repoRoot);
const dockerWorkflowPath = new URL(".github/workflows/docker.yml", repoRoot);
const nixWorkflowPath = new URL(".github/workflows/nix.yml", repoRoot);
const filtersPath = new URL(".github/ci-paths.yml", repoRoot);
const serverTsconfigPath = new URL("packages/server/tsconfig.server.json", repoRoot);
const desktopPackagePath = new URL("packages/desktop/package.json", repoRoot);

// FORK(ci): required checks follow this fork's normal/full coverage policy.
const gatedCiJobs = new Map([
  ["quality", { name: "quality", contracts: ["format", "quality", "relay", "sdk"] }],
  ["typecheck", { name: "typecheck", contract: "quality" }],
  ["server-tests-ubuntu", { name: "server-tests (ubuntu-latest)", contracts: ["server", "hub"] }],
  [
    "server-tests-macos",
    {
      name: "server-tests (macos-latest, file observation)",
      contract: "file_observation",
      fullOnly: true,
    },
  ],
  ["desktop-tests-ubuntu", { name: "desktop-tests (ubuntu-latest)", contract: "desktop" }],
  ["website-tests", { name: "website-tests", contract: "website", fullOnly: true }],
  ["playwright-smoke", { name: "playwright (smoke)", contract: "browser" }],
  ["app-tests", { name: "app-tests", contract: "app" }],
  ["playwright-1", { name: "playwright (shard 1/8)", contracts: [], fullOnly: true }],
  ["playwright-2", { name: "playwright (shard 2/8)", contracts: [], fullOnly: true }],
  ["playwright-3", { name: "playwright (shard 3/8)", contracts: [], fullOnly: true }],
  ["playwright-4", { name: "playwright (shard 4/8)", contracts: [], fullOnly: true }],
  ["playwright-5", { name: "playwright (shard 5/8)", contracts: [], fullOnly: true }],
  ["playwright-6", { name: "playwright (shard 6/8)", contracts: [], fullOnly: true }],
  ["playwright-7", { name: "playwright (shard 7/8)", contracts: [], fullOnly: true }],
  ["playwright-8", { name: "playwright (shard 8/8)", contracts: [], fullOnly: true }],
  ["cli-tests-1", { name: "cli-tests (shard 1/3)", contract: "cli_e2e", noAll: true }],
  ["cli-tests-2", { name: "cli-tests (shard 2/3)", contract: "cli_e2e", noAll: true }],
  ["cli-tests-3", { name: "cli-tests (shard 3/3)", contract: "cli" }],
]);

function jobBlocks(source) {
  const jobs = new Map();
  let currentJob;

  for (const line of (source.split("\njobs:\n")[1] ?? source).split("\n")) {
    const jobMatch = /^  ([a-z0-9_-]+):\s*$/.exec(line);
    if (jobMatch) {
      currentJob = jobMatch[1];
      jobs.set(currentJob, []);
      continue;
    }
    if (currentJob) jobs.get(currentJob).push(line);
  }
  return jobs;
}

function loadFilters(path) {
  const filters = {};
  let currentFilter;

  for (const line of readFileSync(path, "utf8").split("\n")) {
    const filterMatch = /^([a-z_]+):\s*$/.exec(line);
    if (filterMatch) {
      currentFilter = filterMatch[1];
      filters[currentFilter] = [];
      continue;
    }
    const patternMatch = /^  - "([^"]+)"\s*$/.exec(line);
    if (currentFilter && patternMatch) filters[currentFilter].push(patternMatch[1]);
  }
  return filters;
}

function filesUnder(relativeDirectory, predicate) {
  const directory = new URL(`${relativeDirectory}/`, repoRoot);
  return readdirSync(directory, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) =>
      [relativeDirectory, relativePath(directory.pathname, entry.parentPath), entry.name]
        .filter(Boolean)
        .join("/")
        .replaceAll("\\", "/"),
    )
    .filter(predicate)
    .sort();
}

test("gated checks are statically named jobs with real job-level gating", () => {
  const workflowSource = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(workflowSource);
  const trigger = workflowSource.split("jobs:", 1)[0];

  assert.match(trigger, /^\s+merge_group:\s*$/m);
  assert.doesNotMatch(workflowSource, /strategy:\s*\n\s+matrix:/);
  assert.doesNotMatch(workflowSource, /RUN_TESTS|Skip unaffected|No .* changes detected/);

  for (const [jobId, expected] of gatedCiJobs) {
    const job = jobs.get(jobId)?.join("\n");
    assert.ok(job, `missing static job ${jobId}`);
    assert.match(job, new RegExp(`^    name: ${expected.name.replace(/[()]/g, "\\$&")}$`, "m"));
    if (!expected.noAll) {
      assert.match(
        job,
        expected.fullOnly
          ? /needs\.changes\.outputs\.full == 'true'/
          : /needs\.changes\.outputs\.all != 'false'/,
      );
    }
    for (const contract of expected.contracts ?? [expected.contract]) {
      assert.match(
        job,
        new RegExp(
          `needs\\.changes\\.outputs\\.${contract} ${expected.noAll ? "== 'true'" : "!= 'false'"}`,
        ),
      );
    }
  }
});

test("pull-request checks run for every base branch, including stacked PRs", () => {
  for (const workflowPath of [
    ciWorkflowPath,
    new URL(".github/workflows/desktop-packages.yml", repoRoot),
  ]) {
    const trigger = readFileSync(workflowPath, "utf8").split("jobs:", 1)[0];
    const pullRequest = trigger.match(/^  pull_request:\n((?:    .*\n)*)/m);
    assert.ok(pullRequest, `${workflowPath.pathname} runs on pull requests`);
    assert.doesNotMatch(pullRequest[1], /branches/);
  }
});

test("change gating allows superseded workflow runs to cancel", () => {
  const ci = readFileSync(ciWorkflowPath, "utf8");
  assert.match(
    ci,
    /^concurrency:\n  group: ci-\$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\n  cancel-in-progress: true$/m,
    "a newer push to any ref, main included, cancels the superseded run",
  );
  for (const workflowPath of [ciWorkflowPath, dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    assert.doesNotMatch(
      source,
      /\$\{\{\s*always\(\)/,
      "always() keeps jobs alive after concurrency cancellation; use !cancelled() for fail-open gating",
    );
  }
});

test("published npm packages declare and ship the repository license", () => {
  const rootManifest = JSON.parse(readFileSync(new URL("package.json", repoRoot), "utf8"));
  assert.match(rootManifest.scripts["release:publish"], /scripts\/publish-release-packages\.mjs/);
  const workspaceArgs = PUBLISH_WORKSPACES.map((workspace) => `--workspace=${workspace}`);
  const packed = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--ignore-scripts", "--json", ...workspaceArgs], {
      cwd: repoRoot,
      encoding: "utf8",
    }),
  );
  const manifests = new Map(
    rootManifest.workspaces.map((workspace) => {
      const directory = new URL(`${workspace}/`, repoRoot);
      const manifest = JSON.parse(readFileSync(new URL("package.json", directory), "utf8"));
      return [manifest.name, { directory, manifest }];
    }),
  );
  const licenses = packed.map(({ name, files }) => ({
    name,
    license: manifests.get(name).manifest.license,
    files: files.filter((file) => file.path === "LICENSE").map((file) => file.path),
  }));
  assert.deepEqual(
    licenses,
    PUBLISH_WORKSPACES.map((workspace) => ({
      name: workspace,
      license: "Apache-2.0",
      files: ["LICENSE"],
    })),
  );
  const repositoryLicense = readFileSync(new URL("LICENSE", repoRoot), "utf8");
  for (const { name } of packed) {
    const { directory } = manifests.get(name);
    assert.equal(readFileSync(new URL("LICENSE", directory), "utf8"), repositoryLicense, name);
  }
});

test("focused contracts stay inside existing required checks", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const changes = jobs.get("changes")?.join("\n") ?? "";
  const server = jobs.get("server-tests-ubuntu")?.join("\n") ?? "";
  const desktop = jobs.get("desktop-tests-ubuntu")?.join("\n") ?? "";

  assert.match(changes, /scripts\/daemon-launch-contract\.test\.mjs/);
  assert.doesNotMatch(changes, /Install dependencies|npm run build/);

  assert.match(server, /test:hub-cli-contract/);
  assert.match(server, /npm run test:unit --workspace=@getpaseo\/server/);
  assert.ok(!jobs.has("hub-cli-contract"));

  assert.match(desktop, /test:e2e:renderer/);
  assert.match(desktop, /test:e2e:browser-tabs/);
  assert.match(desktop, /npm run test --workspace=@getpaseo\/desktop/);
  assert.ok(!jobs.has("desktop-browser-bridge"));
  assert.ok(!jobs.has("playwright-desktop"));
});

test("ordinary CI keeps app tests without prebuilding Android modules", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const app = jobBlocks(source).get("app-tests").join("\n");
  assert.match(app, /npm run build:app-deps/);
  assert.match(app, /npm run test --workspace=@getpaseo\/app/);
  assert.doesNotMatch(source, /test:android|expo prebuild|gradlew|actions\/setup-java/);
});

test("server builds exclude test utilities at every domain depth", () => {
  const tsconfig = JSON.parse(readFileSync(serverTsconfigPath, "utf8"));
  assert.ok(tsconfig.exclude.includes("src/server/**/test-utils/**"));
  assert.ok(!tsconfig.exclude.includes("src/server/test-utils/**"));
});

test("PR routing declares stable behavior ownership", () => {
  const filters = loadFilters(filtersPath);
  assert.deepEqual(filters, {
    routing: [".github/ci-paths.yml"],
    workspace: [
      ".mise.toml",
      ".tool-versions",
      "package.json",
      "package-lock.json",
      "patches/**",
      "scripts/**",
      "tsconfig.json",
      "tsconfig.base.json",
      "vitest.config.ts",
    ],
    ci: [".github/actions/**", ".github/workflows/ci.yml"],
    format: [
      ".agents/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      ".github/**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "**/*.{cjs,css,html,js,json,jsonc,jsx,md,mjs,ts,tsx,yaml,yml}",
      "packages/expo-two-way-audio/**",
    ],
    quality: ["**/*.{cjs,js,json,jsx,mjs,ts,tsx}", "packages/expo-two-way-audio/**"],
    hub: ["packages/cli/src/commands/hub/**", "packages/server/src/server/hub/**"],
    server: ["plugins/**", "packages/server/**", "packages/app/e2e/support/fixtures/recording.*"],
    desktop: [
      "packages/desktop/**",
      "packages/app/src/desktop/**",
      "packages/app/src/**/*.electron.{ts,tsx}",
      "packages/server/src/server/browser-tools/**",
      "packages/app/e2e/support/**",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    app: ["packages/app/**", "packages/expo-two-way-audio/**"],
    sdk: [
      "packages/plugin/**",
      "plugin-examples/**",
      "public-docs/plugins/**",
      "packages/client/**",
      "packages/highlight/**",
      "packages/protocol/**",
    ],
    browser: [
      "packages/server/src/server/agent/provider-snapshot-manager.ts",
      "packages/server/src/server/session/provider/provider-catalog-session.ts",
      "packages/client/src/compat/normalize-provider-models.ts",
      "packages/protocol/src/client-capabilities.ts",
      "packages/server/src/server/agent/provider-registry.ts",
      "packages/server/src/server/agent/agent-sdk-types.ts",
      "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
      "packages/server/src/server/agent/providers/claude/agent.ts",
      "packages/server/src/server/agent/plugin-provider.ts",
      "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
      "packages/server/src/executable-resolution/**",
      "packages/plugin/src/server/provider.ts",
      "packages/app/src/!(desktop)/**",
      "packages/app/e2e/browser/**",
      "packages/app/e2e/support/**",
      "packages/app/assets/**",
      "packages/app/public/**",
      "packages/app/index.ts",
      "packages/app/*config.{cjs,js,ts}",
      "packages/app/package.json",
    ],
    relay: ["packages/relay/**"],
    cli: ["packages/cli/**"],
    website: [
      "packages/website/**",
      "public-docs/**",
      "packages/protocol/**",
      "package.json",
      "package-lock.json",
      "patches/**",
      ".github/workflows/ci.yml",
    ],
    file_observation: [
      "packages/server/src/server/file-observer/**",
      "packages/server/src/server/workspace-git-service*",
      "packages/server/src/server/watcher-liveness-canary*",
      "packages/server/vitest.config.ts",
    ],
  });
});

test("cross-package invariants live in the suite that owns them", () => {
  const cliTests = filesUnder("packages/cli", (path) => path.endsWith(".test.ts"));
  assert.ok(cliTests.length > 0);
  for (const path of cliTests) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /server\/src\/server\/test-utils/,
      path,
    );
  }

  const protocolWireCompatibility = new URL(
    "packages/protocol/src/messages.wire-compat.test.ts",
    repoRoot,
  );
  assert.match(readFileSync(protocolWireCompatibility, "utf8"), /wire schema compatibility/);
});

test("browser and desktop tests have exclusive, directory-owned suites", () => {
  const filters = loadFilters(filtersPath);
  const browserSpecs = filesUnder("packages/app/e2e", (path) => path.endsWith(".spec.ts"));
  const desktopSpecs = filesUnder("packages/desktop/e2e", (path) => path.endsWith(".spec.ts"));

  assert.ok(browserSpecs.length > 0);
  assert.ok(desktopSpecs.length > 0);
  assert.ok(browserSpecs.every((path) => path.startsWith("packages/app/e2e/browser/")));
  assert.ok(desktopSpecs.every((path) => path.startsWith("packages/desktop/e2e/")));

  const desktopPackage = JSON.parse(readFileSync(desktopPackagePath, "utf8"));
  assert.match(desktopPackage.scripts.test, /--exclude ["']e2e\/\*\*["']/);

  for (const path of browserSpecs) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /paseoDesktop|injectDesktopBridge/,
    );
  }
  for (const path of desktopSpecs) {
    assert.ok(path.startsWith("packages/desktop/e2e/"));
  }

  const routingSource = readFileSync(filtersPath, "utf8");
  assert.doesNotMatch(routingSource, /desktop_bridge|playwright_desktop|browser-\*|browser-\*\//);
  assert.deepEqual(filters.desktop, [
    "packages/desktop/**",
    "packages/app/src/desktop/**",
    "packages/app/src/**/*.electron.{ts,tsx}",
    "packages/server/src/server/browser-tools/**",
    "packages/app/e2e/support/**",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
  assert.deepEqual(filters.browser, [
    "packages/server/src/server/agent/provider-snapshot-manager.ts",
    "packages/server/src/server/session/provider/provider-catalog-session.ts",
    "packages/client/src/compat/normalize-provider-models.ts",
    "packages/protocol/src/client-capabilities.ts",
    "packages/server/src/server/agent/provider-registry.ts",
    "packages/server/src/server/agent/agent-sdk-types.ts",
    "packages/server/src/server/agent/providers/codex-app-server-agent.ts",
    "packages/server/src/server/agent/providers/claude/agent.ts",
    "packages/server/src/server/agent/plugin-provider.ts",
    "packages/server/src/server/plugins/{index,plugin-process,plugin-process-protocol,runtime}.ts",
    "packages/server/src/executable-resolution/**",
    "packages/plugin/src/server/provider.ts",
    "packages/app/src/!(desktop)/**",
    "packages/app/e2e/browser/**",
    "packages/app/e2e/support/**",
    "packages/app/assets/**",
    "packages/app/public/**",
    "packages/app/index.ts",
    "packages/app/*config.{cjs,js,ts}",
    "packages/app/package.json",
  ]);
});

test("packaging runs on main without allocating pull-request runners", () => {
  for (const workflowPath of [dockerWorkflowPath, nixWorkflowPath]) {
    const source = readFileSync(workflowPath, "utf8");
    const trigger = source.split("jobs:", 1)[0];
    assert.match(trigger, /push:\s*\n\s+branches: \[main\]/);
    assert.doesNotMatch(trigger, /pull_request/);
    assert.doesNotMatch(source, /dorny\/paths-filter/);
  }
  const docker = readFileSync(dockerWorkflowPath, "utf8");
  assert.match(
    docker,
    /group: docker-\$\{\{ github\.workflow \}\}-\$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.publish == 'true' && format\('publish-\{0\}', inputs\.paseo_version \|\| github\.run_id\) \|\| github\.ref \}\}/,
    "manual Docker release retries use their own concurrency group so main pushes never cancel them",
  );
  assert.match(
    docker,
    /cancel-in-progress: \$\{\{ !startsWith\(github\.ref, 'refs\/tags\/'\) && !\(github\.event_name == 'workflow_dispatch' && inputs\.publish == 'true'\) \}\}/,
    "Docker cancels superseded non-tag main checks while preserving tag and manual publish runs",
  );
  const nix = readFileSync(nixWorkflowPath, "utf8");
  assert.match(nix.split("jobs:", 1)[0], /^\s+workflow_dispatch:/m);
});

test("CI and desktop packaging verify release branches isolated from main traffic", () => {
  const ciTrigger = readFileSync(ciWorkflowPath, "utf8").split("jobs:", 1)[0];
  assert.match(ciTrigger, /push:\s*\n\s+branches: \[paseo-customizations, "release\/\*\*"\]/);

  const source = readFileSync(new URL(".github/workflows/desktop-packages.yml", repoRoot), "utf8");
  const trigger = source.split("jobs:", 1)[0];
  assert.match(trigger, /push:\s*\n\s+branches: \[main, "release\/\*\*"\]/);
  assert.match(trigger, /^\s+workflow_dispatch:/m);
  assert.match(trigger, /pull_request:\s*\n\s+paths:/);
  assert.match(trigger, /- "packages\/desktop\/\*\*"/);
  assert.match(trigger, /^\s+cancel-in-progress: true$/m);
  assert.doesNotMatch(source, /dorny\/paths-filter/);
  for (const action of ["actions/checkout", "actions/setup-node", "actions/upload-artifact"]) {
    assert.match(source, new RegExp(`${action}@[0-9a-f]{40} # v\\d+\\.\\d+\\.\\d+`));
  }
});

test("stable iOS releases upload once and distribute to external testers before App Store review", () => {
  const source = readFileSync(
    new URL("packages/app/.eas/workflows/release-mobile.yml", repoRoot),
    "utf8",
  );
  const jobs = jobBlocks(source);
  const uploads = [...jobs.entries()].filter(
    ([, lines]) =>
      lines.some((line) => /^    type: (submit|testflight)$/.test(line)) &&
      lines.some((line) => line.includes("needs.build_ios.outputs.build_id")),
  );
  assert.equal(uploads.length, 1, "the iOS binary must be uploaded exactly once");
  const [distributionId, distributionLines] = uploads[0];
  const distribution = distributionLines.join("\n");
  assert.match(distribution, /^    type: testflight$/m);
  assert.match(distribution, /external_groups:\s*\n\s+- Paseo Beta/);
  assert.match(distribution, /^      submit_beta_review: true$/m);

  const review = jobs.get("submit_ios_for_review").join("\n");
  assert.match(review, new RegExp(`needs: \\[build_ios, ${distributionId}\\]`));
  assert.match(review, /APP_VERSION="\$\{\{ needs\.build_ios\.outputs\.app_version \}\}"/);
  assert.match(
    review,
    /APP_BUILD_VERSION="\$\{\{ needs\.build_ios\.outputs\.app_build_version \}\}"/,
  );
  assert.match(review, /bundle exec fastlane ios submit_review/);
});

test("eight Playwright shards share two-worker coverage", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  assert.equal(jobs.size, 20);
  for (let shard = 1; shard <= 8; shard++) {
    const job = jobs.get(`playwright-${shard}`).join("\n");
    assert.match(job, new RegExp(`PLAYWRIGHT_SHARD: "${shard}/8"`));
    assert.match(job, new RegExp(`PLAYWRIGHT_ARTIFACT: "${shard}"`));
    assert.match(job, /steps: \*playwright_test_steps/);
  }
  const shared = jobs.get("playwright-smoke").join("\n");
  assert.match(shared, /E2E_WORKERS: "2"/);
  const weights = /PWTEST_SHARD_WEIGHTS: "([\d:]+)"/.exec(shared)[1].split(":").map(Number);
  assert.equal(weights.length, 8);
  assert.ok(weights.every((weight) => weight > 0));
  assert.match(shared, /npm run test:e2e --workspace=@getpaseo\/app -- --shard=/);

  // No fan-in result job: a gate needs its own runner and under contention it
  // queued 8m08s behind the last shard. Required checks name the shards directly.
  assert.equal(jobs.has("playwright"), false);
});

test("quality preserves commands and routes each domain independently after failures", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const quality = jobs.get("quality").join("\n");
  assert.doesNotMatch(quality, /^\s+continue-on-error:/m);
  const commands = {
    format: ["npm run format:check"],
    quality: [
      "npx --yes lockfile-lint --path package-lock.json --type npm --allowed-hosts npm --validate-https --validate-integrity",
      "npm audit signatures",
      "npm run lint",
      "node --test scripts/oxlint/paseo-plugin.test.mjs",
    ],
    relay: ["npm run build:relay", "npm run test --workspace=@getpaseo/relay"],
    sdk: [
      "npm run build:relay && npm run build:client",
      "npm run build:plugin",
      "npm run test --workspace=@getpaseo/plugin",
      "npm run test --workspace=@getpaseo/protocol",
      "npm run test --workspace=@getpaseo/client",
      "npm run test --workspace=@getpaseo/highlight",
      "npm run typecheck:examples --workspace=@getpaseo/client",
    ],
  };
  const checks = [...quality.matchAll(/        if: \$\{\{ (.+) \}\}\n        run: (.+)/g)];
  assert.deepEqual(
    checks.map(([, , command]) => command),
    Object.values(commands).flat(),
  );
  const domains = Object.keys(commands);
  function accepts(expression, outputs, { cancelled = false, installed = true } = {}) {
    // Prior checks have failed: success() is false. Explicit !cancelled() must
    // override Actions' default success condition so later domains still run.
    assert.match(expression, /!cancelled\(\)/);
    return runInNewContext(expression, {
      needs: { changes: { outputs } },
      steps: { install: { outcome: installed ? "success" : "failure" } },
      cancelled: () => cancelled,
      success: () => false,
    });
  }
  const disabled = { all: "false", ...Object.fromEntries(domains.map((key) => [key, "false"])) };
  const jobCondition = /    if: \$\{\{ (.+) \}\}/.exec(quality)[1];
  assert.equal(accepts(jobCondition, disabled), false);
  for (const selected of domains) {
    const outputs = { ...disabled, [selected]: "true" };
    assert.equal(accepts(jobCondition, outputs), true);
    for (const [, expression, command] of checks) {
      assert.equal(accepts(expression, outputs), commands[selected].includes(command), command);
    }
  }
  for (const [, expression] of checks) {
    assert.equal(accepts(expression, { ...disabled, all: "true" }), true);
    assert.equal(accepts(expression, {}), true, "missing routing outputs fail open");
    assert.equal(accepts(expression, {}, { cancelled: true }), false);
    assert.equal(accepts(expression, {}, { installed: false }), false);
  }
  assert.equal(accepts(jobCondition, {}, { cancelled: true }), false);
});

function expressionValue(expression, context) {
  return runInNewContext(expression.replace(/^\$\{\{ | \}\}$/g, ""), context);
}

function jobSelected(job, outputs, cancelled = false) {
  const expression = /    if: (.+)/.exec(job.join("\n"))[1];
  return expressionValue(expression, {
    needs: { changes: { outputs } },
    cancelled: () => cancelled,
  });
}

test("fork modes select smoke or full coverage without Windows runners", () => {
  const source = readFileSync(ciWorkflowPath, "utf8");
  const jobs = jobBlocks(source);
  assert.match(source, /branches: \[paseo-customizations, "release\/\*\*"\]/);
  assert.match(source, /default: normal\n\s+options: \[normal, full\]/);
  assert.doesNotMatch(source, /windows-latest|runner.os == 'Windows'/);
  const outputs = Object.fromEntries(
    [...source.matchAll(/^      (\w+): \$\{\{ (.+) \}\}$/gm)].map(([, key, expression]) => [
      key,
      expression,
    ]),
  );
  const filters = Object.fromEntries(
    Object.keys(loadFilters(filtersPath)).map((key) => [key, "false"]),
  );
  const context = (event, mode, changed = {}, ref = "refs/heads/paseo-customizations") => ({
    inputs: { mode },
    github: { event_name: event, ref },
    startsWith: (value, prefix) => value.startsWith(prefix),
    steps: { filter: { outputs: { ...filters, ...changed } } },
  });
  function route(event, mode, changed, ref) {
    const state = context(event, mode, changed, ref);
    return Object.fromEntries(
      Object.entries(outputs).map(([key, expression]) => [
        key,
        String(expressionValue(expression, state)),
      ]),
    );
  }
  const normal = route("workflow_dispatch", "normal");
  const full = route("workflow_dispatch", "full");
  assert.deepEqual(route("push", undefined, {}, "refs/heads/release/0.17.0"), full);
  for (const id of [
    "quality",
    "typecheck",
    "app-tests",
    "server-tests-ubuntu",
    "desktop-tests-ubuntu",
    "cli-tests-3",
  ]) {
    assert.equal(jobSelected(jobs.get(id), normal), true, id);
  }
  assert.equal(jobSelected(jobs.get("playwright-smoke"), normal), true);
  assert.equal(jobSelected(jobs.get("playwright-smoke"), full), false);
  for (let shard = 1; shard <= 8; shard++) {
    assert.equal(jobSelected(jobs.get(`playwright-${shard}`), normal), false);
    assert.equal(jobSelected(jobs.get(`playwright-${shard}`), full), true);
  }
  for (const id of ["cli-tests-1", "cli-tests-2", "website-tests", "server-tests-macos"]) {
    assert.equal(jobSelected(jobs.get(id), normal), false, id);
    assert.equal(jobSelected(jobs.get(id), full), true, id);
  }
  assert.equal(normal.integration, "false");
  assert.equal(normal.desktop_e2e, "false");
  assert.equal(full.integration, "true");
  assert.equal(full.desktop_e2e, "true");
  const app = route("pull_request", "", {
    app: "true",
    browser: "true",
    quality: "true",
    format: "true",
  });
  assert.equal(jobSelected(jobs.get("playwright-smoke"), app), true);
  assert.equal(jobSelected(jobs.get("server-tests-ubuntu"), app), false);
  assert.equal(app.integration, "false");
  assert.equal(app.cli_e2e, "false");
  assert.equal(app.desktop_e2e, "false");
  for (const event of ["push", "pull_request"]) {
    const server = route(event, "", { server: "true" });
    assert.equal(server.integration, "true");
    assert.equal(jobSelected(jobs.get("server-tests-ubuntu"), server), true);
    const cli = route(event, "", { cli: "true" });
    assert.equal(jobSelected(jobs.get("cli-tests-1"), cli), true);
    assert.equal(jobSelected(jobs.get("cli-tests-2"), cli), true);
    assert.equal(route(event, "", { desktop: "true" }).desktop_e2e, "true");
  }
  const shared = route("pull_request", "", { workspace: "true" });
  assert.equal(jobSelected(jobs.get("app-tests"), shared), true);
  assert.equal(jobSelected(jobs.get("playwright-smoke"), shared), true);
  assert.equal(shared.integration, "false");
  for (const [id, job] of jobs) {
    if (id !== "changes") {
      assert.equal(jobSelected(job, full), id !== "playwright-smoke", id);
      assert.equal(jobSelected(job, full, true), false, id);
    }
  }
});

test("normal and full steps preserve integration, desktop, website and CLI coverage", () => {
  const jobs = jobBlocks(readFileSync(ciWorkflowPath, "utf8"));
  const server = jobs.get("server-tests-ubuntu").join("\n");
  assert.match(server, /run: npm run test:unit --workspace=@getpaseo\/server/);
  assert.match(
    server,
    /Run server integration tests\n\s+if: \$\{\{ needs.changes.outputs.integration == 'true' \}\}\n\s+run: npm run test:integration/,
  );
  const desktop = jobs.get("desktop-tests-ubuntu").join("\n");
  for (const name of ["renderer", "browser"]) {
    assert.match(desktop, new RegExp(`Run desktop ${name} E2E\\n\\s+if: .*desktop_e2e == 'true'`));
  }
  const typecheck = jobs.get("typecheck").join("\n");
  assert.doesNotMatch(typecheck, /website|playwright install/);
  const website = jobs.get("website-tests").join("\n");
  assert.match(website, /vitest run packages\/website\/src/);
  assert.match(website, /playwright install --with-deps chromium webkit/);
  assert.match(website, /test:e2e --workspace=@getpaseo\/website/);
  const cli = jobs.get("cli-tests-1").join("\n");
  assert.match(cli, /Run CLI E2E tests\n\s+if: .*cli_e2e == 'true'/);
  assert.match(cli, /Build CLI unit dependencies\n\s+if: .*cli_e2e != 'true'/);
  assert.match(cli, /Run CLI source tests\n\s+if: .*PASEO_CLI_TEST_SHARD == '3'/);
});

test("browser smoke selects existing deterministic journeys", () => {
  const manifest = JSON.parse(readFileSync(new URL("packages/app/package.json", repoRoot), "utf8"));
  const command = manifest.scripts["test:e2e:smoke"];
  assert.match(command, /^playwright test --project=browser /);
  const specs = command.split(" ").slice(3);
  assert.equal(specs.length, 10);
  for (const spec of specs) {
    assert.match(spec, /^e2e\/browser\/[a-z-]+\.spec\.ts$/);
    assert.doesNotMatch(spec, /\.real\./);
    assert.ok(readFileSync(new URL(`packages/app/${spec}`, repoRoot), "utf8").includes("test"));
  }
});

test("local full verification covers the fork with bounded workers", () => {
  const result = spawnSync(process.execPath, ["scripts/verify-local.mjs", "--list"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  const names = new Set(plan.map((step) => step.name));
  for (const name of [
    "typecheck",
    "lint",
    "format:check",
    "script-contracts",
    "server-units",
    "server-integration",
    "cli-units",
    "cli-e2e",
    "website-browser",
    "app-browser",
    "app-tests",
    "desktop-lifecycle",
    "desktop-renderer",
    "desktop-browser-tabs",
  ]) {
    assert.ok(names.has(name), name);
  }
  for (const step of plan.filter(
    (entry) => entry.name.endsWith("-tests") || entry.name.endsWith("-units"),
  )) {
    assert.ok(step.args.includes("--maxWorkers=1"), step.name);
  }
  assert.ok(plan.find((step) => step.name === "app-browser").args.includes("--workers=1"));
});

test("local verification serializes stages, records failures and releases its machine lock", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-verification-test-"));
  const fakeNpm = join(directory, "npm.cjs");
  const trace = join(directory, "trace.json");
  let evidence;
  try {
    writeFileSync(
      fakeNpm,
      `const fs = require("node:fs");
const path = process.env.LOCAL_TEST_TRACE;
const rows = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path)) : [];
rows.push({ args: process.argv.slice(2), workers: process.env.E2E_WORKERS, cli: process.env.PASEO_CLI_TEST_CONCURRENCY, shard: process.env.PASEO_CLI_TEST_SHARD_TOTAL, ci: process.env.CI });
fs.writeFileSync(path, JSON.stringify(rows));
console.log("stage fixture");
process.exit(rows.length === 3 ? 7 : 0);
`,
    );
    const result = spawnSync(process.execPath, ["scripts/verify-local.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        TMPDIR: directory,
        npm_execpath: fakeNpm,
        LOCAL_TEST_TRACE: trace,
        CI: "true",
        E2E_WORKERS: "32",
        PASEO_CLI_TEST_SHARD_TOTAL: "8",
      },
    });
    assert.equal(result.status, 1, result.stdout + result.stderr);
    evidence = /Full local verification: (.+)/.exec(result.stdout)[1];
    const rows = JSON.parse(readFileSync(trace, "utf8"));
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => row.args[1]),
      ["build:protocol", "build:client", "build:highlight"],
    );
    assert.ok(
      rows.every(
        (row) =>
          row.workers === "1" && row.cli === "1" && row.shard === "1" && row.ci === undefined,
      ),
    );
    const report = JSON.parse(readFileSync(join(evidence, "summary.json"), "utf8"));
    assert.match(report.commit, /^[a-f0-9]{40}$/);
    assert.deepEqual(
      report.steps.map((step) => step.code),
      [0, 0, 7],
    );
    assert.match(readFileSync(report.steps[2].log, "utf8"), /stage fixture/);
    assert.equal(
      readdirSync(directory).some((name) => name.endsWith(".lock")),
      false,
    );
  } finally {
    if (evidence) rmSync(evidence, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("local verification refuses a second full run before starting any suite", () => {
  const directory = mkdtempSync(join(tmpdir(), "local-verification-lock-test-"));
  try {
    mkdirSync(join(directory, `paseo-full-verification-${process.getuid()}.lock`));
    const result = spawnSync(process.execPath, ["scripts/verify-local.mjs"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, TMPDIR: directory, npm_execpath: "unused" },
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Another full verification owns/);
    assert.doesNotMatch(result.stdout, /Full local verification:/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("desktop release creates release-manifests before entering it and uses the xcrun retry script", () => {
  const workflow = readFileSync(new URL(".github/workflows/desktop-release.yml", repoRoot), "utf8");
  assert.match(workflow, /scripts\/macos-xcrun-retry\.sh/);
  assert.match(workflow, /mkdir -p release-manifests\s*\n\s+cd release-manifests/);
});

test("macOS release xcrun wrapper retries transient stapling and notarization failures without rebuilding", async (t) => {
  const wrapperSource = readFileSync(new URL("scripts/macos-xcrun-retry.sh", repoRoot), "utf8");
  const networkLostError =
    'Error Domain=NSURLErrorDomain Code=-1005 "The network connection was lost."';
  const notaryTimeoutWithId =
    'Error: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1001 "The request timed out." UserInfo={NSErrorFailingURLStringKey=https://appstoreconnect.apple.com/notary/v2/submissions/ee2872f3-65d9-49f7-b2b5-adcdfe2db6ba?})';
  const notaryOfflineWithId =
    'Error: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1009 "The Internet connection appears to be offline." UserInfo={NSErrorFailingURLStringKey=https://appstoreconnect.apple.com/notary/v2/submissions/ee2872f3-65d9-49f7-b2b5-adcdfe2db6ba?})';
  const notaryUploadTimeout =
    'Error: HTTPError(statusCode: nil, error: Error Domain=NSURLErrorDomain Code=-1001 "The request timed out.")';
  const acceptedJson = JSON.stringify({
    id: "ee2872f3-65d9-49f7-b2b5-adcdfe2db6ba",
    message: "Successfully received submission info",
    status: "Accepted",
  });
  const invalidJson = JSON.stringify({
    id: "ee2872f3-65d9-49f7-b2b5-adcdfe2db6ba",
    message: "Submission invalid",
    status: "Invalid",
  });

  const cases = [
    {
      name: "stapler success",
      steps: [{ code: 0, output: "stapled" }],
      args: ["stapler", "staple", "-v", "Paseo signed.app"],
      expected: 0,
      expectedCalls: [["stapler", "staple", "-v", "Paseo signed.app"]],
      expectPattern: /stapled/,
    },
    {
      name: "stapler transient then success",
      steps: [
        { code: 68, output: networkLostError },
        { code: 0, output: "stapled" },
      ],
      args: ["stapler", "staple", "-v", "Paseo signed.app"],
      expected: 0,
      expectedCalls: [
        ["stapler", "staple", "-v", "Paseo signed.app"],
        ["stapler", "staple", "-v", "Paseo signed.app"],
      ],
      expectPattern: /stapled/,
    },
    {
      name: "stapler exhausted network retries",
      steps: [
        { code: 68, output: networkLostError },
        { code: 68, output: networkLostError },
        { code: 68, output: networkLostError },
        { code: 68, output: networkLostError },
      ],
      args: ["stapler", "staple", "-v", "Paseo signed.app"],
      expected: 68,
      expectedCalls: Array.from({ length: 4 }, () => [
        "stapler",
        "staple",
        "-v",
        "Paseo signed.app",
      ]),
      expectPattern: /network connection was lost/,
    },
    {
      name: "stapler non-network error is not retried",
      steps: [{ code: 68, output: "ticket not found" }],
      args: ["stapler", "staple", "-v", "Paseo signed.app"],
      expected: 68,
      expectedCalls: [["stapler", "staple", "-v", "Paseo signed.app"]],
      expectPattern: /ticket not found/,
    },
    {
      name: "notarytool switches to wait when polling fails after upload and emits clean JSON",
      steps: [
        { code: 1, output: notaryTimeoutWithId },
        { code: 1, output: notaryOfflineWithId },
        { code: 0, output: acceptedJson },
      ],
      args: [
        "notarytool",
        "submit",
        "/tmp/Paseo.zip",
        "--apple-id",
        "id",
        "--password",
        "pw",
        "--team-id",
        "team",
        "--wait",
        "--output-format",
        "json",
      ],
      expected: 0,
      expectedCalls: [
        [
          "notarytool",
          "submit",
          "/tmp/Paseo.zip",
          "--apple-id",
          "id",
          "--password",
          "pw",
          "--team-id",
          "team",
          "--wait",
          "--output-format",
          "json",
        ],
        [
          "notarytool",
          "wait",
          "ee2872f3-65d9-49f7-b2b5-adcdfe2db6ba",
          "--apple-id",
          "id",
          "--password",
          "pw",
          "--team-id",
          "team",
          "--output-format",
          "json",
        ],
        [
          "notarytool",
          "wait",
          "ee2872f3-65d9-49f7-b2b5-adcdfe2db6ba",
          "--apple-id",
          "id",
          "--password",
          "pw",
          "--team-id",
          "team",
          "--output-format",
          "json",
        ],
      ],
      expectCleanJson: true,
    },
    {
      name: "notarytool retries submit when upload fails before submission ID exists",
      steps: [
        { code: 1, output: notaryUploadTimeout },
        { code: 0, output: acceptedJson },
      ],
      args: [
        "notarytool",
        "submit",
        "/tmp/Paseo.zip",
        "--apple-id",
        "id",
        "--wait",
        "--output-format",
        "json",
      ],
      expected: 0,
      expectedCalls: [
        [
          "notarytool",
          "submit",
          "/tmp/Paseo.zip",
          "--apple-id",
          "id",
          "--wait",
          "--output-format",
          "json",
        ],
        [
          "notarytool",
          "submit",
          "/tmp/Paseo.zip",
          "--apple-id",
          "id",
          "--wait",
          "--output-format",
          "json",
        ],
      ],
      expectCleanJson: true,
    },
    {
      name: "notarytool deterministic Invalid rejection is never retried",
      steps: [{ code: 0, output: invalidJson }],
      args: [
        "notarytool",
        "submit",
        "/tmp/Paseo.zip",
        "--apple-id",
        "id",
        "--wait",
        "--output-format",
        "json",
      ],
      expected: 0,
      expectedCalls: [
        [
          "notarytool",
          "submit",
          "/tmp/Paseo.zip",
          "--apple-id",
          "id",
          "--wait",
          "--output-format",
          "json",
        ],
      ],
      expectCleanJson: true,
    },
    {
      name: "notarytool bad credentials error is never retried",
      steps: [{ code: 1, output: "Error: HTTP status code: 401. Invalid credentials." }],
      args: [
        "notarytool",
        "submit",
        "/tmp/Paseo.zip",
        "--apple-id",
        "id",
        "--wait",
        "--output-format",
        "json",
      ],
      expected: 1,
      expectedCalls: [
        [
          "notarytool",
          "submit",
          "/tmp/Paseo.zip",
          "--apple-id",
          "id",
          "--wait",
          "--output-format",
          "json",
        ],
      ],
      expectPattern: /Invalid credentials/,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, () => {
      const directory = mkdtempSync(join(tmpdir(), "xcrun-retry-"));
      try {
        const statePath = join(directory, "state.json");
        const realXcrun = join(directory, "real-xcrun");
        const wrapperPath = join(directory, "xcrun");
        writeFileSync(wrapperPath, wrapperSource, { mode: 0o755 });
        writeFileSync(join(directory, "sleep"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
        writeFileSync(statePath, JSON.stringify({ steps: scenario.steps, calls: [] }));
        writeFileSync(
          realXcrun,
          `#!/usr/bin/env node
const fs = require("node:fs");
const state = JSON.parse(fs.readFileSync(process.env.XCRUN_STATE, "utf8"));
state.calls.push(process.argv.slice(2));
const next = state.steps.shift();
fs.writeFileSync(process.env.XCRUN_STATE, JSON.stringify(state));
if (!next) process.exit(99);
process.stdout.write(next.output + "\\n");
process.exit(next.code);
`,
          { mode: 0o755 },
        );
        const result = spawnSync("bash", [wrapperPath, ...scenario.args], {
          encoding: "utf8",
          env: {
            ...process.env,
            PASEO_REAL_XCRUN: realXcrun,
            XCRUN_STATE: statePath,
            PATH: `${directory}:${process.env.PATH}`,
          },
          timeout: 5000,
        });
        assert.equal(result.status, scenario.expected, result.stdout + result.stderr);
        const state = JSON.parse(readFileSync(statePath, "utf8"));
        assert.deepEqual(state.calls, scenario.expectedCalls);
        if (scenario.expectCleanJson) {
          // @electron/notarize merges stdout and stderr before calling JSON.parse.
          const parsed = JSON.parse((result.stdout + result.stderr).trim());
          assert.equal(parsed.id, "ee2872f3-65d9-49f7-b2b5-adcdfe2db6ba");
        }
        if (scenario.expectPattern) {
          assert.match(result.stdout + result.stderr, scenario.expectPattern);
        }
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    });
  }
});

// GitHub retires macOS 14 on 2026-11-02; brownouts already reject these jobs.
test("workflows avoid retired macOS 14 runners", () => {
  for (const path of filesUnder(".github/workflows", (candidate) => /\.ya?ml$/.test(candidate))) {
    assert.doesNotMatch(
      readFileSync(new URL(path, repoRoot), "utf8"),
      /macos-14(?:-large|-xlarge)?\b/,
      path,
    );
  }
});

test("macOS jobs use latest runners while preserving release architectures", () => {
  for (const [workflow, jobId] of [
    [ciWorkflowPath, "server-tests-macos"],
    [nixWorkflowPath, "build-desktop-darwin"],
  ]) {
    assert.match(
      jobBlocks(readFileSync(workflow, "utf8")).get(jobId).join("\n"),
      /^    runs-on: macos-latest$/m,
    );
  }
  const release = readFileSync(new URL(".github/workflows/desktop-release.yml", repoRoot), "utf8");
  assert.match(release, /runner: macos-latest\n\s+electron_arch: arm64/);
  // GitHub has no standard macos-latest-intel alias; use the newest Intel image.
  assert.match(release, /runner: macos-26-intel\n\s+electron_arch: x64/);
});

test("Nix desktop packaging resolves the workspace-local builder", () => {
  const source = readFileSync(new URL("nix/desktop-package.nix", repoRoot), "utf8");
  const invocation = source.match(/^\s+([^\n]*electron-builder) \\\n/m)?.[1];
  assert.ok(invocation, "Nix invokes the desktop packaging tool");
  const directory = mkdtempSync(join(tmpdir(), "nix-builder-resolution-"));
  try {
    const desktop = join(directory, "packages/desktop");
    mkdirSync(join(desktop, "node_modules/.bin"), { recursive: true });
    mkdirSync(join(desktop, "node_modules/electron-builder"));
    writeFileSync(
      join(desktop, "node_modules/electron-builder/package.json"),
      JSON.stringify({
        name: "electron-builder",
        version: "1.0.0",
        bin: { "electron-builder": "../.bin/electron-builder" },
      }),
    );
    writeFileSync(
      join(directory, "package.json"),
      JSON.stringify({ private: true, workspaces: ["packages/desktop"] }),
    );
    writeFileSync(
      join(desktop, "package.json"),
      JSON.stringify({
        name: "desktop-fixture",
        private: true,
        devDependencies: { "electron-builder": "1.0.0" },
      }),
    );
    writeFileSync(
      join(desktop, "node_modules/.bin/electron-builder"),
      '#!/bin/sh\nprintf "workspace-builder\\n"\n',
      { mode: 0o755 },
    );
    const result = spawnSync("sh", ["-c", `${invocation} --version`], {
      cwd: desktop,
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), "workspace-builder");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
