import { isWeb } from "@/constants/platform";

interface BrowserSidebarContext {
  pathname: string;
  projectKey: string | null;
}

let committedContext: BrowserSidebarContext | null = null;
let historyContextInstalled = false;

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
  function restoreContext() {
    committedContext = readContext(window.history.state);
    if (committedContext?.pathname === window.location.pathname) {
      selectProject(committedContext.projectKey);
    }
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
