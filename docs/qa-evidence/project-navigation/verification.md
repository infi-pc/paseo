# Project navigation verification

The browser run used the app's Playwright harness with its isolated daemon and mock agent provider.
It did not connect to the production daemon.

| Command                                                                                                            | Result   | Raw output                                   |
| ------------------------------------------------------------------------------------------------------------------ | -------- | -------------------------------------------- |
| `npm run typecheck`                                                                                                | Passed   | [typecheck.txt](typecheck.txt)               |
| `npm run lint`                                                                                                     | Passed   | [lint.txt](lint.txt)                         |
| `npx vitest run src/components/sidebar/sidebar-projection.test.ts --bail=1` (from `packages/app`)                  | 9 passed | [projection-tests.txt](projection-tests.txt) |
| `npx vitest run src/components/desktop-sidebar-layout.test.ts --bail=1` (from `packages/app`)                      | 8 passed | [layout-tests.txt](layout-tests.txt)         |
| `npm run test:e2e --workspace=@getpaseo/app -- e2e/browser/sidebar-workspace-mark-unread.spec.ts --max-failures=1` | 6 passed | [browser-tests.txt](browser-tests.txt)       |

The projection tests cover the 48-hour boundary, older unread sessions, snoozed exclusions,
activity aggregation across sessions, read-item retention, and activity-ordered keyboard targets.
The layout tests reserve space for the project rail beside the workspace list.

The browser tests exercise existing manual and ordinary unread behavior, multi-agent workspace
selection and history restoration, desktop project switching without workspace navigation, optional
status grouping, and mobile picker selection followed by drawer dismissal on workspace open.
The desktop navigation test also asserts that the browser console reports no errors.

## Visual evidence

- [Desktop Inbox](desktop-inbox.png)
- [Desktop project](desktop-project.png)
- [Mobile Inbox drawer](mobile-inbox.png)
- [Mobile project picker](mobile-project-picker.png)

## Platform coverage

| Platform         | Tested | Notes                                                      |
| ---------------- | ------ | ---------------------------------------------------------- |
| Browser web      | Yes    | Desktop and 390 × 844 compact viewports, Chromium          |
| iOS              | No     | Native-device verification remains                         |
| Android          | No     | Native-device verification remains                         |
| Electron macOS   | No     | Browser screenshots do not exercise Electron window chrome |
| Electron Windows | No     | Not available in this run                                  |
| Electron Linux   | No     | Not available in this run                                  |
