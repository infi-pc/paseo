import { queryClient as appQueryClient } from "@/data/query-client";
import { APP_SETTINGS_QUERY_KEY } from "@/hooks/use-settings/storage";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import {
  COMPACT_SANITIZE,
  FULL_SANITIZE,
  collectDomSnapshot,
  collectReactAncestors,
  sanitizeInspectorValue,
} from "./inspector-serialize";
import type { EditableElementSnapshot, EditableHealthDigest } from "./types";

interface ConsoleLogEntry {
  level: "log" | "warn" | "error";
  message: string;
  timestamp: string;
}

interface NetworkEntry {
  kind: "fetch" | "resource";
  method: string;
  url: string;
  status: number | null;
  durationMs: number;
  error: string | null;
  timestamp: string;
}

interface PerfSample {
  kind: "longtask" | "interaction";
  name: string;
  durationMs: number;
  timestamp: string;
}

interface BreadcrumbEntry {
  kind: "click" | "route";
  label: string;
  timestamp: string;
}

const MAX_LOGS = 80;
const MAX_NETWORK = 80;
const MAX_PERF = 50;
const MAX_BREADCRUMBS = 20;

const logsRing: ConsoleLogEntry[] = [];
const networkRing: NetworkEntry[] = [];
const perfRing: PerfSample[] = [];
const breadcrumbsRing: BreadcrumbEntry[] = [];

let lastTargetElement: Element | null = null;
let currentRoutePath = "/";
let installedCount = 0;
let teardownHook: (() => void) | null = null;

function pushRing<T>(ring: T[], entry: T, max: number): void {
  ring.push(entry);
  if (ring.length > max) ring.splice(0, ring.length - max);
}

function formatArgs(args: unknown[]): string {
  return args
    .map((arg) => {
      if (typeof arg === "string") return arg;
      if (arg instanceof Error) return `${arg.name}: ${arg.message}`;
      try {
        return JSON.stringify(sanitizeInspectorValue(arg, COMPACT_SANITIZE));
      } catch {
        return String(arg);
      }
    })
    .join(" ")
    .slice(0, 1200);
}

function stripUrlSecrets(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl, window.location.origin);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/(token|secret|key|auth|password)/i.test(key)) {
        parsed.searchParams.set(key, "[redacted]");
      }
    }
    return parsed.toString();
  } catch {
    return rawUrl.slice(0, 300);
  }
}

function installConsoleCapture(): () => void {
  const origError = console.error;
  const origWarn = console.warn;
  const origLog = console.log;

  const wrap =
    (level: ConsoleLogEntry["level"], orig: (...args: unknown[]) => void) =>
    (...args: unknown[]) => {
      pushRing(
        logsRing,
        { level, message: formatArgs(args), timestamp: new Date().toISOString() },
        MAX_LOGS,
      );
      orig.apply(console, args);
    };

  console.error = wrap("error", origError);
  console.warn = wrap("warn", origWarn);
  console.log = wrap("log", origLog);

  const onError = (event: ErrorEvent) => {
    pushRing(
      logsRing,
      {
        level: "error",
        message: event.message || String(event.error ?? "Window error"),
        timestamp: new Date().toISOString(),
      },
      MAX_LOGS,
    );
  };
  const onRejection = (event: PromiseRejectionEvent) => {
    const reason =
      event.reason instanceof Error
        ? `${event.reason.name}: ${event.reason.message}`
        : String(event.reason);
    pushRing(
      logsRing,
      {
        level: "error",
        message: `Unhandled rejection: ${reason}`,
        timestamp: new Date().toISOString(),
      },
      MAX_LOGS,
    );
  };
  window.addEventListener("error", onError);
  window.addEventListener("unhandledrejection", onRejection);

  return () => {
    console.error = origError;
    console.warn = origWarn;
    console.log = origLog;
    window.removeEventListener("error", onError);
    window.removeEventListener("unhandledrejection", onRejection);
  };
}

function resolveFetchMeta(input: RequestInfo | URL, init?: RequestInit) {
  let rawUrl = "";
  let method = init?.method ?? "GET";
  if (typeof input === "string") {
    rawUrl = input;
  } else if (input instanceof URL) {
    rawUrl = input.toString();
  } else if (input && typeof input === "object" && "url" in input) {
    rawUrl = input.url;
    if (!init?.method && "method" in input && typeof input.method === "string") {
      method = input.method;
    }
  }
  return { url: stripUrlSecrets(rawUrl), method: method.toUpperCase() };
}

function installFetchCapture(): () => void {
  if (typeof window.fetch !== "function") return () => {};
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const { url, method } = resolveFetchMeta(input, init);
    const start = performance.now();
    try {
      const response = await origFetch(input, init);
      pushRing(
        networkRing,
        {
          kind: "fetch",
          method,
          url,
          status: response.status,
          durationMs: Math.round(performance.now() - start),
          error: response.ok ? null : response.statusText || `HTTP ${response.status}`,
          timestamp: new Date().toISOString(),
        },
        MAX_NETWORK,
      );
      return response;
    } catch (err) {
      pushRing(
        networkRing,
        {
          kind: "fetch",
          method,
          url,
          status: null,
          durationMs: Math.round(performance.now() - start),
          error: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        },
        MAX_NETWORK,
      );
      throw err;
    }
  };
  return () => {
    window.fetch = origFetch;
  };
}

function installPerfAndBreadcrumbs(): () => void {
  const observers: PerformanceObserver[] = [];
  if (typeof PerformanceObserver !== "undefined") {
    const observeType = (entryType: string, kind: PerfSample["kind"], minDuration: number) => {
      try {
        const obs = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            if (entry.duration < minDuration) continue;
            pushRing(
              perfRing,
              {
                kind,
                name: entry.name || entryType,
                durationMs: Math.round(entry.duration),
                timestamp: new Date().toISOString(),
              },
              MAX_PERF,
            );
          }
        });
        obs.observe({ type: entryType, buffered: true } as PerformanceObserverInit);
        observers.push(obs);
      } catch {
        // Unsupported entryType in this environment
      }
    };
    observeType("longtask", "longtask", 50);
    observeType("event", "interaction", 40);
  }

  const onClick = (event: MouseEvent) => {
    if (!(event.target instanceof Element) || event.target.closest('[data-ed-overlay="true"]')) {
      return;
    }
    const comp =
      event.target.closest("[data-ed-comp]")?.getAttribute("data-ed-comp") ??
      event.target.tagName.toLowerCase();
    const text = (event.target.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 48);
    pushRing(
      breadcrumbsRing,
      {
        kind: "click",
        label: text ? `${comp} ("${text}")` : comp,
        timestamp: new Date().toISOString(),
      },
      MAX_BREADCRUMBS,
    );
  };
  window.addEventListener("click", onClick, true);

  return () => {
    for (const obs of observers) obs.disconnect();
    window.removeEventListener("click", onClick, true);
  };
}

function buildHealthDigest(): EditableHealthDigest | undefined {
  const cutoff = Date.now() - 60_000;
  const recentErrors = logsRing.filter(
    (entry) => entry.level === "error" && Date.parse(entry.timestamp) >= cutoff,
  );
  const recentWarnings = logsRing.filter(
    (entry) => entry.level === "warn" && Date.parse(entry.timestamp) >= cutoff,
  );
  const recentFailedNet = networkRing.filter(
    (entry) => entry.error !== null && Date.parse(entry.timestamp) >= cutoff,
  );
  const recentLongTasks = perfRing.filter(
    (entry) => entry.kind === "longtask" && Date.parse(entry.timestamp) >= cutoff,
  );
  if (
    recentErrors.length === 0 &&
    recentWarnings.length === 0 &&
    recentFailedNet.length === 0 &&
    recentLongTasks.length === 0
  ) {
    return undefined;
  }
  const maxLongTaskMs = recentLongTasks.reduce((max, item) => Math.max(max, item.durationMs), 0);
  return {
    recentErrors: recentErrors.length,
    latestError: recentErrors.at(-1)?.message.slice(0, 200) ?? null,
    recentWarnings: recentWarnings.length,
    recentFailedRequests: recentFailedNet.length,
    recentLongTasks: recentLongTasks.length,
    maxLongTaskMs: maxLongTaskMs || null,
  };
}

function resolveTargetElement(options: {
  selector?: string;
  target?: boolean;
  component?: string;
}): Element | null {
  if (options.component) {
    const escaped = options.component.replace(/"/g, '\\"');
    const byAttr = document.querySelector(`[data-ed-comp="${escaped}"]`);
    if (byAttr) return byAttr;
  }
  if (options.selector) {
    try {
      const found = document.querySelector(options.selector);
      if (found) return found;
    } catch {
      return null;
    }
  }
  if (options.target !== false && lastTargetElement?.isConnected) {
    return lastTargetElement;
  }
  return null;
}

function readPerfSnapshot() {
  const perfAny = performance as Performance & {
    memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number };
  };
  const memory = perfAny.memory
    ? {
        usedMb: Math.round((perfAny.memory.usedJSHeapSize / 1048576) * 10) / 10,
        totalMb: Math.round((perfAny.memory.totalJSHeapSize / 1048576) * 10) / 10,
        limitMb: Math.round((perfAny.memory.jsHeapSizeLimit / 1048576) * 10) / 10,
      }
    : null;
  const hostMetrics = getHostRuntimeStore()
    .getHosts()
    .map((host) => {
      const snap = getHostRuntimeStore().getSnapshot(host.serverId);
      return {
        serverId: host.serverId,
        label: host.label,
        connectionStatus: snap?.connectionStatus ?? "offline",
        connection: snap?.activeConnection?.display ?? null,
        agentDirectoryStatus: snap?.agentDirectoryStatus ?? "idle",
        lastError: snap?.lastError ?? null,
        lastOnlineAt: snap?.lastOnlineAt ?? null,
      };
    });
  return {
    memory,
    longTasks: perfRing.filter((item) => item.kind === "longtask"),
    slowInteractions: perfRing.filter((item) => item.kind === "interaction"),
    hosts: hostMetrics,
    breadcrumbs: breadcrumbsRing.slice(-15),
  };
}

function readSessionStoreSnapshot(agentId?: string, full?: boolean) {
  const opts = full ? FULL_SANITIZE : COMPACT_SANITIZE;
  const sessions = useSessionStore.getState().sessions;
  const summary: Record<string, unknown> = {};
  for (const [serverId, session] of Object.entries(sessions)) {
    const agents = Array.from(session.agents.values()).map((agent) => ({
      id: agent.id,
      title: agent.title,
      provider: agent.provider,
      status: agent.status,
      modeId: agent.currentModeId,
      cwd: agent.cwd,
      workspaceId: agent.workspaceId,
      pendingPermissions: agent.pendingPermissions.length,
    }));
    let stream: unknown = undefined;
    if (agentId && session.agents.has(agentId)) {
      const tail = session.agentStreamTail.get(agentId) ?? [];
      const head = session.agentStreamHead.get(agentId) ?? [];
      stream = sanitizeInspectorValue([...tail, ...head], FULL_SANITIZE);
    }
    summary[serverId] = {
      agentCount: agents.length,
      agents: sanitizeInspectorValue(agents, opts),
      ...(stream !== undefined ? { stream } : {}),
    };
  }
  return summary;
}

function readStoreSnapshot(options: { name?: string; agentId?: string; full?: boolean }) {
  const storeName = (options.name ?? "session").toLowerCase();
  const opts = options.full ? FULL_SANITIZE : COMPACT_SANITIZE;
  if (storeName === "settings") {
    const settings = appQueryClient.getQueryData(APP_SETTINGS_QUERY_KEY);
    return {
      store: "settings",
      data: sanitizeInspectorValue(settings ?? null, opts),
    };
  }
  if (storeName === "layout") {
    const layoutState = useWorkspaceLayoutStore.getState();
    return {
      store: "layout",
      data: sanitizeInspectorValue(
        {
          layoutMode: layoutState.layoutMode,
          layoutByWorkspace: layoutState.layoutByWorkspace,
          sheetsByWorkspace: layoutState.sheetsByWorkspace,
        },
        opts,
      ),
    };
  }
  return {
    store: "session",
    data: readSessionStoreSnapshot(options.agentId, options.full),
  };
}

function buildInspectorApi() {
  return {
    status: () => {
      const settings = appQueryClient.getQueryData(APP_SETTINGS_QUERY_KEY) as
        | { themePreference?: string; density?: string; language?: string }
        | undefined;
      return {
        route: currentRoutePath,
        url: window.location.href,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          dpr: window.devicePixelRatio || 1,
        },
        theme: settings?.themePreference ?? null,
        density: settings?.density ?? null,
        hasPinnedTarget: Boolean(lastTargetElement?.isConnected),
        pinnedTarget: lastTargetElement?.isConnected
          ? {
              tag: lastTargetElement.tagName.toLowerCase(),
              comp: lastTargetElement.getAttribute("data-ed-comp"),
              src: lastTargetElement.getAttribute("data-ed-src"),
            }
          : null,
        health: buildHealthDigest() ?? null,
      };
    },
    dom: (
      options: { selector?: string; target?: boolean; depth?: number; full?: boolean } = {},
    ) => {
      const el = resolveTargetElement(options);
      if (!el) return { error: "No matching element found (click an element or pass --selector)." };
      return collectDomSnapshot(el, {
        childDepth: options.depth,
        full: options.full,
      });
    },
    react: (
      options: {
        selector?: string;
        target?: boolean;
        component?: string;
        depth?: number;
        full?: boolean;
      } = {},
    ) => {
      const el = resolveTargetElement(options);
      if (!el) return { error: "No matching element found (click an element or pass --selector)." };
      return {
        element: {
          tag: el.tagName.toLowerCase(),
          comp: el.getAttribute("data-ed-comp"),
          src: el.getAttribute("data-ed-src"),
        },
        ancestors: collectReactAncestors(el, {
          maxAncestors: options.depth ?? (options.full ? 12 : 8),
          sanitize: options.full ? FULL_SANITIZE : COMPACT_SANITIZE,
        }),
      };
    },
    logs: (options: { level?: string; limit?: number } = {}) => {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_LOGS);
      const level = options.level ?? "all";
      const filtered =
        level === "all" ? logsRing : logsRing.filter((entry) => entry.level === level);
      return { total: filtered.length, entries: filtered.slice(-limit) };
    },
    network: (options: { limit?: number; failedOnly?: boolean } = {}) => {
      const limit = Math.min(Math.max(options.limit ?? 50, 1), MAX_NETWORK);
      const filtered = options.failedOnly
        ? networkRing.filter((entry) => entry.error !== null)
        : networkRing;
      return { total: filtered.length, entries: filtered.slice(-limit) };
    },
    perf: () => readPerfSnapshot(),
    store: (options: { name?: string; agentId?: string; full?: boolean } = {}) =>
      readStoreSnapshot(options),
    targetRect: (options: { selector?: string; target?: boolean } = {}) => {
      const el = resolveTargetElement(options);
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      };
    },
  };
}

export function recordEditableRoute(route: string): void {
  if (!route || route === currentRoutePath) return;
  currentRoutePath = route;
  pushRing(
    breadcrumbsRing,
    { kind: "route", label: route, timestamp: new Date().toISOString() },
    MAX_BREADCRUMBS,
  );
}

export function captureEditableElementSnapshot(element: Element): EditableElementSnapshot {
  lastTargetElement = element;
  const dom = collectDomSnapshot(element, { childDepth: 2, ancestorDepth: 3, full: false });
  const reactAncestors = collectReactAncestors(element, {
    maxAncestors: 6,
    sanitize: COMPACT_SANITIZE,
  });
  const settings = appQueryClient.getQueryData(APP_SETTINGS_QUERY_KEY) as
    | { themePreference?: string; density?: string }
    | undefined;
  const health = buildHealthDigest();

  return {
    react: reactAncestors,
    dom: {
      tag: dom.target.tag,
      role: dom.target.role ?? null,
      rect: dom.target.rect,
      overflow: dom.overflow,
      styles: dom.target.styles ?? {},
      text: dom.text,
      ancestors: dom.ancestors.map((a) => ({
        tag: a.tag,
        comp: a.comp ?? null,
        src: a.src ?? null,
        rect: a.rect,
        styles: a.styles ?? {},
      })),
      children: dom.target.children ?? [],
    },
    viewport: dom.viewport,
    theme: settings?.themePreference ?? null,
    density: settings?.density ?? null,
    ...(health ? { health } : {}),
  };
}

export function installEditableInspector(): () => void {
  if (typeof window === "undefined") return () => {};
  installedCount += 1;
  if (installedCount === 1) {
    const cleanConsole = installConsoleCapture();
    const cleanFetch = installFetchCapture();
    const cleanPerf = installPerfAndBreadcrumbs();
    const win = window as unknown as Record<string, unknown>;
    win.__paseoEditableInspector = buildInspectorApi();
    win.__paseoEditableResolveTarget = (selector?: string, target?: boolean) =>
      resolveTargetElement({ selector, target });
    teardownHook = () => {
      cleanConsole();
      cleanFetch();
      cleanPerf();
      delete win.__paseoEditableInspector;
      delete win.__paseoEditableResolveTarget;
    };
  }
  return () => {
    installedCount = Math.max(0, installedCount - 1);
    if (installedCount === 0 && teardownHook) {
      teardownHook();
      teardownHook = null;
    }
  };
}
