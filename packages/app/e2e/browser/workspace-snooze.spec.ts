import { seedMockAgentWorkspace, openAgentRoute } from "../support/helpers/mock-agent";
import { composerLocator, configureComposerQueueSend } from "../support/helpers/composer";
import { createMockIdleAgent } from "../support/helpers/archive-tab";
import { test, expect, type Page } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  openWorkspaceContextMenu,
  selectSidebarInbox,
  selectSidebarProject,
} from "../support/helpers/sidebar";

test.use({
  e2eDaemonConfig: {
    version: 1,
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

function row(page: Page, workspaceId: string) {
  return page.getByTestId(`sidebar-workspace-row-${getServerId()}:${workspaceId}`);
}
async function openSnooze(page: Page, workspaceId: string) {
  await openWorkspaceContextMenu(page, workspaceId);
  await page.getByTestId(`sidebar-workspace-snooze-${getServerId()}:${workspaceId}`).click();
  await expect(page.getByTestId("workspace-snooze-dialog")).toBeVisible();
}

test("timed snoozes move to Snoozed, survive reload, and stay visible in projects", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "snooze-time-" });
  try {
    await gotoAppShell(page, workspace);
    await selectSidebarInbox(page);
    await openSnooze(page, workspace.workspaceId);
    await page.screenshot({ path: testInfo.outputPath("snooze-time.png") });
    await page.getByTestId("workspace-snooze-submit").click();
    await expect(page.getByTestId("workspace-snooze-dialog")).toBeHidden();
    await expect(row(page, workspace.workspaceId)).toHaveCount(0);
    await page.reload();
    await selectSidebarProject(page, workspace.projectKey);
    await expect(row(page, workspace.workspaceId)).toBeVisible();
    await expect(row(page, workspace.workspaceId)).toContainText("Snoozed");
    await openWorkspaceContextMenu(page, workspace.workspaceId);
    await page
      .getByTestId(`sidebar-workspace-unsnooze-${getServerId()}:${workspace.workspaceId}`)
      .click();
    await expect(row(page, workspace.workspaceId)).not.toContainText("Snoozed");
    await expect(page.getByText("Show less", { exact: true })).toHaveCount(0);
  } finally {
    await workspace.cleanup();
  }
});

test("AI snooze keeps checks and deadlines visible and Inbox accounts for Snoozed", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "snooze-ai-" });
  try {
    await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Snoozable session",
    });
    await workspace.client.setWorkspacePinned(workspace.workspaceId, true);
    await gotoAppShell(page);
    await selectSidebarInbox(page);
    await expect(row(page, workspace.workspaceId)).toBeVisible();
    await selectSidebarProject(page, workspace.projectKey);
    await openSnooze(page, workspace.workspaceId);
    await page.getByTestId("snooze-mode-ai").click();
    await page.getByTestId("snooze-condition").fill("The deployment is healthy");
    await page.getByTestId("workspace-snooze-submit").click();
    await expect(row(page, workspace.workspaceId)).toBeVisible();
    await openSnooze(page, workspace.workspaceId);
    await expect(page.getByTestId("snooze-condition")).toHaveValue("The deployment is healthy");
    await expect(page.getByTestId("snooze-deadline")).toBeVisible();
    await expect(page.getByTestId("workspace-snooze-dialog")).toContainText("Couldn’t determine");
    await page.screenshot({ path: testInfo.outputPath("snooze-ai.png") });
    await page.getByTestId("workspace-snooze-dialog").getByText("Cancel", { exact: true }).click();
    await workspace.client.setWorkspacePinned(workspace.workspaceId, false);
    await selectSidebarInbox(page);
    await expect(row(page, workspace.workspaceId)).toHaveCount(0);
    await selectSidebarProject(page, workspace.projectKey);
    await expect(row(page, workspace.workspaceId)).toContainText("Snoozed");
  } finally {
    await workspace.cleanup();
  }
});

test("a rejected save keeps the dialog and exposes the daemon error", async ({ page }) => {
  const workspace = await seedWorkspace({ repoPrefix: "snooze-rejected-" });
  try {
    await gotoAppShell(page, workspace);
    await openSnooze(page, workspace.workspaceId);
    await workspace.client.archiveWorkspace(workspace.workspaceId);
    await page.getByTestId("workspace-snooze-submit").click();
    await expect(page.getByTestId("snooze-error")).toHaveText(
      "Archived workspaces cannot be snoozed",
    );
    await expect(page.getByTestId("workspace-snooze-submit")).toBeEnabled();
  } finally {
    await workspace.cleanup();
  }
});

test("custom date validates time and stays usable at compact width", async ({ page }, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "snooze-custom-" });
  try {
    await gotoAppShell(page, workspace);
    await openSnooze(page, workspace.workspaceId);
    await page.getByTestId("snooze-preset-custom").click();
    await page.getByTestId("snooze-custom-time").fill("25:00");
    await page.getByTestId("workspace-snooze-submit").click();
    await expect(page.getByTestId("snooze-error")).toHaveText(
      "Choose a valid future date and time",
    );
    await page.getByTestId("snooze-custom-time").fill("10:30");
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("snooze-custom-time")).toHaveValue("10:30");
    // The adaptive dialog remounts its contents when crossing the compact breakpoint.
    await expect(async () => {
      await page.getByTestId("snooze-custom-time").scrollIntoViewIfNeeded();
    }).toPass();
    await expect(page.getByTestId("workspace-snooze-submit")).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("snooze-custom-compact.png") });
    await page.getByTestId("workspace-snooze-submit").click();
    await expect(page.getByTestId("workspace-snooze-dialog")).toBeHidden();
  } finally {
    await workspace.cleanup();
  }
});

test("status change explains missing links and does not hide a workspace without a selection", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "snooze-status-" });
  try {
    await gotoAppShell(page, workspace);
    await openSnooze(page, workspace.workspaceId);
    await page.getByTestId("snooze-mode-status").click();
    await expect(page.getByText("No linked PR or Linear issues found.")).toBeVisible();
    await page.getByTestId("workspace-snooze-submit").click();
    await expect(page.getByTestId("snooze-error")).toHaveText(
      "Choose at least one status to watch",
    );
    await page.screenshot({ path: testInfo.outputPath("snooze-status-desktop.png") });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(page.getByTestId("snooze-mode-status")).toBeVisible();
    await expect(page.getByTestId("workspace-snooze-submit")).toBeInViewport();
    await page.screenshot({ path: testInfo.outputPath("snooze-status-compact.png") });
  } finally {
    await workspace.cleanup();
  }
});

test("session shortcuts open tabs and snooze-on-send cancel preserves the draft", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "snooze-send-" });
  try {
    const agent = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Inbox session",
    });
    await gotoAppShell(page, workspace);
    await selectSidebarInbox(page);
    // Host-qualified session identities are independent of which tabs this device had open.
    const sessionRow = page.getByTestId(`sidebar-session-${getServerId()}-${agent.id}`);
    await expect(sessionRow).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("inbox-session-shortcut.png") });
    await sessionRow.click();
    await expect(composerLocator(page)).toBeVisible();
    await workspace.client.setWorkspaceSnooze(workspace.workspaceId, {
      mode: "time",
      wakeAt: new Date(Date.now() + 86400000).toISOString(),
      timezone: "UTC",
    });
    await expect(row(page, workspace.workspaceId)).toHaveCount(0);
    await expect(page.getByTestId("sidebar-section-snoozed")).toContainText("1");
    await composerLocator(page).fill("Keep this draft");
    await composerLocator(page).press("Enter");
    const dialog = page.getByTestId("snoozed-send-dialog");
    await expect(dialog).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("snooze-on-send.png") });
    await dialog.getByText("Cancel", { exact: true }).click();
    await expect(composerLocator(page)).toHaveValue("Keep this draft");
    await composerLocator(page).press("Enter");
    await dialog.getByText("Unsnooze and send", { exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(composerLocator(page)).toHaveValue("");
    await expect(row(page, workspace.workspaceId).first()).toBeVisible();
    await expect
      .poll(
        async () =>
          (await workspace.client.fetchWorkspaces({})).entries.find(
            (entry) => entry.id === workspace.workspaceId,
          )?.snooze,
      )
      .toBeNull();
  } finally {
    await workspace.cleanup();
  }
});

test("unsnooze succeeds even when sending fails, and the draft remains retryable", async ({
  page,
}, testInfo) => {
  const agent = await seedMockAgentWorkspace({
    repoPrefix: "snooze-send-failure-",
    title: "Send retry",
    featureValues: { mockPromptRejections: 1 },
  });
  try {
    await openAgentRoute(page, agent);
    await expect(composerLocator(page)).toBeVisible();
    await agent.client.setWorkspaceSnooze(agent.workspaceId, {
      mode: "time",
      wakeAt: new Date(Date.now() + 86400000).toISOString(),
      timezone: "UTC",
    });
    await selectSidebarInbox(page);
    await expect(page.getByTestId("sidebar-section-snoozed")).toBeVisible();
    await composerLocator(page).fill("Retry this message");
    await composerLocator(page).press("Enter");
    await page
      .getByTestId("snoozed-send-dialog")
      .getByText("Unsnooze and send", { exact: true })
      .click();
    await expect(
      page.getByRole("alert").filter({ hasText: "The workspace is now awake" }),
    ).toBeVisible();
    await expect(composerLocator(page)).toHaveValue("Retry this message");
    await expect
      .poll(
        async () =>
          (await agent.client.fetchWorkspaces({})).entries.find(
            (entry) => entry.id === agent.workspaceId,
          )?.snooze,
      )
      .toBeNull();
    await page.screenshot({ path: testInfo.outputPath("snooze-send-failure.png") });
    await composerLocator(page).press("Enter");
    await expect(page.getByTestId("snoozed-send-dialog")).toHaveCount(0);
    await expect(composerLocator(page)).toHaveValue("");
  } finally {
    await agent.cleanup();
  }
});

test("a mixed workspace has distinct Running and Inbox sessions and snooze keeps work visible", async ({
  page,
}, testInfo) => {
  const workspace = await seedWorkspace({ repoPrefix: "inbox-mixed-" });
  let working: string | undefined;
  try {
    const idle = await createMockIdleAgent(workspace.client, {
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Ready for review",
    });
    const agent = await workspace.client.createAgent({
      provider: "mock",
      model: "one-minute-stream",
      modeId: "load-test",
      cwd: workspace.repoPath,
      workspaceId: workspace.workspaceId,
      title: "Working session",
      initialPrompt: "Run until canceled",
    });
    working = agent.id;
    await workspace.client.waitForAgentUpsert(
      agent.id,
      (snapshot) => snapshot.status === "running",
    );
    await gotoAppShell(page, workspace);
    await selectSidebarInbox(page);
    await expect(row(page, workspace.workspaceId)).toHaveCount(2);
    await expect(page.getByTestId(`sidebar-session-${getServerId()}-${idle.id}`)).toHaveCount(1);
    await expect(page.getByTestId(`sidebar-session-${getServerId()}-${agent.id}`)).toHaveCount(1);
    await page.screenshot({ path: testInfo.outputPath("inbox-mixed-running.png") });
    await workspace.client.setWorkspaceSnooze(workspace.workspaceId, {
      mode: "time",
      wakeAt: new Date(Date.now() + 86400000).toISOString(),
      timezone: "UTC",
    });
    await expect(row(page, workspace.workspaceId)).toHaveCount(1);
    await expect(page.getByTestId(`sidebar-session-${getServerId()}-${agent.id}`)).toBeVisible();
    await expect(page.getByTestId(`sidebar-session-${getServerId()}-${idle.id}`)).toHaveCount(0);
    await expect(page.getByTestId("sidebar-section-snoozed")).toBeVisible();
    await page.getByTestId(`sidebar-session-${getServerId()}-${agent.id}`).click();
    await composerLocator(page).fill("Send after this turn ends");
    await composerLocator(page).press("Enter");
    await expect(page.getByTestId("snoozed-send-dialog")).toBeVisible();
    await workspace.client.cancelAgent(agent.id);
    await expect(row(page, workspace.workspaceId)).toHaveCount(0);
    await page
      .getByTestId("snoozed-send-dialog")
      .getByText("Keep snoozed and send", { exact: true })
      .click();
    await expect(composerLocator(page)).toHaveValue("");
    await expect(row(page, workspace.workspaceId)).toHaveCount(1);
    await expect
      .poll(
        async () =>
          (await workspace.client.fetchWorkspaces({})).entries.find(
            (entry) => entry.id === workspace.workspaceId,
          )?.snooze?.config.mode,
      )
      .toBe("time");
    await workspace.client.cancelAgent(agent.id);
    working = undefined;
  } finally {
    if (working) await workspace.client.cancelAgent(working);
    await workspace.cleanup();
  }
});

for (const scenario of ["cancel preserves draft", "finished turn sends immediately"] as const) {
  test(`queued snoozed send: ${scenario}`, async ({ page }) => {
    await configureComposerQueueSend(page);
    const workspace = await seedWorkspace({ repoPrefix: "snooze-queue-" });
    let working: string | undefined;
    try {
      const agent = await workspace.client.createAgent({
        provider: "mock",
        model: "one-minute-stream",
        modeId: "load-test",
        cwd: workspace.repoPath,
        workspaceId: workspace.workspaceId,
        title: "Queued session",
        initialPrompt: "Run until canceled",
      });
      working = agent.id;
      await workspace.client.waitForAgentUpsert(
        agent.id,
        (snapshot) => snapshot.status === "running",
      );
      await gotoAppShell(page, workspace);
      await selectSidebarInbox(page);
      await workspace.client.setWorkspaceSnooze(workspace.workspaceId, {
        mode: "time",
        wakeAt: new Date(Date.now() + 86400000).toISOString(),
        timezone: "UTC",
      });
      await page.getByTestId(`sidebar-session-${getServerId()}-${agent.id}`).click();
      const composer = composerLocator(page);
      await composer.fill("Keep this queued draft");
      await composer.press("Enter");
      const dialog = page.getByTestId("snoozed-send-dialog");
      await expect(dialog).toBeVisible();
      if (scenario === "cancel preserves draft") {
        await expect(composer).toHaveValue("Keep this queued draft");
        await dialog.getByText("Cancel", { exact: true }).click();
        await expect(composer).toHaveValue("Keep this queued draft");
        await expect(page.getByRole("button", { name: "Send queued message now" })).toHaveCount(0);
      } else {
        await workspace.client.cancelAgent(agent.id);
        await expect(row(page, workspace.workspaceId)).toHaveCount(0);
        await dialog.getByText("Keep snoozed and send", { exact: true }).click();
        await expect(composer).toHaveValue("");
        await expect(row(page, workspace.workspaceId)).toHaveCount(1);
        await expect(page.getByRole("button", { name: "Send queued message now" })).toHaveCount(0);
      }
    } finally {
      if (working) await workspace.client.cancelAgent(working);
      await workspace.cleanup();
    }
  });
}
