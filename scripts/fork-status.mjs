#!/usr/bin/env node

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FORK_BRANCH = "paseo-customizations";
const MIRROR_BRANCH = "main";
const UPSTREAM_REF = "upstream/main";

const HELP_TEXT = `Usage: npm run fork:status [-- --no-fetch] [-- --json]

Reports how the personal fork relates to upstream Paseo:
  - how far ${MIRROR_BRANCH} (the upstream mirror) lags ${UPSTREAM_REF}
  - the fork-only commits on ${FORK_BRANCH}
  - the fork footprint: upstream files the fork modifies, and fork-owned files
  - a dry-run merge of ${UPSTREAM_REF} into ${FORK_BRANCH} listing files that would conflict
  - upstream churn since the last sync in files the fork also modifies

Read-only. Fetches upstream first unless --no-fetch is given. See docs/fork.md.`;

function parseArgs(argv) {
  const options = { fetch: true, json: false };
  for (const arg of argv) {
    if (arg === "--no-fetch") {
      options.fetch = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      console.log(HELP_TEXT);
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}\n\n${HELP_TEXT}`);
    }
  }
  return options;
}

async function git(args, { allowFailure = false } = {}) {
  try {
    const { stdout } = await execFileAsync("git", args, { maxBuffer: 64 * 1024 * 1024 });
    return { ok: true, stdout: stdout.replace(/\n$/, "") };
  } catch (error) {
    if (allowFailure && typeof error.stdout === "string") {
      return { ok: false, stdout: error.stdout.replace(/\n$/, ""), code: error.code };
    }
    throw error;
  }
}

function lines(text) {
  return text === "" ? [] : text.split("\n");
}

async function aheadBehind(left, right) {
  const { stdout } = await git(["rev-list", "--left-right", "--count", `${left}...${right}`]);
  const [ahead, behind] = stdout.split(/\s+/).map(Number);
  return { ahead, behind };
}

async function nameStatus(from, to, filter) {
  const { stdout } = await git(["diff", "--name-only", `--diff-filter=${filter}`, from, to]);
  return lines(stdout);
}

// `git merge-tree --write-tree` performs the merge in memory and exits 1 when it would conflict.
// The first output line is the tree id; conflicted paths follow, then an informational section.
async function dryRunMerge(ours, theirs) {
  const result = await git(["merge-tree", "--write-tree", "--name-only", ours, theirs], {
    allowFailure: true,
  });
  const [, ...rest] = lines(result.stdout);
  const conflictedFiles = [];
  for (const line of rest) {
    if (line === "") break;
    conflictedFiles.push(line);
  }
  return { clean: result.ok, conflictedFiles };
}

async function collect(options) {
  if (options.fetch) {
    await git(["fetch", "--quiet", "upstream", "--prune"]);
  }

  const upstreamHead = (
    await git(["log", "-1", "--format=%h %ad %s", "--date=short", UPSTREAM_REF])
  ).stdout;
  const mirror = await aheadBehind(MIRROR_BRANCH, UPSTREAM_REF);
  const fork = await aheadBehind(FORK_BRANCH, UPSTREAM_REF);
  const base = (await git(["merge-base", FORK_BRANCH, UPSTREAM_REF])).stdout;
  const baseDescription = (await git(["log", "-1", "--format=%h %ad %s", "--date=short", base]))
    .stdout;

  const forkCommits = lines(
    (
      await git([
        "log",
        "--no-merges",
        "--format=%h %ad %s",
        "--date=short",
        `${UPSTREAM_REF}..${FORK_BRANCH}`,
      ])
    ).stdout,
  );

  const modifiedUpstreamFiles = await nameStatus(base, FORK_BRANCH, "M");
  const forkOwnedFiles = await nameStatus(base, FORK_BRANCH, "A");
  const deletedUpstreamFiles = await nameStatus(base, FORK_BRANCH, "D");
  const upstreamChangedFiles = new Set(await nameStatus(base, UPSTREAM_REF, "ACDMR"));
  const sharedChurn = modifiedUpstreamFiles.filter((file) => upstreamChangedFiles.has(file));

  const merge =
    fork.behind === 0
      ? { clean: true, conflictedFiles: [] }
      : await dryRunMerge(FORK_BRANCH, UPSTREAM_REF);

  return {
    upstreamHead,
    mirror,
    fork,
    mergeBase: baseDescription,
    forkCommits,
    footprint: {
      modifiedUpstreamFiles,
      forkOwnedFiles,
      deletedUpstreamFiles,
    },
    sharedChurn,
    merge,
  };
}

function groupByPackage(files) {
  const counts = new Map();
  for (const file of files) {
    const parts = file.split("/");
    const key = parts[0] === "packages" && parts.length > 2 ? `${parts[0]}/${parts[1]}` : parts[0];
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

function printReport(report) {
  const out = [];
  out.push(`upstream/main      ${report.upstreamHead}`);
  out.push(`merge base         ${report.mergeBase}`);
  out.push(
    `${MIRROR_BRANCH.padEnd(18)} ${report.mirror.behind} behind, ${report.mirror.ahead} ahead of ${UPSTREAM_REF}` +
      (report.mirror.ahead > 0 ? "  <-- mirror has drifted; it should be a fast-forward" : ""),
  );
  out.push(
    `${FORK_BRANCH.padEnd(18)} ${report.fork.behind} behind, ${report.fork.ahead} ahead of ${UPSTREAM_REF}`,
  );
  out.push("");

  out.push(`Fork commits (${report.forkCommits.length}):`);
  for (const commit of report.forkCommits) out.push(`  ${commit}`);
  out.push("");

  const { modifiedUpstreamFiles, forkOwnedFiles, deletedUpstreamFiles } = report.footprint;
  out.push(
    `Footprint: ${modifiedUpstreamFiles.length} upstream files modified, ${forkOwnedFiles.length} fork-owned files, ${deletedUpstreamFiles.length} upstream files deleted`,
  );
  for (const [pkg, count] of groupByPackage(modifiedUpstreamFiles)) {
    out.push(`  ${String(count).padStart(4)}  ${pkg} (modified)`);
  }
  out.push("");

  out.push(
    `Upstream churn in fork-modified files since merge base (${report.sharedChurn.length}):`,
  );
  for (const file of report.sharedChurn) out.push(`  ${file}`);
  out.push("");

  if (report.fork.behind === 0) {
    out.push(`Merge: ${FORK_BRANCH} already contains ${UPSTREAM_REF}.`);
  } else if (report.merge.clean) {
    out.push(`Merge: ${UPSTREAM_REF} merges into ${FORK_BRANCH} without conflicts.`);
  } else {
    out.push(`Merge: ${report.merge.conflictedFiles.length} files would conflict:`);
    for (const file of report.merge.conflictedFiles) out.push(`  ${file}`);
  }

  console.log(out.join("\n"));
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const report = await collect(options);
  if (options.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printReport(report);
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
