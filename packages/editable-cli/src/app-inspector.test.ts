import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runAppInspectorCommand } from "./app-inspector.js";

const cleanupPaths: string[] = [];
const activeServers: http.Server[] = [];

afterEach(async () => {
  while (activeServers.length > 0) {
    const srv = activeServers.pop()!;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }
  while (cleanupPaths.length > 0) {
    await fs.rm(cleanupPaths.pop()!, { recursive: true, force: true });
  }
});

describe("paseo-ed app inspector CLI", () => {
  it("queries JSON endpoints and writes PNG screenshots over the local Unix socket", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-ed-app-cli-"));
    cleanupPaths.push(tmp);
    const socketPath = path.join(tmp, "inspector.sock");
    const seenUrls: string[] = [];

    const server = http.createServer((req, res) => {
      seenUrls.push(req.url ?? "");
      if ((req.url ?? "").startsWith("/screenshot")) {
        res.writeHead(200, {
          "content-type": "image/png",
          "x-screenshot-width": "640",
          "x-screenshot-height": "360",
        });
        res.end(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    activeServers.push(server);

    await fs.writeFile(
      path.join(tmp, "inspector.json"),
      JSON.stringify({ socketPath, pid: process.pid }),
      "utf8",
    );

    const status = await runAppInspectorCommand({
      editableHome: tmp,
      subcommand: "status",
      extraPositional: undefined,
      flags: {},
    });
    expect(status?.data).toEqual({ ok: true, url: "/status" });

    const react = await runAppInspectorCommand({
      editableHome: tmp,
      subcommand: "react",
      extraPositional: undefined,
      flags: { component: "WorkspaceHeader", depth: "6", full: true },
    });
    expect(react?.data).toEqual({
      ok: true,
      url: "/react?component=WorkspaceHeader&depth=6&full=true",
    });

    const outPng = path.join(tmp, "shot.png");
    const shot = await runAppInspectorCommand({
      editableHome: tmp,
      subcommand: "screenshot",
      extraPositional: undefined,
      flags: { selector: ".header", out: outPng },
    });
    expect(shot?.data).toEqual({
      ok: true,
      path: outPng,
      bytes: 4,
      width: 640,
      height: 360,
    });
    expect((await fs.readFile(outPng)).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBe(true);

    const store = await runAppInspectorCommand({
      editableHome: tmp,
      subcommand: "store",
      extraPositional: "session",
      flags: { agent: "agent-42", full: true },
    });
    expect(store?.data).toEqual({
      ok: true,
      url: "/store?name=session&agentId=agent-42&full=true",
    });
    expect(seenUrls).toHaveLength(4);
  });

  it("reports a friendly error when Paseo Dev.app is not running", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "paseo-ed-app-missing-"));
    cleanupPaths.push(tmp);
    await expect(
      runAppInspectorCommand({
        editableHome: tmp,
        subcommand: "status",
        extraPositional: undefined,
        flags: {},
      }),
    ).rejects.toThrow(/Paseo Dev\.app inspector is not running/);
  });
});
