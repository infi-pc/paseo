import { isWeb } from "@/constants/platform";

interface BrowserSidebarContext {
  pathname: string;
  projectKey: string | null;
}

let committedContext: BrowserSidebarContext | null = null;
let historyContextInstalled = false;
let observedPathname: string | null = null;
let pendingRestore: BrowserSidebarContext | null = null;
let pendingPathname: string | null = null;
let selectSidebarProject: ((projectKey: string | null) => void) | null = null;

export function restoreBrowserSidebarContext(pathname: string): boolean {
  if (pendingPathname !== null && pendingPathname !== pathname) return false;
  observedPathname = pathname;
  if (pendingPathname === null) return true;
  pendingPathname = null;
  committedContext = pendingRestore;
  pendingRestore = null;
  if (committedContext?.pathname === pathname) selectSidebarProject?.(committedContext.projectKey);
  return true;
}

function readContext(state: unknown): BrowserSidebarContext | null {
  if (state === null || typeof state !== "object" || !("paseoSidebarContext" in state)) return null;
  const context = state.paseoSidebarContext;
  if (context === null || typeof context !== "object") return null;
  if (!("pathname" in context) || typeof context.pathname !== "string") return null;
  if (!("projectKey" in context)) return null;
  if (context.projectKey !== null && typeof context.projectKey !== "string") return null;
  return { pathname: context.pathname, projectKey: context.projectKey };
}

export function rememberBrowserSidebarContext(pathname: string, projectKey: string | null): void {
  if (!isWeb || typeof window === "undefined") return;
  committedContext = { pathname, projectKey };
  if (window.location.pathname === pathname) {
    window.history.replaceState(window.history.state, "");
  }
}

export function initializeBrowserSidebarContext(
  selectProject: (projectKey: string | null) => void,
): void {
  if (!isWeb || typeof window === "undefined" || historyContextInstalled) return;
  installHistoryContext();
  historyContextInstalled = true;
  selectSidebarProject = selectProject;
  function restoreContext() {
    pendingRestore = readContext(window.history.state);
    pendingPathname = window.location.pathname;
    // Router POP_TO also traverses browser history before replacing the old URL.
    // Restore only when the app commits that entry, not during this intermediate hop.
    if (observedPathname === window.location.pathname)
      restoreBrowserSidebarContext(observedPathname);
  }
  // Root layouts can be between mounts when popstate fires. The store action and
  // browser listener share the JS session lifetime, as do the history wrappers.
  window.addEventListener("popstate", restoreContext, true);
}

function installHistoryContext() {
  const history = window.history;
  const originalPush = history.pushState;
  const originalReplace = history.replaceState;

  // React Navigation writes {id} after the React recorder runs. Merge at the browser
  // boundary so its delayed writes retain this visit's context and its own entry identity.
  function stateWithContext(
    data: unknown,
    url: string | URL | null | undefined,
    previous: unknown,
  ) {
    const pathname = new URL(url ?? window.location.href, window.location.href).pathname;
    if (pendingPathname !== null && pendingPathname !== pathname) {
      pendingRestore = null;
      pendingPathname = null;
    }
    let context = committedContext;
    if (context?.pathname !== pathname) context = readContext(data);
    if (context?.pathname !== pathname) context = readContext(previous);
    if (context?.pathname !== pathname) return data;
    const state = data !== null && typeof data === "object" ? data : {};
    return { ...state, paseoSidebarContext: context };
  }
  function pushState(data: unknown, unused: string, url?: string | URL | null) {
    originalPush.call(history, stateWithContext(data, url, null), unused, url);
  }
  function replaceState(data: unknown, unused: string, url?: string | URL | null) {
    originalReplace.call(history, stateWithContext(data, url, history.state), unused, url);
  }
  // The root recorder can remount during route changes. Keep the browser boundary
  // installed for this JS session so a delayed router write retains the departing visit.
  history.pushState = pushState;
  history.replaceState = replaceState;
}
