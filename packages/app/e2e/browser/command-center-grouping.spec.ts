import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { openCommandCenter } from "../support/helpers/command-center";
import { seedWorkspace } from "../support/helpers/seed-client";
import { selectSidebarInbox, selectSidebarProject } from "../support/helpers/sidebar";

test("retired grouping commands stay absent in Inbox and projects, including after reload", async ({
  page,
}) => {
  const seeded = await seedWorkspace({ repoPrefix: "command-center-navigation-" });
  try {
    await gotoAppShell(page);
    await selectSidebarInbox(page);
    for (const projectKey of [null, seeded.projectKey]) {
      if (projectKey) await selectSidebarProject(page, projectKey);
      const panel = await openCommandCenter(page);
      await panel.getByTestId("command-center-input").fill("group");
      await expect(panel.getByText("Group by status", { exact: true })).toHaveCount(0);
      await expect(panel.getByText("Group by project", { exact: true })).toHaveCount(0);
      await page.keyboard.press("Escape");
      await expect(panel).not.toBeVisible();
    }
    await page.reload();
    await selectSidebarProject(page, seeded.projectKey);
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-grouping")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-display-title-source")).toBeVisible();
  } finally {
    await seeded.cleanup();
  }
});
