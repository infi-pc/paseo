export interface SanitizeOptions {
  maxDepth: number;
  maxStringLength: number;
  maxArrayItems: number;
  maxKeys: number;
}

export const COMPACT_SANITIZE: SanitizeOptions = {
  maxDepth: 3,
  maxStringLength: 400,
  maxArrayItems: 12,
  maxKeys: 24,
};

export const FULL_SANITIZE: SanitizeOptions = {
  maxDepth: 6,
  maxStringLength: 4000,
  maxArrayItems: 60,
  maxKeys: 80,
};

const SECRET_KEY_RE =
  /^(authorization|cookie|set-cookie)$|(token|secret|password|passwd|apikey|api_key|privatekey|private_key|credential)/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key);
}

function describeObjectTag(value: object): string | null {
  if ("$$typeof" in value) {
    const type = (value as { type?: { displayName?: string; name?: string } | string }).type;
    const name = typeof type === "string" ? type : (type?.displayName ?? type?.name ?? "Element");
    return `<${name} />`;
  }
  if (typeof Element !== "undefined" && value instanceof Element) {
    return `<${value.tagName.toLowerCase()}>`;
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof RegExp) return String(value);
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  return null;
}

function sanitizeArray(
  arr: unknown[],
  depth: number,
  opts: SanitizeOptions,
  seen: WeakSet<object>,
): unknown[] {
  const limit = Math.min(arr.length, opts.maxArrayItems);
  const out: unknown[] = [];
  for (let i = 0; i < limit; i += 1) {
    out.push(sanitizeInner(arr[i], depth + 1, opts, seen));
  }
  if (arr.length > limit) out.push(`…(+${arr.length - limit} items)`);
  return out;
}

function sanitizeRecord(
  obj: Record<string, unknown>,
  depth: number,
  opts: SanitizeOptions,
  seen: WeakSet<object>,
): Record<string, unknown> {
  const keys = Object.keys(obj);
  const limit = Math.min(keys.length, opts.maxKeys);
  const out: Record<string, unknown> = {};
  for (let i = 0; i < limit; i += 1) {
    const key = keys[i]!;
    if (key.startsWith("__react")) continue;
    if (isSecretKey(key)) {
      out[key] = "[redacted]";
      continue;
    }
    const raw = obj[key];
    if (typeof raw === "function") {
      out[key] = "[fn]";
      continue;
    }
    out[key] = sanitizeInner(raw, depth + 1, opts, seen);
  }
  if (keys.length > limit) out.__truncatedKeys = keys.length - limit;
  return out;
}

function sanitizeInner(
  value: unknown,
  depth: number,
  opts: SanitizeOptions,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") {
    return value.length > opts.maxStringLength
      ? `${value.slice(0, opts.maxStringLength)}…(+${value.length - opts.maxStringLength} chars)`
      : value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "symbol") return String(value);
  if (typeof value === "function") return "[fn]";
  if (typeof value !== "object") return String(value);

  const tagged = describeObjectTag(value);
  if (tagged !== null) return tagged;
  if (seen.has(value)) return "[circular]";
  if (depth >= opts.maxDepth) return Array.isArray(value) ? `[Array(${value.length})]` : "[Object]";

  seen.add(value);
  if (value instanceof Map) {
    const entries = Array.from(value.entries()).slice(0, opts.maxKeys);
    const rec: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      const key = String(k);
      rec[key] = isSecretKey(key) ? "[redacted]" : sanitizeInner(v, depth + 1, opts, seen);
    }
    return rec;
  }
  if (value instanceof Set) {
    return sanitizeArray(Array.from(value), depth, opts, seen);
  }
  if (Array.isArray(value)) return sanitizeArray(value, depth, opts, seen);
  return sanitizeRecord(value as Record<string, unknown>, depth, opts, seen);
}

export function sanitizeInspectorValue(
  value: unknown,
  opts: SanitizeOptions = COMPACT_SANITIZE,
): unknown {
  return sanitizeInner(value, 0, opts, new WeakSet<object>());
}

export interface ReactFiberNode {
  tag?: number;
  type?:
    | string
    | {
        name?: string;
        displayName?: string;
        render?: { name?: string; displayName?: string };
        type?: { name?: string; displayName?: string };
      };
  return?: ReactFiberNode | null;
  _debugOwner?: ReactFiberNode | null;
  _debugSource?: { fileName: string; lineNumber: number; columnNumber?: number };
  memoizedProps?: Record<string, unknown>;
  memoizedState?: {
    memoizedState?: unknown;
    queue?: unknown;
    next?: unknown;
  } | null;
}

export interface InspectedReactComponent {
  name: string;
  source: string | null;
  props: Record<string, unknown>;
  hooks: unknown[];
}

function getFiberComponentName(type: ReactFiberNode["type"]): string | null {
  if (!type || typeof type === "string") return null;
  const candidate =
    type.displayName ??
    type.name ??
    type.render?.displayName ??
    type.render?.name ??
    type.type?.displayName ??
    type.type?.name;
  return typeof candidate === "string" && /^[A-Z][\w$.]{0,119}$/.test(candidate) ? candidate : null;
}

function getFiberSource(node: ReactFiberNode): string | null {
  const src = node._debugSource;
  if (src?.fileName) {
    const rel = src.fileName.match(/(?:^|[\\/])(packages[\\/]app[\\/]src[\\/].+)$/)?.[1];
    const clean = rel ? rel.replaceAll("\\", "/") : src.fileName;
    return `${clean}:${src.lineNumber}:${src.columnNumber ?? 1}`;
  }
  const stamped = node.memoizedProps?.["data-ed-src"];
  return typeof stamped === "string" ? stamped : null;
}

function isEffectHookState(val: unknown): boolean {
  return Boolean(
    val && typeof val === "object" && "tag" in val && "create" in val && "deps" in val,
  );
}

function extractFiberHooks(node: ReactFiberNode, opts: SanitizeOptions, maxHooks = 8): unknown[] {
  const hooks: unknown[] = [];
  let cursor = node.memoizedState;
  let steps = 0;
  while (cursor && typeof cursor === "object" && steps < 30 && hooks.length < maxHooks) {
    steps += 1;
    const val = cursor.memoizedState;
    if (cursor.queue && !isEffectHookState(val)) {
      hooks.push(sanitizeInspectorValue(val, opts));
    }
    cursor = (cursor.next as ReactFiberNode["memoizedState"]) ?? null;
  }
  return hooks;
}

function extractFiberProps(node: ReactFiberNode, opts: SanitizeOptions): Record<string, unknown> {
  const raw = node.memoizedProps;
  if (!raw || typeof raw !== "object") return {};
  const filtered: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(raw)) {
    if (key === "children" && typeof val !== "string" && typeof val !== "number") continue;
    if (key === "data-ed-src" || key === "data-ed-comp") continue;
    filtered[key] = val;
  }
  return sanitizeInspectorValue(filtered, opts) as Record<string, unknown>;
}

export function getElementFiber(element: Element): ReactFiberNode | null {
  const key = Object.keys(element).find((prop) => prop.startsWith("__reactFiber$"));
  if (!key) return null;
  return (
    ((element as unknown as Record<string, unknown>)[key] as ReactFiberNode | undefined) ?? null
  );
}

const SKIP_WRAPPER_NAMES = new Set([
  "View",
  "Text",
  "Pressable",
  "ScrollView",
  "AnimatedComponent",
  "ContextProvider",
  "ContextConsumer",
  "Fragment",
]);

export function collectReactAncestors(
  element: Element,
  options: { maxAncestors?: number; sanitize?: SanitizeOptions } = {},
): InspectedReactComponent[] {
  const maxAncestors = options.maxAncestors ?? 6;
  const sanitize = options.sanitize ?? COMPACT_SANITIZE;
  const start = getElementFiber(element);
  if (!start) return [];

  const result: InspectedReactComponent[] = [];
  let node: ReactFiberNode | null | undefined = start;
  let steps = 0;
  while (node && steps < 80 && result.length < maxAncestors) {
    steps += 1;
    const name = getFiberComponentName(node.type);
    if (name && !SKIP_WRAPPER_NAMES.has(name)) {
      result.push({
        name,
        source: getFiberSource(node),
        props: extractFiberProps(node, sanitize),
        hooks: extractFiberHooks(node, sanitize),
      });
    }
    node = node.return;
  }
  return result;
}

const STYLE_KEYS = [
  "display",
  "position",
  "flex-direction",
  "flex-wrap",
  "align-items",
  "justify-content",
  "flex",
  "gap",
  "width",
  "height",
  "min-width",
  "max-width",
  "min-height",
  "max-height",
  "padding",
  "margin",
  "border",
  "border-radius",
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "line-height",
  "font-family",
  "overflow",
  "overflow-x",
  "overflow-y",
  "opacity",
  "z-index",
  "cursor",
  "white-space",
  "text-overflow",
] as const;

const IGNORED_STYLE_VALUES = new Set([
  "",
  "none",
  "normal",
  "auto",
  "0px",
  "0px none rgb(0, 0, 0)",
  "rgba(0, 0, 0, 0)",
  "transparent",
  "visible",
  "static",
  "1",
  "nowrap",
]);

export function readComputedStyles(element: Element): Record<string, string> {
  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") return {};
  const cs = window.getComputedStyle(element);
  const out: Record<string, string> = {};
  for (const prop of STYLE_KEYS) {
    const val = cs.getPropertyValue(prop).trim();
    if (!val || IGNORED_STYLE_VALUES.has(val)) continue;
    if (prop === "border" && val.startsWith("0px ")) continue;
    out[prop] = val;
  }
  return out;
}

export interface InspectedDomNode {
  tag: string;
  id?: string;
  role?: string;
  comp?: string;
  src?: string;
  rect: { x: number; y: number; width: number; height: number };
  text?: string;
  styles?: Record<string, string>;
  children?: InspectedDomNode[];
}

function roundRect(rect: DOMRect) {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function compactElementText(el: Element, maxLen: number): string | undefined {
  const raw = (el.textContent ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return undefined;
  return raw.length > maxLen ? `${raw.slice(0, maxLen)}…` : raw;
}

function summarizeDomNode(
  el: Element,
  depth: number,
  maxDepth: number,
  maxText: number,
  includeStyles: boolean,
): InspectedDomNode {
  const node: InspectedDomNode = {
    tag: el.tagName.toLowerCase(),
    rect: roundRect(el.getBoundingClientRect()),
  };
  if (el.id) node.id = el.id;
  const role = el.getAttribute("role");
  if (role) node.role = role;
  const comp = el.getAttribute("data-ed-comp");
  if (comp) node.comp = comp;
  const src = el.getAttribute("data-ed-src");
  if (src) node.src = src;
  const text = compactElementText(el, maxText);
  if (text && el.children.length === 0) node.text = text;
  if (includeStyles) node.styles = readComputedStyles(el);

  if (depth < maxDepth && el.children.length > 0) {
    const kids: InspectedDomNode[] = [];
    const limit = Math.min(el.children.length, 10);
    for (let i = 0; i < limit; i += 1) {
      kids.push(summarizeDomNode(el.children[i]!, depth + 1, maxDepth, maxText, false));
    }
    node.children = kids;
  }
  return node;
}

export interface InspectedDomSnapshot {
  target: InspectedDomNode;
  text: string | null;
  overflow: {
    horizontal: boolean;
    vertical: boolean;
    scrollWidth: number;
    clientWidth: number;
    scrollHeight: number;
    clientHeight: number;
  };
  viewport: {
    width: number;
    height: number;
    dpr: number;
    scrollX: number;
    scrollY: number;
  };
  ancestors: InspectedDomNode[];
}

export function collectDomSnapshot(
  element: Element,
  options: { childDepth?: number; ancestorDepth?: number; full?: boolean } = {},
): InspectedDomSnapshot {
  const childDepth = options.childDepth ?? (options.full ? 4 : 2);
  const ancestorDepth = options.ancestorDepth ?? (options.full ? 5 : 3);
  const maxText = options.full ? 4000 : 400;

  const target = summarizeDomNode(element, 0, childDepth, maxText, true);
  const ancestors: InspectedDomNode[] = [];
  let cur = element.parentElement;
  for (let i = 0; i < ancestorDepth && cur; i += 1) {
    ancestors.push(summarizeDomNode(cur, 0, 0, 120, true));
    cur = cur.parentElement;
  }

  const htmlEl = element as HTMLElement;
  const scrollWidth = htmlEl.scrollWidth ?? 0;
  const clientWidth = htmlEl.clientWidth ?? 0;
  const scrollHeight = htmlEl.scrollHeight ?? 0;
  const clientHeight = htmlEl.clientHeight ?? 0;

  return {
    target,
    text: compactElementText(element, maxText) ?? null,
    overflow: {
      horizontal: scrollWidth > clientWidth + 1,
      vertical: scrollHeight > clientHeight + 1,
      scrollWidth,
      clientWidth,
      scrollHeight,
      clientHeight,
    },
    viewport: {
      width: typeof window !== "undefined" ? window.innerWidth : 0,
      height: typeof window !== "undefined" ? window.innerHeight : 0,
      dpr: typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1,
      scrollX: typeof window !== "undefined" ? Math.round(window.scrollX) : 0,
      scrollY: typeof window !== "undefined" ? Math.round(window.scrollY) : 0,
    },
    ancestors,
  };
}
