import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { gotoWorkspace, clickNewTerminal } from "../support/helpers/launcher";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { seedMockAgentWorkspace } from "../support/helpers/mock-agent";
import { getServerId } from "../support/helpers/server-id";
import { selectSidebarInbox, selectSidebarProject } from "../support/helpers/sidebar";

function workspaceRow(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}

async function seedSecondWorkspace(project: SeededWorkspace): Promise<string> {
  const created = await project.client.createWorkspace({
    source: { kind: "directory", path: project.repoPath, projectId: project.projectId },
    title: "Second workspace",
  });
  if (!created.workspace) throw new Error(created.error ?? "Failed to create a second workspace");
  return created.workspace.id;
}

test("git and non-git project tabs retain expandable workspace lists and creation actions", async ({
  page,
}) => {
  const git = await seedWorkspace({ repoPrefix: "model-b-git-" });
  const directory = await seedWorkspace({ repoPrefix: "model-b-nongit-", git: false });
  try {
    const projects = [
      { project: git, second: await seedSecondWorkspace(git) },
      { project: directory, second: await seedSecondWorkspace(directory) },
    ];
    await gotoAppShell(page);
    for (const { project, second } of projects) {
      await selectSidebarProject(page, project.projectKey);
      const header = page.getByTestId(`sidebar-project-row-${project.projectKey}`);
      await expect(header).toBeVisible();
      await expect(workspaceRow(page, project.workspaceId)).toBeVisible();
      await expect(workspaceRow(page, second)).toBeVisible();
      await header.click();
      await expect(workspaceRow(page, second)).toHaveCount(0);
      await header.click();
      await expect(workspaceRow(page, second)).toBeVisible();
      await header.hover();
      await expect(
        page.getByTestId(`sidebar-project-new-worktree-${project.projectKey}`),
      ).toBeVisible();
      await expect(page.getByTestId("sidebar-global-new-workspace")).toBeVisible();
    }
  } finally {
    await directory.cleanup();
    await git.cleanup();
  }
});

test("project and Inbox lists show workspaces rather than agent or terminal leaves", async ({
  page,
}) => {
  const mock = await seedMockAgentWorkspace({ repoPrefix: "model-b-leaf-", title: "Leaf agent" });
  try {
    await gotoWorkspace(page, mock.workspaceId);
    await clickNewTerminal(page);
    for (const scope of ["project", "inbox"]) {
      if (scope === "project") await selectSidebarProject(page, mock.projectKey);
      else await selectSidebarInbox(page);
      await expect(workspaceRow(page, mock.workspaceId)).toBeVisible();
      const sidebar = page.getByTestId(
        scope === "project" ? "sidebar-project-workspace-list-scroll" : "sidebar-flat-workspaces",
      );
      await expect(sidebar.locator('[data-testid^="workspace-tab-"]')).toHaveCount(0);
      await expect(sidebar.locator('[data-testid^="sidebar-agent-row-"]')).toHaveCount(0);
      await expect(sidebar.locator('[data-testid^="sidebar-terminal-row-"]')).toHaveCount(0);
    }
  } finally {
    await mock.cleanup();
  }
});

test("Inbox keeps projects distinguishable and shows each workspace's own status", async ({
  page,
}) => {
  const idle = await seedMockAgentWorkspace({ repoPrefix: "model-b-idle-", title: "Idle agent" });
  const active = await seedMockAgentWorkspace({
    repoPrefix: "model-b-active-",
    title: "Working agent",
    initialPrompt: "stay busy",
    model: "one-minute-stream",
  });
  try {
    await gotoAppShell(page);
    await selectSidebarInbox(page);
    await expect(workspaceRow(page, idle.workspaceId)).toBeVisible();
    await expect(workspaceRow(page, active.workspaceId)).toBeVisible();
    const activeIcon = workspaceRow(page, active.workspaceId).getByTestId(
      `sidebar-row-project-icon-${getServerId()}:${active.workspaceId}`,
    );
    const idleIcon = workspaceRow(page, idle.workspaceId).getByTestId(
      `sidebar-row-project-icon-${getServerId()}:${idle.workspaceId}`,
    );
    await expect(activeIcon.getByTestId("project-status-badge")).toHaveAttribute(
      "aria-label",
      "Working",
    );
    await expect(idleIcon).toBeVisible();
    await expect(idleIcon.getByTestId("project-status-badge")).toHaveCount(0);
    await expect(
      page
        .getByTestId("sidebar-flat-workspaces")
        .locator('[data-testid^="sidebar-workspace-row-"]'),
    ).toHaveCount(2);
  } finally {
    await active.cleanup();
    await idle.cleanup();
  }
});
