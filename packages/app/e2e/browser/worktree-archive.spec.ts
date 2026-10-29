import { existsSync } from "node:fs";
import { expect, test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import {
  archiveWorkspaceFromDaemon,
  connectNewWorkspaceDaemonClient,
  createWorktreeViaDaemon,
  openProjectViaDaemon,
} from "../support/helpers/new-workspace";
import { getServerId } from "../support/helpers/server-id";
import {
  archiveWorkspaceFromSidebar,
  expectWorkspaceAbsentFromSidebar,
  revealSidebarProjectWorkspaces,
} from "../support/helpers/sidebar";
import { createTempGitRepo } from "../support/helpers/workspace";
import {
  waitForSidebarHydration,
  waitForWorkspaceInSidebar,
} from "../support/helpers/workspace-ui";

test.describe("Workspace archive with worktree backing", () => {
  let client: Awaited<ReturnType<typeof connectNewWorkspaceDaemonClient>>;
  let tempRepo: { path: string; cleanup: () => Promise<void> };
  const createdWorktreeDirectories = new Set<string>();

  test.describe.configure({ retries: 1, timeout: 120_000 });

  test.beforeEach(async () => {
    client = await connectNewWorkspaceDaemonClient();
    tempRepo = await createTempGitRepo("wt-archive-");
  });

  test.afterEach(async () => {
    for (const directory of createdWorktreeDirectories) {
      await archiveWorkspaceFromDaemon(client, directory).catch(() => undefined);
    }
    createdWorktreeDirectories.clear();
    await client?.close().catch(() => undefined);
    await tempRepo?.cleanup().catch(() => undefined);
  });

  test("a managed worktree remains until its last workspace is archived", async ({ page }) => {
    const serverId = getServerId();
    await openProjectViaDaemon(client, tempRepo.path);
    const first = await createWorktreeViaDaemon(client, {
      cwd: tempRepo.path,
      slug: `shared-archive-${Date.now()}`,
    });
    createdWorktreeDirectories.add(first.workspaceDirectory);

    const siblingPayload = await client.createWorkspace({
      source: {
        kind: "directory",
        path: first.workspaceDirectory,
      },
      title: "Second workspace",
    });
    if (!siblingPayload.workspace) {
      throw new Error(siblingPayload.error ?? "Failed to create a workspace on the worktree");
    }
    const sibling = siblingPayload.workspace;
    expect(sibling.workspaceKind).toBe("worktree");
    expect(sibling.workspaceDirectory).toBe(first.workspaceDirectory);
    const siblingProject = (await client.listProjects()).projects.find(
      (project) => project.projectId === sibling.projectId,
    );
    if (!siblingProject?.projectKey)
      throw new Error("Sibling workspace project is missing its project key");

    await gotoAppShell(page, first);
    await waitForSidebarHydration(page);
    await revealSidebarProjectWorkspaces(page, first.projectKey);
    await waitForWorkspaceInSidebar(page, { serverId, workspaceId: first.workspaceId });
    await revealSidebarProjectWorkspaces(page, siblingProject.projectKey);
    await waitForWorkspaceInSidebar(page, { serverId, workspaceId: sibling.id });

    await revealSidebarProjectWorkspaces(page, first.projectKey);
    await archiveWorkspaceFromSidebar(page, first.workspaceId);

    await expectWorkspaceAbsentFromSidebar(page, first.workspaceId);
    expect(existsSync(first.workspaceDirectory)).toBe(true);
    await revealSidebarProjectWorkspaces(page, siblingProject.projectKey);
    await waitForWorkspaceInSidebar(page, { serverId, workspaceId: sibling.id });

    await archiveWorkspaceFromSidebar(page, sibling.id);

    await expectWorkspaceAbsentFromSidebar(page, sibling.id);
    await expect.poll(() => existsSync(first.workspaceDirectory), { timeout: 30_000 }).toBe(false);
  });
});
