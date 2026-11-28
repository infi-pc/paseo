import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";

interface InspectorPointer {
  socketPath: string;
  pid?: number;
  updatedAt?: string;
}

interface InspectorHttpResponse {
  statusCode: number;
  contentType: string;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

async function readInspectorPointer(editableHome: string): Promise<InspectorPointer> {
  const pointerPath = path.join(editableHome, "inspector.json");
  let raw: string;
  try {
    raw = await fs.readFile(pointerPath, "utf8");
  } catch {
    throw new Error(
      `Paseo Dev.app inspector is not running (missing ${pointerPath}). Open Paseo Dev.app first.`,
    );
  }
  const parsed = JSON.parse(raw) as Partial<InspectorPointer>;
  if (!parsed || typeof parsed.socketPath !== "string" || !parsed.socketPath.trim()) {
    throw new Error(`Invalid inspector descriptor at ${pointerPath}`);
  }
  return {
    socketPath: parsed.socketPath,
    pid: typeof parsed.pid === "number" ? parsed.pid : undefined,
    updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
  };
}

function requestInspectorSocket(
  socketPath: string,
  requestPath: string,
  timeoutMs = 15_000,
): Promise<InspectorHttpResponse> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: requestPath,
        method: "GET",
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          resolve({
            statusCode: res.statusCode ?? 500,
            contentType: String(res.headers["content-type"] ?? ""),
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    req.on("timeout", () => {
      req.destroy(new Error(`Timed out waiting for Paseo Dev.app inspector (${requestPath})`));
    });
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "ECONNREFUSED") {
        reject(
          new Error(
            "Paseo Dev.app inspector bridge is not reachable. Open or restart Paseo Dev.app first.",
          ),
        );
        return;
      }
      reject(err);
    });
    req.end();
  });
}

function buildQuery(params: Record<string, string | number | boolean | undefined>): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === false || value === "") continue;
    qs.set(key, String(value));
  }
  const encoded = qs.toString();
  return encoded ? `?${encoded}` : "";
}

function stringFlag(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function boolFlag(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true;
}

function printAppInspectorHelp(): void {
  console.log(`paseo-ed app — Live inspect running Paseo Dev.app

Subcommands:
  paseo-ed app status [--json]
  paseo-ed app screenshot [--target | --selector <css> | --full] [--padding <px>] [--out <file.png>] [--json]
  paseo-ed app dom [--target | --selector <css>] [--depth <n>] [--full] [--json]
  paseo-ed app react [--target | --selector <css> | --component <Name>] [--depth <n>] [--full] [--json]
  paseo-ed app css [--target | --selector <css>] [--json]
  paseo-ed app logs [--level error|warn|all] [--limit <n>] [--json]
  paseo-ed app network [--limit <n>] [--failed] [--json]
  paseo-ed app perf [--json]
  paseo-ed app store [session|settings|layout] [--agent <id>] [--full] [--json]`);
}

async function fetchJsonEndpoint(socketPath: string, endpoint: string): Promise<unknown> {
  const res = await requestInspectorSocket(socketPath, endpoint);
  const text = res.body.toString("utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { raw: text };
  }
  if (res.statusCode >= 400) {
    const errMsg =
      parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : `Inspector error (${res.statusCode}): ${text.slice(0, 200)}`;
    throw new Error(errMsg);
  }
  return parsed;
}

async function runScreenshotCommand(
  editableHome: string,
  socketPath: string,
  flags: Record<string, string | boolean>,
): Promise<{ data: unknown; text: string }> {
  const query = buildQuery({
    target:
      boolFlag(flags, "target") || (!stringFlag(flags, "selector") && !boolFlag(flags, "full")),
    selector: stringFlag(flags, "selector"),
    full: boolFlag(flags, "full"),
    padding: stringFlag(flags, "padding"),
  });
  const res = await requestInspectorSocket(socketPath, `/screenshot${query}`);
  if (res.statusCode >= 400) {
    const text = res.body.toString("utf8");
    throw new Error(`Screenshot failed (${res.statusCode}): ${text.slice(0, 240)}`);
  }
  const explicitOut = stringFlag(flags, "out");
  const outPath = explicitOut
    ? path.resolve(explicitOut)
    : path.join(editableHome, "screenshots", `shot-${Date.now()}.png`);
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, res.body);
  const width = Number(res.headers["x-screenshot-width"] ?? 0) || undefined;
  const height = Number(res.headers["x-screenshot-height"] ?? 0) || undefined;
  return {
    data: { ok: true, path: outPath, bytes: res.body.length, width, height },
    text: outPath,
  };
}

function buildInspectorEndpoint(
  subcommand: string,
  extraPositional: string | undefined,
  flags: Record<string, string | boolean>,
): string | null {
  switch (subcommand) {
    case "status":
      return "/status";
    case "perf":
      return "/perf";
    case "dom":
      return `/dom${buildQuery({
        target: boolFlag(flags, "target") || !stringFlag(flags, "selector"),
        selector: stringFlag(flags, "selector"),
        depth: stringFlag(flags, "depth"),
        full: boolFlag(flags, "full"),
      })}`;
    case "react":
      return `/react${buildQuery({
        target:
          boolFlag(flags, "target") ||
          (!stringFlag(flags, "selector") && !stringFlag(flags, "component")),
        selector: stringFlag(flags, "selector"),
        component: stringFlag(flags, "component"),
        depth: stringFlag(flags, "depth"),
        full: boolFlag(flags, "full"),
      })}`;
    case "css":
      return `/css${buildQuery({
        target: boolFlag(flags, "target") || !stringFlag(flags, "selector"),
        selector: stringFlag(flags, "selector"),
      })}`;
    case "logs":
      return `/logs${buildQuery({
        level: stringFlag(flags, "level"),
        limit: stringFlag(flags, "limit"),
      })}`;
    case "network":
      return `/network${buildQuery({
        limit: stringFlag(flags, "limit"),
        failed: boolFlag(flags, "failed"),
      })}`;
    case "store":
      return `/store${buildQuery({
        name: extraPositional ?? stringFlag(flags, "name") ?? "session",
        agentId: stringFlag(flags, "agent") ?? stringFlag(flags, "agent-id"),
        full: boolFlag(flags, "full"),
      })}`;
    default:
      return null;
  }
}

export async function runAppInspectorCommand(input: {
  editableHome: string;
  subcommand: string | undefined;
  extraPositional: string | undefined;
  flags: Record<string, string | boolean>;
}): Promise<{ data: unknown; text?: string } | null> {
  const { editableHome, subcommand, extraPositional, flags } = input;
  if (!subcommand || subcommand === "help" || boolFlag(flags, "help")) {
    printAppInspectorHelp();
    return null;
  }

  const pointer = await readInspectorPointer(editableHome);
  if (subcommand === "screenshot") {
    return runScreenshotCommand(editableHome, pointer.socketPath, flags);
  }
  const endpoint = buildInspectorEndpoint(subcommand, extraPositional, flags);
  if (!endpoint) {
    throw new Error(
      `Unknown app subcommand "${subcommand}". Run \`paseo-ed app --help\` to list available commands.`,
    );
  }
  return { data: await fetchJsonEndpoint(pointer.socketPath, endpoint) };
}
