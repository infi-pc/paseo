import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { test, expect, type Page } from "../support/fixtures";
import { selectSidebarProject, openWorkspaceContextMenu } from "../support/helpers/sidebar";
import { gotoAppShell } from "../support/helpers/app";
import { connectSeedClient } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";

import { resolveTempRoot } from "../support/helpers/workspace";

const run = promisify(execFile);

test.use({
  e2eDaemonConfig: {
    version: 1,
    daemon: { autoArchiveAfterMerge: false },
    agents: {
      providers: {
        codex: { enabled: false },
        claude: { enabled: false },
        copilot: { enabled: false },
        opencode: { enabled: false },
        pi: { enabled: false },
        omp: { enabled: false },
      },
    },
  },
});
test.describe.configure({ timeout: 180_000 });

// This existing merged PR is read-only: these scenarios never create or mutate GitHub resources.
// The normal worker gh wrapper delegates this non-fixture repository to the real gh binary.
async function createPullRequestWorkspace() {
  const directory = await mkdtemp(path.join(await resolveTempRoot(), "snooze-github-"));
  const client = await connectSeedClient();
  try {
    const git = (...args: string[]) => run("git", args, { cwd: directory });
    await git("init");
    await git("remote", "add", "origin", "https://github.com/infi-pc/paseo.git");
    await git("fetch", "--depth=1", "origin", "refs/pull/3/head");
    await git("checkout", "-b", "explore-typescript-lsp-editor-diff", "FETCH_HEAD");
    const result = await client.createWorkspace({
      source: { kind: "directory", path: directory },
      title: "GitHub status snooze",
    });
    if (!result.workspace) throw new Error(result.error ?? "Failed to create PR workspace");
    const workspace = result.workspace;
    const { projects } = await client.listProjects();
    const project = projects.find((entry) => entry.projectId === workspace.projectId);
    if (!project?.projectKey) throw new Error("Missing snooze project key");
    return {
      client,
      workspaceId: workspace.id,
      projectKey: project.projectKey,
      cleanup: async () => {
        try {
          await client.removeProject(workspace.projectId);
        } finally {
          try {
            await client.close();
          } finally {
            await rm(directory, { recursive: true, force: true });
          }
        }
      },
    };
  } catch (error) {
    await client.close();
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function row(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

async function openSnooze(page: Page, workspaceId: string) {
  await openWorkspaceContextMenu(page, workspaceId);
  await page.getByTestId(`sidebar-workspace-snooze-${getServerId()}:${workspaceId}`).click();
  await expect(page.getByTestId("workspace-snooze-dialog")).toBeVisible();
}

async function chooseReviewOnlyHourly(page: Page) {
  await page.getByTestId("snooze-mode-status").click();
  const dialog = page.getByTestId("workspace-snooze-dialog");
  await expect(dialog.getByRole("switch")).toHaveCount(2, { timeout: 90_000 });
  await expect(dialog.getByRole("switch", { name: "PR #3 · State" })).toBeChecked();
  await expect(dialog.getByRole("switch", { name: "PR #3 · Review" })).toBeChecked();
  await expect(dialog.getByText("Merged", { exact: true })).toBeVisible();
  await expect(dialog.getByText("No decision", { exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "5 minutes", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await dialog.getByRole("switch", { name: "PR #3 · State" }).click();
  await dialog.getByRole("button", { name: "1 hour", exact: true }).click();
  await expectReviewOnlyHourly(page);
}

async function expectReviewOnlyHourly(page: Page) {
  // The adaptive sheet's test ID belongs to its header on compact layouts.
  await expect(page.getByRole("switch", { name: "PR #3 · Review" })).toBeChecked();
  await expect(page.getByRole("switch", { checked: true })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "1 hour", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

test("populated GitHub statuses save a subset and reopen the persisted watch at compact width", async ({
  page,
}, testInfo) => {
  const workspace = await createPullRequestWorkspace();
  try {
    await gotoAppShell(page, workspace);
    await openSnooze(page, workspace.workspaceId);
    await chooseReviewOnlyHourly(page);
    await page.screenshot({ path: testInfo.outputPath("snooze-github-selection-desktop.png") });
    await page.getByTestId("workspace-snooze-submit").click();
    await expect(page.getByTestId("workspace-snooze-dialog")).toBeHidden({ timeout: 90_000 });
    await expect(row(page, workspace.workspaceId)).toHaveCount(0);
    await page.reload();
    await selectSidebarProject(page, workspace.projectKey);
    await page.getByText("Show all", { exact: true }).click();
    await expect(row(page, workspace.workspaceId)).toContainText("Snoozed");
    await openSnooze(page, workspace.workspaceId);
    await expectReviewOnlyHourly(page);
    await expect(page.getByText("Loading connected statuses…", { exact: true })).toBeHidden();
    await page.setViewportSize({ width: 390, height: 844 });
    await expectReviewOnlyHourly(page);
    await expect(page.getByRole("switch", { name: "PR #3 · Review" })).toBeInViewport({ ratio: 1 });
    await expect(page.getByTestId("workspace-snooze-submit")).toBeInViewport({ ratio: 1 });
    await page.screenshot({ path: testInfo.outputPath("snooze-github-reopened-compact.png") });
  } finally {
    await workspace.cleanup();
  }
});

test("a rejected populated status save retains inputs and succeeds on retry", async ({
  page,
}, testInfo) => {
  const workspace = await createPullRequestWorkspace();
  try {
    await gotoAppShell(page, workspace);
    await openSnooze(page, workspace.workspaceId);
    await chooseReviewOnlyHourly(page);
    await workspace.client.archiveWorkspace(workspace.workspaceId);
    await page.getByTestId("workspace-snooze-submit").click();
    await expect(page.getByTestId("snooze-error")).toHaveText("Workspace is unavailable");
    await expectReviewOnlyHourly(page);
    await expect(page.getByTestId("workspace-snooze-submit")).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath("snooze-github-save-error.png") });
    await workspace.client.restoreWorkspace(workspace.workspaceId);
    await expect(row(page, workspace.workspaceId)).toBeVisible();
    await expect(page.getByTestId("snooze-error")).toHaveText("Workspace is unavailable");
    await page.getByTestId("workspace-snooze-submit").click();
    await expect(page.getByTestId("workspace-snooze-dialog")).toBeHidden({ timeout: 90_000 });
    await expect(row(page, workspace.workspaceId)).toHaveCount(0);
    await page.getByText("Show all", { exact: true }).click();
    await expect(row(page, workspace.workspaceId)).toContainText("Snoozed");
    await openSnooze(page, workspace.workspaceId);
    await expectReviewOnlyHourly(page);
    await expect(page.getByTestId("snooze-error")).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});
