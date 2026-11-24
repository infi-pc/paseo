import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditableWorkshopDaemonManager, resolveWorkshopSettings } from "./workshop-daemon.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "paseo-workshop-daemon-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveWorkshopSettings", () => {
  it("reads workshopHome and workshopPort from config.json and enforces isolation", () => {
    const root = makeTempDir();
    const userHome = path.join(root, "home");
    const configHome = path.join(userHome, ".editable-paseo");
    const workshopHome = path.join(userHome, ".paseo-workshop");
    mkdirSync(configHome, { recursive: true });
    writeFileSync(
      path.join(configHome, "config.json"),
      JSON.stringify({ workshopHome, workshopPort: 6769 }),
    );

    const settings = resolveWorkshopSettings(configHome, {
      userHome,
      currentPaseoHome: path.join(userHome, ".paseo-dev"),
      currentListen: "127.0.0.1:6770",
    });
    expect(settings).toEqual({
      configHome,
      workshopHome,
      workshopPort: 6769,
      listen: "127.0.0.1:6769",
      repoDir: path.join(configHome, "repo"),
      worktreesDir: path.join(configHome, "worktrees"),
    });
  });

  it("rejects live production home or port collisions", () => {
    const root = makeTempDir();
    const userHome = path.join(root, "home");
    const configHome = path.join(userHome, ".editable-paseo");
    mkdirSync(configHome, { recursive: true });

    writeFileSync(
      path.join(configHome, "config.json"),
      JSON.stringify({ workshopHome: path.join(userHome, ".paseo"), workshopPort: 6769 }),
    );
    expect(() =>
      resolveWorkshopSettings(configHome, {
        userHome,
        currentPaseoHome: path.join(userHome, ".paseo-dev"),
        currentListen: "127.0.0.1:6770",
      }),
    ).toThrow(/isolated/i);

    writeFileSync(
      path.join(configHome, "config.json"),
      JSON.stringify({ workshopHome: path.join(userHome, ".paseo-workshop"), workshopPort: 6767 }),
    );
    expect(() =>
      resolveWorkshopSettings(configHome, {
        userHome,
        currentPaseoHome: path.join(userHome, ".paseo-dev"),
        currentListen: "127.0.0.1:6770",
      }),
    ).toThrow(/isolated/i);

    writeFileSync(
      path.join(configHome, "config.json"),
      JSON.stringify({ workshopHome: path.join(userHome, ".paseo-workshop"), workshopPort: 6770 }),
    );
    expect(() =>
      resolveWorkshopSettings(configHome, {
        userHome,
        currentPaseoHome: path.join(userHome, ".paseo-dev"),
        currentListen: "127.0.0.1:6770",
      }),
    ).toThrow(/isolated/i);
  });
});

describe("EditableWorkshopDaemonManager", () => {
  it("reports worktrees, starts with isolated EDITABLE_PASEO_HOME, and exposes local credentials", async () => {
    const root = makeTempDir();
    const userHome = path.join(root, "home");
    const configHome = path.join(userHome, ".editable-paseo");
    const workshopHome = path.join(userHome, ".paseo-workshop");
    mkdirSync(path.join(configHome, "worktrees", "red-row"), { recursive: true });
    mkdirSync(path.join(configHome, "worktrees", ".hidden"), { recursive: true });

    let running = false;
    const startInstance = vi.fn(async () => {
      running = true;
      return {
        pid: 4242,
        startedAt: "2026-11-24T00:00:00.000Z",
        hostname: "Mac",
        listen: "127.0.0.1:6769",
        serverId: "srv_workshop123",
        desktopManaged: true,
      };
    });
    const readCredential = vi.fn(() => "workshop-secret");

    const manager = new EditableWorkshopDaemonManager({
      configHome,
      userHome,
      currentPaseoHome: path.join(userHome, ".paseo-dev"),
      currentListen: "127.0.0.1:6770",
      readInstance: async () =>
        running
          ? {
              pid: 4242,
              startedAt: "2026-11-24T00:00:00.000Z",
              hostname: "Mac",
              listen: "127.0.0.1:6769",
              serverId: "srv_workshop123",
              desktopManaged: true,
            }
          : null,
      startInstance: startInstance as never,
      readCredential,
      createInvocation: (env) => ({ command: "node", args: ["daemon.js"], env }),
      cliShimPath: () => "/tmp/paseo-shim",
    });

    expect(await manager.getStatus()).toMatchObject({
      status: "stopped",
      listen: "127.0.0.1:6769",
      home: workshopHome,
      worktrees: ["red-row"],
      serverId: null,
    });
    expect(await manager.readLocalCredential("127.0.0.1:6769")).toBeNull();

    const started = await manager.start();
    expect(started).toMatchObject({
      status: "running",
      serverId: "srv_workshop123",
      listen: "127.0.0.1:6769",
      pid: 4242,
      worktrees: ["red-row"],
    });
    expect(startInstance).toHaveBeenCalledTimes(1);
    const launchArgs = startInstance.mock.calls[0]?.[0] as unknown as {
      home: string;
      env: Record<string, string>;
    };
    expect(launchArgs.home).toBe(workshopHome);
    expect(launchArgs.env.PASEO_HOME).toBe(workshopHome);
    expect(launchArgs.env.PASEO_LISTEN).toBe("127.0.0.1:6769");
    expect(launchArgs.env.EDITABLE_PASEO_HOME).toBe(configHome);
    expect(launchArgs.env.PATH).toContain(path.join(userHome, ".local", "bin"));

    const configWritten = JSON.parse(readFileSync(path.join(workshopHome, "config.json"), "utf8"));
    expect(configWritten).toEqual({
      daemon: { listen: "127.0.0.1:6769", relay: { enabled: false } },
    });

    expect(await manager.readLocalCredential("127.0.0.1:6769")).toBe("workshop-secret");
    expect(readCredential).toHaveBeenCalledWith(workshopHome, "127.0.0.1:6769");
  });
});
