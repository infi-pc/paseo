import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  pinWorkspaceFromSidebar,
  selectSidebarInbox,
  selectSidebarProject,
} from "../support/helpers/sidebar";

for (const compact of [false, true]) {
  test.describe(compact ? "Mobile project picker" : "Desktop project rail", () => {
    test.use({ viewport: compact ? { width: 390, height: 844 } : { width: 1280, height: 800 } });

    test("selects one project without navigating and returns to Inbox on reload", async ({
      page,
    }) => {
      const alpha = await seedWorkspace({ repoPrefix: "project-nav-alpha-", title: "Alpha work" });
      const beta = await seedWorkspace({ repoPrefix: "project-nav-beta-", title: "Beta work" });
      const row = (id: string) => page.getByTestId(`sidebar-workspace-row-${getServerId()}:${id}`);
      try {
        await gotoAppShell(page);
        await selectSidebarInbox(page);
        await expect(row(alpha.workspaceId)).toHaveCount(0);
        await expect(row(beta.workspaceId)).toHaveCount(0);
        const route = page.url();
        await selectSidebarProject(page, alpha.projectKey);
        await expect(row(alpha.workspaceId)).toBeVisible();
        await expect(row(beta.workspaceId)).toHaveCount(0);
        await expect(page).toHaveURL(route);
        await selectSidebarProject(page, beta.projectKey);
        await expect(row(beta.workspaceId)).toBeVisible();
        await expect(row(alpha.workspaceId)).toHaveCount(0);
        await expect(page).toHaveURL(route);
        await page.reload();
        await selectSidebarInbox(page);
        await expect(row(alpha.workspaceId)).toHaveCount(0);
        await selectSidebarProject(page, alpha.projectKey);
        await expect(row(alpha.workspaceId)).toBeVisible();
      } finally {
        await beta.cleanup();
        await alpha.cleanup();
      }
    });
  });
}

test("keeps project navigation and display preferences reachable when every workspace is pinned", async ({
  page,
}) => {
  const alpha = await seedWorkspace({ repoPrefix: "project-nav-pinned-" });
  const beta = await seedWorkspace({ repoPrefix: "project-nav-other-" });
  try {
    await gotoAppShell(page, alpha);
    await pinWorkspaceFromSidebar(page, alpha.workspaceId);
    await expect(page.getByTestId("sidebar-pinned-section")).toBeVisible();
    await page.getByTestId("sidebar-display-preferences-menu").click();
    await expect(page.getByTestId("sidebar-display-title-source")).toBeVisible();
    await expect(page.getByTestId("sidebar-display-grouping")).toHaveCount(0);
    await expect(page.getByTestId("sidebar-display-project-filter")).toHaveCount(0);
    await expect(page.getByRole("menuitem", { name: /^Sort/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await selectSidebarProject(page, beta.projectKey);
    await expect(
      page.getByTestId(`sidebar-workspace-row-${getServerId()}:${beta.workspaceId}`),
    ).toBeVisible();
    await selectSidebarProject(page, alpha.projectKey);
    await expect(page.getByTestId("sidebar-pinned-section")).toBeVisible();
  } finally {
    await beta.cleanup();
    await alpha.cleanup();
  }
});
