import { isWeb } from "@/constants/platform";
import type { EditableTarget } from "./locator.ts";
import { routeLocatorContext, type EditableRouteContext } from "./types";

interface ReactFiber {
  type?: { name?: string; displayName?: string; render?: { name?: string } };
  return?: ReactFiber;
  _debugOwner?: ReactFiber;
  _debugSource?: { fileName: string; lineNumber: number; columnNumber?: number };
}

function componentName(value: unknown): string | null {
  return typeof value === "string" && /^[A-Z][\w$]{0,119}$/.test(value) ? value : null;
}

function sourceLocation(value: string) {
  const match = /^(packages\/app\/src\/[\w./$[\]()-]+\.[jt]sx?):([1-9]\d*):([1-9]\d*)$/.exec(value);
  if (!match || match[1].split("/").some((part) => part === ".." || part === "." || !part)) {
    return null;
  }
  const line = Number(match[2]);
  const column = Number(match[3]);
  return Number.isSafeInteger(line) && Number.isSafeInteger(column)
    ? { file: match[1], line, column }
    : null;
}

function fiberLocation(source: ReactFiber["_debugSource"]) {
  if (!source) return null;
  const file = source.fileName.match(/(?:^|[\\/])(packages[\\/]app[\\/]src[\\/].+)$/)?.[1];
  return file
    ? sourceLocation(
        `${file.replaceAll("\\", "/")}:${source.lineNumber}:${source.columnNumber ?? 1}`,
      )
    : null;
}

function inspectFiber(element: Element) {
  const key = Object.keys(element).find((property) => property.startsWith("__reactFiber$"));
  const fiber = key ? (element as unknown as Record<string, ReactFiber>)[key] : undefined;
  let name: string | null = null;
  let location: ReturnType<typeof sourceLocation> = null;
  for (
    let node = fiber, depth = 0;
    node && depth < 40;
    node = node._debugOwner ?? node.return, depth++
  ) {
    name ??= componentName(node.type?.displayName ?? node.type?.name ?? node.type?.render?.name);
    location ??= fiberLocation(node._debugSource);
    if (location && name) break;
  }
  return { name, location };
}

export function locateEditableTarget(
  target: unknown,
  route: EditableRouteContext,
): EditableTarget | null {
  if (!isWeb || !(target instanceof Element) || target.closest('[data-ed-overlay="true"]')) {
    return null;
  }
  const base = routeLocatorContext(route);
  for (let element: Element | null = target; element; element = element.parentElement) {
    const location = sourceLocation(element.getAttribute("data-ed-src") ?? "");
    if (location) {
      const name =
        componentName(element.getAttribute("data-ed-comp")) ?? inspectFiber(element).name;
      return { element, context: { ...base, ...location, componentName: name } };
    }
  }
  for (let element: Element | null = target; element; element = element.parentElement) {
    const { name, location } = inspectFiber(element);
    if (location) return { element, context: { ...base, ...location, componentName: name } };
  }
  return null;
}
