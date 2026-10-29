import { expect, test } from "../support/fixtures";
import { seedWorkspace } from "../support/helpers/seed-client";
import { createMockIdleAgent } from "../support/helpers/archive-tab";
import { getServerId } from "../support/helpers/server-id";
import { daemonWsRoutePattern, getE2EDaemonPort } from "../support/helpers/daemon-port";
import {
  expectComposerEditable,
  fillComposerDraft,
  expectComposerDraft,
  expectComposerFocused,
} from "../support/helpers/composer";
import { startupScenario } from "../support/helpers/startup-dsl";

test.describe("Startup loading presentation", () => {
  test("mobile reconnect preserves the saved host shell", async ({ page }) => {
    const startup = await startupScenario(page)
      .withMobileViewport()
      .withSavedHost({
        serverId: "srv_unreachable_mobile",
        label: "Dev",
        endpoint: "127.0.0.1:45678",
      })
      .openRoot();

    await startup.expectsSavedHostShell({ serverId: "srv_unreachable_mobile", label: "Dev" });
    await startup.expectsNoSavedHostErrorStatus();
    await startup.expectsNoLocalServerStartupCopy();
  });
});

test("initial compose URL survives desktop daemon startup", async ({ page }) => {
  test.setTimeout(120_000);
  const workspace = await seedWorkspace({ repoPrefix: "compose-startup-" });
  const serverId = getServerId();
  const hostReady = Promise.withResolvers<void>();
  try {
    const agent = await createMockIdleAgent(workspace.client, {
      cwd: workspace.workspaceDirectory,
      workspaceId: workspace.workspaceId,
      title: "Compose startup agent",
    });
    await page.goto(`/h/${serverId}/agent/${agent.id}`);
    await expectComposerEditable(page);
    await fillComposerDraft(page, "Preserve this draft");
    const draftKey = `agent:${serverId}:${agent.id}`;
    await expect
      .poll(() =>
        page.evaluate((key) => {
          const stored = localStorage.getItem("paseo-drafts");
          return stored ? JSON.parse(stored).state.drafts[key]?.input.text : null;
        }, draftKey),
      )
      .toBe("Preserve this draft");

    await page.routeWebSocket(daemonWsRoutePattern(), async (socket) => {
      await hostReady.promise;
      socket.connectToServer();
    });

    // Hold startup and reconnection; the router, renderer and daemon are real.
    await page.addInitScript(
      ({ id, listen }) => {
        const status = {
          serverId: id,
          status: "running",
          listen,
          hostname: "QA",
          pid: null,
          home: "",
          version: null,
          desktopManaged: true,
          error: null,
        };
        window.paseoDesktop = {
          platform: "darwin",
          invoke: async (command) => {
            if (command === "start_desktop_daemon") {
              await new Promise<void>((resolve) =>
                window.addEventListener("compose-startup-ready", () => resolve(), { once: true }),
              );
              return status;
            }
            if (command === "desktop_daemon_status") return status;
            return null;
          },
          getPendingOpenProject: async () => null,
          events: { on: async () => () => undefined },
        };
      },
      { id: serverId, listen: `127.0.0.1:${getE2EDaemonPort()}` },
    );
    const params = new URLSearchParams({
      serverId,
      cwd: workspace.workspaceDirectory,
      file: "src/Startup.tsx",
      line: "42",
      column: "7",
      requestId: "cold-compose",
    });
    await page.goto(`/compose?${params}`);
    await expect(page.getByTestId("startup-splash")).toBeVisible();
    await expect(page).toHaveURL(/\/compose\?/);
    hostReady.resolve();
    await page.evaluate(() => window.dispatchEvent(new Event("compose-startup-ready")));
    await expect(page).toHaveURL(new RegExp(`/workspace/${workspace.workspaceId}$`));
    await expectComposerDraft(page, "Preserve this draft\nsrc/Startup.tsx:42:7");
    await expectComposerFocused(page);
  } finally {
    hostReady.resolve();
    await workspace.cleanup();
  }
});
