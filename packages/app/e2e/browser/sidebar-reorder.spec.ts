import type { Locator } from "@playwright/test";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace, type SeededWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { selectSidebarInbox, selectSidebarProject } from "../support/helpers/sidebar";

function workspaceRows(page: import("@playwright/test").Page) {
  return page.locator('[data-testid^="sidebar-workspace-row-"]');
}

async function expectOrder(rows: Locator, ids: string[]) {
  await expect
    .poll(() => rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid"))))
    .toEqual(ids.map((id) => `sidebar-workspace-row-${getServerId()}:${id}`));
}

async function seedActiveProject(count: number) {
  const seed = await seedWorkspace({ repoPrefix: "sidebar-activity-order-", title: "Workspace 1" });
  const ids = [seed.workspaceId];
  const agents: string[] = [];
  try {
    for (let index = 0; index < count; index += 1) {
      if (index > 0) {
        const created = await seed.client.createWorkspace({
          source: { kind: "directory", path: seed.repoPath, projectId: seed.projectId },
          title: `Workspace ${index + 1}`,
        });
        if (!created.workspace) throw new Error(created.error ?? "Workspace creation failed");
        ids.push(created.workspace.id);
      }
      const agent = await seed.client.createAgent({
        provider: "mock",
        cwd: seed.repoPath,
        workspaceId: ids[index],
        modeId: "load-test",
        model: "e2e-fast-stream",
        title: `Agent ${index + 1}`,
      });
      agents.push(agent.id);
    }
    return { seed, ids, agents };
  } catch (error) {
    await seed.cleanup();
    throw error;
  }
}

async function prompt(seed: SeededWorkspace, agentId: string) {
  await seed.client.sendAgentMessage(agentId, "Update the session activity order.");
  await seed.client.waitForFinish(agentId, 30_000);
  await seed.client.clearWorkspaceAttention(seed.workspaceId);
}

async function dragFirstAfterSecond(rows: Locator, reorders = true) {
  await expect(rows).toHaveCount(2);
  const before = await rows.evaluateAll((nodes) =>
    nodes.map((node) => node.getAttribute("data-testid")),
  );
  const source = await rows.nth(0).boundingBox();
  const target = await rows.nth(1).boundingBox();
  if (!source || !target) throw new Error("Expected visible workspace rows");
  const page = rows.page();
  await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect
    .poll(() => rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid"))))
    .toEqual(reorders ? [before[1], before[0]] : before);
}

test("project and Inbox follow session activity and retain that order after reload", async ({
  page,
}) => {
  const { seed, ids, agents } = await seedActiveProject(2);
  try {
    await gotoAppShell(page, seed);
    const rows = workspaceRows(page);
    await expectOrder(rows, [ids[1], ids[0]]);
    await dragFirstAfterSecond(rows, false);
    await prompt(seed, agents[0]);
    await expectOrder(rows, ids);
    await selectSidebarInbox(page);
    await expectOrder(rows, ids);
    await page.reload();
    await expectOrder(rows, ids);
    await selectSidebarProject(page, seed.projectKey);
    await prompt(seed, agents[1]);
    await expectOrder(rows, [ids[1], ids[0]]);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByRole("menuitem", { name: /^Sort/ })).toHaveCount(0);
    await expect(page.getByTestId("sidebar-display-grouping")).toHaveCount(0);
  } finally {
    await seed.cleanup();
  }
});

test("project pins can reorder while Inbox keeps its activity order", async ({ page }) => {
  const { seed, ids } = await seedActiveProject(2);
  try {
    await seed.client.setWorkspacePinned(ids[0], true);
    await seed.client.setWorkspacePinned(ids[1], true);
    await gotoAppShell(page, seed);
    const rows = page
      .getByTestId("sidebar-pinned-section")
      .locator('[data-testid^="sidebar-workspace-row-"]');
    await expectOrder(rows, [ids[1], ids[0]]);
    await dragFirstAfterSecond(rows);
    await expectOrder(rows, ids);
    await selectSidebarInbox(page);
    await expect(page.getByTestId("sidebar-pinned-section")).toHaveCount(0);
    await expectOrder(workspaceRows(page), [ids[1], ids[0]]);
    await page.reload();
    await selectSidebarProject(page, seed.projectKey);
    await expectOrder(rows, ids);
  } finally {
    await seed.cleanup();
  }
});

test("project Show more survives collapse and follows new session activity", async ({ page }) => {
  test.setTimeout(120_000);
  const { seed, ids, agents } = await seedActiveProject(9);
  try {
    await gotoAppShell(page, seed);
    const rows = workspaceRows(page);
    const newestFirst = ids.toReversed();
    await expectOrder(rows, newestFirst.slice(0, 7));
    await page.getByTestId(`sidebar-project-show-more-${seed.projectKey}`).click();
    await expectOrder(rows, newestFirst);
    const header = page.getByTestId(`sidebar-project-row-${seed.projectKey}`);
    await header.click();
    await expect(rows).toHaveCount(0);
    await header.click();
    await expectOrder(rows, newestFirst);
    await prompt(seed, agents[0]);
    const updated = [ids[0], ...newestFirst.filter((id) => id !== ids[0])];
    await expectOrder(rows, updated);
    await page.getByTestId(`sidebar-project-show-more-${seed.projectKey}`).click();
    await expectOrder(rows, updated.slice(0, 7));
    await page.reload();
    await selectSidebarProject(page, seed.projectKey);
    await expectOrder(rows, updated.slice(0, 7));
  } finally {
    await seed.cleanup();
  }
});
