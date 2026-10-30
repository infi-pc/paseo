export function rememberBrowserSidebarContext(
  _pathname: string,
  _projectKey: string | null,
): void {}

export function initializeBrowserSidebarContext(
  _selectProject: (projectKey: string | null) => void,
): void {}
export function restoreBrowserSidebarContext(_pathname: string): boolean {
  return true;
}
