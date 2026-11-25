import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import type { BrowserWindow, Rectangle } from "electron";

export interface EditableScreenshotResult {
  ok: boolean;
  dataBase64?: string;
  mimeType?: "image/png";
  width?: number;
  height?: number;
  error?: string;
}

export interface ScreenshotRectInput {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface MainConsoleEntry {
  level: "log" | "warn" | "error";
  message: string;
  sourceId: string;
  line: number;
  timestamp: string;
}

export interface InspectorWindowAdapter {
  isDestroyed(): boolean;
  getContentSize(): number[];
  webContents: {
    executeJavaScript(code: string, userGesture?: boolean): Promise<unknown>;
    capturePage(rect?: Rectangle): Promise<{
      getSize(): { width: number; height: number };
      resize(options: { width?: number; height?: number }): {
        getSize(): { width: number; height: number };
        toPNG(): Buffer;
      };
      toPNG(): Buffer;
    }>;
    debugger?: {
      isAttached(): boolean;
      attach(protocolVersion?: string): void;
      detach(): void;
      sendCommand(method: string, params?: Record<string, unknown>): Promise<unknown>;
    };
  };
}

export function computeScreenshotCropRect(
  rect: ScreenshotRectInput,
  contentSize: [number, number],
  padding = 140,
): Rectangle {
  const [contentW, contentH] = contentSize;
  const pad = Math.max(0, Math.min(400, Math.round(padding)));
  const rawX = Math.max(0, Math.floor(rect.x - pad));
  const rawY = Math.max(0, Math.floor(rect.y - pad));
  const rawRight = Math.min(contentW, Math.ceil(rect.x + rect.width + pad));
  const rawBottom = Math.min(contentH, Math.ceil(rect.y + rect.height + pad));

  const minW = Math.min(contentW, 460);
  const minH = Math.min(contentH, 280);
  const maxW = Math.min(contentW, 1200);
  const maxH = Math.min(contentH, 820);

  let width = Math.max(minW, Math.min(maxW, rawRight - rawX));
  let height = Math.max(minH, Math.min(maxH, rawBottom - rawY));
  const x = Math.max(0, Math.min(contentW - width, rawX));
  const y = Math.max(0, Math.min(contentH - height, rawY));
  width = Math.max(1, Math.min(contentW - x, width));
  height = Math.max(1, Math.min(contentH - y, height));

  return { x, y, width, height };
}

export async function captureWindowScreenshot(
  win: InspectorWindowAdapter,
  options: { rect?: ScreenshotRectInput | null; full?: boolean; padding?: number } = {},
): Promise<{ png: Buffer; width: number; height: number }> {
  if (win.isDestroyed()) throw new Error("Window is closed");
  const size = win.getContentSize();
  const contentW = Math.max(1, size[0] ?? 1200);
  const contentH = Math.max(1, size[1] ?? 800);
  const crop =
    !options.full && options.rect && options.rect.width > 0 && options.rect.height > 0
      ? computeScreenshotCropRect(options.rect, [contentW, contentH], options.padding ?? 140)
      : undefined;

  const rawImage = await win.webContents.capturePage(crop);
  const rawSize = rawImage.getSize();
  const finalImage = rawSize.width > 1200 ? rawImage.resize({ width: 1200 }) : rawImage;
  const finalSize = finalImage.getSize();
  return {
    png: finalImage.toPNG(),
    width: finalSize.width,
    height: finalSize.height,
  };
}

async function queryMatchedCssViaCdp(
  win: InspectorWindowAdapter,
  selector: string | undefined,
  useTarget: boolean,
): Promise<unknown> {
  const dbg = win.webContents.debugger;
  if (!dbg) return { error: "CDP debugger unavailable in this Electron window" };

  const alreadyAttached = dbg.isAttached();
  if (!alreadyAttached) dbg.attach("1.3");
  try {
    await dbg.sendCommand("DOM.enable");
    await dbg.sendCommand("CSS.enable");
    const evalExpr = `window.__paseoEditableResolveTarget?.(${JSON.stringify(selector ?? null)}, ${JSON.stringify(useTarget)}) ?? null`;
    const evalRes = (await dbg.sendCommand("Runtime.evaluate", {
      expression: evalExpr,
      returnByValue: false,
    })) as { result?: { objectId?: string } };
    const objectId = evalRes.result?.objectId;
    if (!objectId) {
      return { error: "No matching element found for CSS rule inspection" };
    }
    const nodeRes = (await dbg.sendCommand("DOM.requestNode", { objectId })) as { nodeId?: number };
    if (!nodeRes.nodeId) return { error: "Could not resolve DOM nodeId" };

    const styles = (await dbg.sendCommand("CSS.getMatchedStylesForNode", {
      nodeId: nodeRes.nodeId,
    })) as {
      inlineStyle?: { cssProperties?: Array<{ name: string; value: string }> };
      matchedCSSRules?: Array<{
        rule?: {
          selectorList?: { text?: string };
          origin?: string;
          style?: { cssProperties?: Array<{ name: string; value: string; disabled?: boolean }> };
        };
      }>;
    };

    const inlineProps = (styles.inlineStyle?.cssProperties ?? [])
      .filter((p) => p.name && p.value)
      .map((p) => `${p.name}: ${p.value}`);
    const rules = (styles.matchedCSSRules ?? [])
      .filter((entry) => entry.rule?.origin !== "user-agent")
      .slice(-20)
      .map((entry) => ({
        selector: entry.rule?.selectorList?.text ?? "",
        origin: entry.rule?.origin ?? "regular",
        properties: (entry.rule?.style?.cssProperties ?? [])
          .filter((p) => p.name && p.value && !p.disabled)
          .slice(0, 30)
          .map((p) => `${p.name}: ${p.value}`),
      }));
    return { inline: inlineProps, matchedRules: rules };
  } finally {
    if (!alreadyAttached) {
      try {
        dbg.detach();
      } catch {
        // Already detached
      }
    }
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function parseBoolParam(url: URL, name: string): boolean {
  const val = url.searchParams.get(name);
  return val === "1" || val === "true";
}

function parseIntParam(url: URL, name: string): number | undefined {
  const raw = url.searchParams.get(name);
  if (!raw) return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? Math.round(num) : undefined;
}

export class EditableInspectorServer {
  private server: http.Server | null = null;
  private readonly socketPath: string;
  private readonly pointerPath: string;
  private readonly mainLogs: MainConsoleEntry[] = [];

  constructor(
    private readonly deps: {
      home: string;
      configHome: string;
      getActiveWindow: () => InspectorWindowAdapter | null;
      getDesktopStatus?: () => unknown;
      getProcessMetrics?: () => unknown;
      warn?: (error: unknown) => void;
    },
  ) {
    this.socketPath = path.join(deps.home, "editable-inspector.sock");
    this.pointerPath = path.join(deps.configHome, "inspector.json");
  }

  getSocketPath(): string {
    return this.socketPath;
  }

  recordConsoleMessage(level: number, message: string, line: number, sourceId: string): void {
    let mapped: MainConsoleEntry["level"] = "log";
    if (level >= 3) mapped = "error";
    else if (level === 2) mapped = "warn";
    this.mainLogs.push({
      level: mapped,
      message: message.slice(0, 1000),
      sourceId,
      line,
      timestamp: new Date().toISOString(),
    });
    if (this.mainLogs.length > 80) this.mainLogs.splice(0, this.mainLogs.length - 80);
  }

  async start(): Promise<void> {
    if (this.server) return;
    mkdirSync(this.deps.home, { recursive: true, mode: 0o700 });
    mkdirSync(this.deps.configHome, { recursive: true, mode: 0o700 });
    rmSync(this.socketPath, { force: true });

    const server = http.createServer((req, res) => {
      void this.handleRequest(req, res).catch((err) => {
        sendJson(res, 500, { error: err instanceof Error ? err.message : String(err) });
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(this.socketPath, () => {
        server.off("error", reject);
        resolve();
      });
    });
    try {
      chmodSync(this.socketPath, 0o600);
    } catch {
      // Best-effort permission lock on socket
    }
    this.server = server;
    this.writePointer();
  }

  close(): void {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    rmSync(this.socketPath, { force: true });
    try {
      const raw = JSON.parse(readFileSync(this.pointerPath, "utf8")) as { pid?: number };
      if (raw.pid === process.pid) rmSync(this.pointerPath, { force: true });
    } catch {
      // Already removed or owned by another instance
    }
  }

  private writePointer(): void {
    const tmp = `${this.pointerPath}.${randomUUID()}.tmp`;
    const payload = {
      socketPath: this.socketPath,
      pid: process.pid,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmp, this.pointerPath);
  }

  private async callRendererInspector(
    win: InspectorWindowAdapter,
    method: string,
    args?: Record<string, unknown>,
  ): Promise<unknown> {
    const serialized = args === undefined ? "" : JSON.stringify(args);
    const code = `(() => { const api = window.__paseoEditableInspector; if (!api || typeof api[${JSON.stringify(method)}] !== "function") return { error: "Editable inspector is not active in the renderer yet." }; return api[${JSON.stringify(method)}](${serialized}); })()`;
    return win.webContents.executeJavaScript(code, false);
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== "GET") {
      sendJson(res, 405, { error: "Only read-only GET requests are allowed" });
      return;
    }
    const url = new URL(req.url ?? "/", "http://localhost");
    const win = this.deps.getActiveWindow();
    if (!win || win.isDestroyed()) {
      sendJson(res, 503, { error: "No active Paseo Dev.app window is open" });
      return;
    }
    await this.dispatchRoute(url, win, res);
  }

  private async dispatchRoute(
    url: URL,
    win: InspectorWindowAdapter,
    res: http.ServerResponse,
  ): Promise<void> {
    const pathname = url.pathname;
    if (pathname === "/status") {
      const renderer = await this.callRendererInspector(win, "status");
      sendJson(res, 200, {
        desktop: this.deps.getDesktopStatus?.() ?? null,
        renderer,
      });
      return;
    }
    if (pathname === "/screenshot") {
      await this.handleScreenshotRoute(url, win, res);
      return;
    }
    if (pathname === "/css") {
      const selector = url.searchParams.get("selector") ?? undefined;
      const target = parseBoolParam(url, "target") || !selector;
      sendJson(res, 200, await queryMatchedCssViaCdp(win, selector, target));
      return;
    }
    if (pathname === "/logs") {
      const level = url.searchParams.get("level") ?? "all";
      const limit = parseIntParam(url, "limit") ?? 50;
      const renderer = await this.callRendererInspector(win, "logs", { level, limit });
      const electronLogs =
        level === "all" ? this.mainLogs : this.mainLogs.filter((entry) => entry.level === level);
      sendJson(res, 200, { renderer, electron: electronLogs.slice(-limit) });
      return;
    }
    if (pathname === "/perf") {
      const renderer = await this.callRendererInspector(win, "perf");
      sendJson(res, 200, { renderer, processMetrics: this.deps.getProcessMetrics?.() ?? null });
      return;
    }
    await this.dispatchSimpleRendererRoute(url, win, res);
  }

  private async handleScreenshotRoute(
    url: URL,
    win: InspectorWindowAdapter,
    res: http.ServerResponse,
  ): Promise<void> {
    const full = parseBoolParam(url, "full");
    const selector = url.searchParams.get("selector") ?? undefined;
    const target = parseBoolParam(url, "target");
    const padding = parseIntParam(url, "padding");

    let rect: ScreenshotRectInput | null = null;
    if (!full) {
      const resolved = await this.callRendererInspector(win, "targetRect", { selector, target });
      if (resolved && typeof resolved === "object" && "width" in resolved) {
        rect = resolved as ScreenshotRectInput;
      }
    }
    const shot = await captureWindowScreenshot(win, { rect, full, padding });
    res.writeHead(200, {
      "content-type": "image/png",
      "x-screenshot-width": String(shot.width),
      "x-screenshot-height": String(shot.height),
    });
    res.end(shot.png);
  }

  private async dispatchSimpleRendererRoute(
    url: URL,
    win: InspectorWindowAdapter,
    res: http.ServerResponse,
  ): Promise<void> {
    const pathname = url.pathname;
    if (pathname === "/dom") {
      const data = await this.callRendererInspector(win, "dom", {
        selector: url.searchParams.get("selector") ?? undefined,
        target: parseBoolParam(url, "target"),
        depth: parseIntParam(url, "depth"),
        full: parseBoolParam(url, "full"),
      });
      sendJson(res, 200, data);
      return;
    }
    if (pathname === "/react") {
      const data = await this.callRendererInspector(win, "react", {
        selector: url.searchParams.get("selector") ?? undefined,
        target: parseBoolParam(url, "target"),
        component: url.searchParams.get("component") ?? undefined,
        depth: parseIntParam(url, "depth"),
        full: parseBoolParam(url, "full"),
      });
      sendJson(res, 200, data);
      return;
    }
    if (pathname === "/network") {
      const data = await this.callRendererInspector(win, "network", {
        limit: parseIntParam(url, "limit"),
        failedOnly: parseBoolParam(url, "failed"),
      });
      sendJson(res, 200, data);
      return;
    }
    if (pathname === "/store") {
      const data = await this.callRendererInspector(win, "store", {
        name: url.searchParams.get("name") ?? "session",
        agentId: url.searchParams.get("agentId") ?? undefined,
        full: parseBoolParam(url, "full"),
      });
      sendJson(res, 200, data);
      return;
    }
    sendJson(res, 404, { error: `Unknown inspector route: ${pathname}` });
  }
}

export function asInspectorWindow(win: BrowserWindow): InspectorWindowAdapter {
  return win as unknown as InspectorWindowAdapter;
}
