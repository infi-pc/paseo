import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  EditableInspectorServer,
  computeScreenshotCropRect,
  type InspectorWindowAdapter,
} from "./inspector-server.js";

const tempDirs: string[] = [];
const activeServers: EditableInspectorServer[] = [];

afterEach(() => {
  while (activeServers.length > 0) activeServers.pop()!.close();
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function getSocket(
  socketPath: string,
  reqPath: string,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: reqPath, method: "GET" }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (c: Buffer) => chunks.push(c));
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 500,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
    });
    req.on("error", reject);
    req.end();
  });
}

describe("EditableInspectorServer", () => {
  it("computes clamped crop rects around clicked elements", () => {
    expect(
      computeScreenshotCropRect({ x: 10, y: 12, width: 80, height: 32 }, [1400, 900], 140),
    ).toEqual({
      x: 0,
      y: 0,
      width: 460,
      height: 280,
    });
  });

  it("serves status, react, logs, and PNG screenshots over the local Unix socket", async () => {
    const baseTmp = os.tmpdir().length > 40 ? "/tmp" : os.tmpdir();
    const root = mkdtempSync(path.join(baseTmp, "ped-insp-"));
    tempDirs.push(root);
    const home = path.join(root, "dev");
    const configHome = path.join(root, "cfg");

    const fakePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
    const executeJavaScript = vi.fn(async (code: string) => {
      if (code.includes('"status"')) return { route: "/workspaces", theme: "dark" };
      if (code.includes('"targetRect"')) return { x: 100, y: 100, width: 120, height: 40 };
      if (code.includes('"react"')) return { ancestors: [{ name: "WorkspaceHeader" }] };
      if (code.includes('"logs"'))
        return { total: 1, entries: [{ level: "error", message: "boom" }] };
      return {};
    });
    const capturePage = vi.fn(async () => ({
      getSize: () => ({ width: 500, height: 320 }),
      resize: () => ({ getSize: () => ({ width: 500, height: 320 }), toPNG: () => fakePng }),
      toPNG: () => fakePng,
    }));
    const win: InspectorWindowAdapter = {
      isDestroyed: () => false,
      getContentSize: () => [1400, 900],
      webContents: { executeJavaScript, capturePage },
    };

    const srv = new EditableInspectorServer({
      home,
      configHome,
      getActiveWindow: () => win,
      getDesktopStatus: () => ({ activeChannel: "prod", activeGeneration: 12 }),
    });
    activeServers.push(srv);
    await srv.start();

    const pointer = JSON.parse(readFileSync(path.join(configHome, "inspector.json"), "utf8")) as {
      socketPath: string;
      pid: number;
    };
    expect(pointer.socketPath).toBe(srv.getSocketPath());
    expect(pointer.pid).toBe(process.pid);

    const statusRes = await getSocket(pointer.socketPath, "/status");
    expect(statusRes.status).toBe(200);
    expect(JSON.parse(statusRes.body.toString("utf8"))).toEqual({
      desktop: { activeChannel: "prod", activeGeneration: 12 },
      renderer: { route: "/workspaces", theme: "dark" },
    });

    const reactRes = await getSocket(pointer.socketPath, "/react?component=WorkspaceHeader");
    expect(reactRes.status).toBe(200);
    expect(JSON.parse(reactRes.body.toString("utf8"))).toEqual({
      ancestors: [{ name: "WorkspaceHeader" }],
    });

    srv.recordConsoleMessage(3, "Renderer crash", 12, "index.js");
    const logsRes = await getSocket(pointer.socketPath, "/logs?level=error");
    const logsJson = JSON.parse(logsRes.body.toString("utf8")) as {
      electron: Array<{ message: string }>;
    };
    expect(logsJson.electron[0]?.message).toBe("Renderer crash");

    const shotRes = await getSocket(pointer.socketPath, "/screenshot?target=true");
    expect(shotRes.status).toBe(200);
    expect(shotRes.headers["content-type"]).toBe("image/png");
    expect(shotRes.body.equals(fakePng)).toBe(true);

    srv.close();
    expect(existsSync(path.join(configHome, "inspector.json"))).toBe(false);
  });
});
