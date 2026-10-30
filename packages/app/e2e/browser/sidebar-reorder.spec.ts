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
  // dnd-kit suppresses document clicks for 50 ms after releasing a pointer drag.
  await page.waitForTimeout(60);
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

test("opening older workspaces leaves Inbox ordered by session changes", async ({ page }) => {
  const { seed, ids, agents } = await seedActiveProject(2);
  try {
    await gotoAppShell(page, seed);
    await selectSidebarInbox(page);
    const rows = workspaceRows(page);
    await expectOrder(rows, [ids[1], ids[0]]);
    await page.getByTestId(`sidebar-workspace-row-${getServerId()}:${ids[0]}`).click();
    await expect(page).toHaveURL(new RegExp(`/workspace/${ids[0]}`));
    await expectOrder(rows, [ids[1], ids[0]]);
    await page.reload();
    await expectOrder(rows, [ids[1], ids[0]]);
    await prompt(seed, agents[0]);
    await expectOrder(rows, ids);
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

test("project icons and the overflow dialog share a persistent drag order", async ({ page }) => {
  const seeds: SeededWorkspace[] = [];
  try {
    for (let index = 0; index < 3; index += 1) {
      seeds.push(
        await seedWorkspace({ repoPrefix: `rail-order-${index}-`, title: `Project ${index}` }),
      );
    }
    await page.setViewportSize({ width: 1100, height: 1000 });
    await gotoAppShell(page, seeds[0]);
    const tabs = page.locator('[data-testid^="sidebar-project-tab-"]');
    await expect(tabs).toHaveCount(3);
    const initial = await tabs.evaluateAll((nodes) =>
      nodes.map((node) => node.getAttribute("data-testid")!.replace("sidebar-project-tab-", "")),
    );
    await dragProject(page, tabs.nth(0), tabs.nth(1));
    const reordered = [initial[1], initial[0], initial[2]];
    await expectProjectKeys(tabs, "sidebar-project-tab-", reordered);
    await page.reload();
    await expectProjectKeys(tabs, "sidebar-project-tab-", reordered);
    await page.setViewportSize({ width: 1100, height: 480 });
    const overflow = page.getByTestId("sidebar-project-overflow");
    await expect(overflow).toBeVisible();
    await expect.poll(() => tabs.count()).toBeLessThan(3);
    const rail = page.getByTestId("sidebar-project-rail");
    expect(await rail.evaluate((node) => node.scrollHeight <= node.clientHeight)).toBe(true);
    await overflow.click();
    const dialogRows = page.locator('[data-testid^="sidebar-all-project-row-"]');
    await expectProjectKeys(dialogRows, "sidebar-all-project-row-", reordered);
    await dragProject(
      page,
      page.getByTestId(`sidebar-project-drag-${initial[2]}`),
      page.getByTestId(`sidebar-project-drag-${initial[1]}`),
    );
    const finalOrder = [initial[2], initial[1], initial[0]];
    await expectProjectKeys(dialogRows, "sidebar-all-project-row-", finalOrder);
    await page.screenshot({ path: "test-results/project-overflow-dialog.png" });
    await page.getByTestId(`sidebar-all-project-option-${initial[0]}`).click();
    await expect(page.getByTestId("sidebar-all-projects-dialog")).toHaveCount(0);
    await expect(page.getByTestId(`sidebar-project-row-${initial[0]}`)).toBeVisible();
    await page.setViewportSize({ width: 1100, height: 1000 });
    await expect(overflow).toHaveCount(0);
    await expectProjectKeys(tabs, "sidebar-project-tab-", finalOrder);
    await page.reload();
    await expectProjectKeys(tabs, "sidebar-project-tab-", finalOrder);
    await page.screenshot({ path: "test-results/project-rail-reordered.png" });
  } finally {
    for (const seed of seeds.toReversed()) await seed.cleanup();
  }
});

async function expectProjectKeys(rows: Locator, prefix: string, keys: string[]) {
  await expect
    .poll(() => rows.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid"))))
    .toEqual(keys.map((key) => `${prefix}${key}`));
}

async function dragProject(
  page: import("@playwright/test").Page,
  source: Locator,
  target: Locator,
) {
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error("Project drag targets must be visible");
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await page.mouse.up();
  // dnd-kit suppresses document clicks for 50 ms after releasing a pointer drag.
  await page.waitForTimeout(60);
}
