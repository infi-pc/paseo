# Fix status-change snoozing findings

This ledger owns current status for [CR3](CR3.md). The review remains a historical snapshot.

## ROUND-1 — Preserve known status observations

Date: 2026-10-07. Authorization: “ok, verify and fix the four issues.”
Review base: `886a8690317a72c1177484c3f7358bf72d943cc3`.
Reviewed implementation: `554a140ee10fbcf6ecd501a7804a5c5e01d900c6`.
Round input: `142683d18f3afcf9921bd908b483af684531355c` (adds only CR3). Working tree was clean.
Capacity: root plus three workers. GitHub and Linear fixes have separate owners; root integrates the SDK seam; a third worker owns browser evidence. Fresh verifiers will assess the completed batches.

### Keep the existing product guarantees

A selected, successfully observed difference wakes the workspace. A failed field is inconclusive, and another successful selected field remains usable. Saving requires every selected baseline to be known. Fixed identities, persisted intervals, shared GitHub rate limits, ordinary branch polling, and auto-archive eligibility stay within their existing contracts. The open question about adding omitted targets while editing is outside these four findings.

| Plan | Problem → default solution                                                                                                                                                    | Maintenance change                                                                                           | Decision                                                       | Estimated size                                     |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | -------------------------------------------------- |
| FP1  | **Shared GitHub reads time out and failed review fields become changes.** Preserve a joined fixed read's deadline and retain field-level observation failures.                | Fixed-read boundary owns scheduling and evidence validity; ordinary branch status shape remains separate.    | Mechanical, authorized; CR3-1 (S2/F2 → P2), CR3-4 (S2/F3 → P3) | Production +70…180 / −20…60; tests +100…220        |
| FP2  | **One missing Linear issue hides another issue's change.** Recover valid partial output after a completed nonzero exit and exclude errored aliases.                           | One injected CLI port replaces module spies; envelope policy stays in the Linear adapter.                    | Mechanical, authorized; CR3-2 (S2/F2 → P2)                     | Production +40…90 / −10…25; tests +60…140 / −10…30 |
| FP3  | **Populated status editing lacks visible success/failure evidence.** Add real-browser scenarios using an existing PR; replace the SDK prototype spy with an injected checker. | Reuses daemon dependency injection and existing Playwright projects, scripts, and helpers; no test-only RPC. | Mechanical, authorized; CR3-3 (S2/F0 → P2)                     | Production +3…10; tests/helpers +120…220 / −10…25  |

**FP1 detail:** The GitHub batch reader is authoritative for whether a nullable field was observed successfully. Both baseline capture and scheduled checking consume its result. A whole-PR rejection would be smaller but would also discard a known lifecycle transition when review alone failed. A second independent per-field polling path would duplicate rate-budget ownership. Use a narrow fixed-read result with independent field availability and keep callers responsible only for their selected fields. Proof must cover duplicate identities before first dispatch and during a request, errored nullable review versus legitimate null, healthy lifecycle/other targets, and failed baseline capture. Avoid merely extending the timeout.

**FP2 detail:** Keep one batched CLI request. Issuing one command per issue avoids shared failures but adds subprocess/network work and duplicates scheduling without handling malformed field data. The CLI boundary must distinguish normal nonzero completion with usable GraphQL output from killed/timed-out commands, malformed output, and unscoped failures. Strict attachment reads and link mutations remain strict. Proof exercises the rejected-process path and validates that errors on one alias do not invalidate successful aliases.

**FP3 detail:** Unit fakes can verify form state but cannot establish visible errors, persisted selections, or sidebar hiding through the real UI. Use a disposable local checkout of the already existing read-only PR `infi-pc/paseo#3` and the standard isolated real-provider browser project. Force a real daemon save rejection by archiving the temporary local workspace while the dialog is open, restore it through the real RPC, and retry with retained values. No remote writes are needed. The SDK test remains bounded to transport/scheduler composition through an explicit dependency, rather than replacing a service export. Proof includes populated desktop/compact presentation, saving/hiding/reopening, and visible failure/retry.

### Status and evidence

| Finding | Rating     | Plan | Current status  | Fixing commit |
| ------- | ---------- | ---- | --------------- | ------------- |
| CR3-1   | S2/F2 → P2 | FP1  | verified-closed | `160d23f8f`   |
| CR3-2   | S2/F2 → P2 | FP2  | verified-closed | `31b738ee3`   |
| CR3-3   | S2/F0 → P2 | FP3  | verified-closed | `42b5de2cc`   |
| CR3-4   | S2/F3 → P3 | FP1  | verified-closed | `160d23f8f`   |

Baseline: `npm run typecheck` and `npm run lint` passed before implementation. Prior passing suites remain valid baseline evidence and are not repeated without changed behavior. The original three reproductions and their counterexamples are recorded in CR3. No full local suite or main-daemon restart is authorized or needed.

### Implemented changes and closure evidence

**FP1:** A second fixed GitHub reader preserves an existing pending or in-flight request. Fixed reads now expose independently validated lifecycle and review observations, with GraphQL error paths interpreted in the adapter. Ordinary branch status remains separate. Actual size: production +121/−55; tests +261/−0 across the existing GitHub and snooze service suites. The added proof exceeds the estimate because it covers scheduling, field validity, and the complete adapter → checker → persisted snooze path.

Fresh verifier `/root/verify_github_fixes` reran both original reproductions. Concurrent reads fulfilled in 3 ms with one request (previously 60 seconds and zero requests); an errored null review yielded `unknown` with `PR #42 · Review is unavailable` (previously falsely unblocked). The verifier inspected baseline rejection, healthy sibling/lifecycle changes, genuine null reviews, and ordinary branch polling, cache, CI and host/rate-budget paths. Both findings are verified-closed; no extra poller or caller-side GraphQL policy was introduced.

**FP2:** The Linear adapter accepts usable partial output only from a normally completed nonzero command with scoped GraphQL errors. It removes errored aliases, preserves healthy aliases, and keeps strict reads/mutations strict. A typed execution dependency replaces module mocks. Actual size: production +95/−43; tests +185/−49. The higher test churn includes converting the existing suite to the execution dependency and covering terminated, malformed, unscoped, and valid-looking errored responses.

Fresh verifier `/root/verify_linear_fixes` reran the original reproduction with installed Linear CLI 2.4.0 and a temporary loopback endpoint using a dummy token. Exit 1 retained healthy APP-1 and excluded the missing sibling; the production checker returned `unblocked`, reason `APP-1: Review → Done`. The verifier checked strict reads, mutation invalidation, baseline completeness, exact IDs, cache retry, and name-only changes. CR3-2 is verified-closed. No live Linear-account reads or Windows subprocess checks were performed.

**FP3:** The SDK test now supplies the real checker through a typed daemon dependency, with injected observations, instead of spying on a service prototype. The three transport tests pass, including additive status payloads and a changed issue waking through the SDK. Actual size: production +13/−1; tests/helpers +219/−37, including the 164-line browser spec. The dependency resolver follows the existing bootstrap pattern; no test RPC, transport mock, or fake provider executable was added.

The populated browser scenarios use real GitHub reads against the existing merged PR and real local-daemon RPCs. Selection of review only with an hourly interval persists across save, sidebar hiding, reload, Show all, and reopen. Archiving the temporary workspace while the dialog remains open produces a visible `Workspace is unavailable` error; restoration and retry preserve the inputs and save successfully. The first compact attempt revealed an incorrect test scope: the shared sheet's compact test ID belongs to its header. Using unique accessible roles fixes that locator. The final compact run also requires full viewport intersection for the review switch and Save button before its screenshot.

Fresh verifier `/root/verify_browser_sdk_fixes` inspected the real-browser runs and screenshots, the SDK seam, production dependency resolution, and the provider wrapper. CR3-3 is verified-closed. Both root and verifier confirmed that the final compact Review and Save controls fit completely. Native devices and live Linear UI were not covered.

Browser evidence:

- Initial run and passing failure/retry: `/tmp/cr3-browser.log`; screenshot `packages/app/test-results/workspace-snooze.real-a-re-def60-nputs-and-succeeds-on-retry-real-provider/snooze-github-save-error.png`.
- Final populated desktop/compact run: `/tmp/cr3-browser-compact.log`; screenshots `/tmp/cr3-browser-compact/workspace-snooze.real-popu-8f603-sted-watch-at-compact-width-real-provider/snooze-github-selection-desktop.png` and `snooze-github-reopened-compact.png` in that directory. Root visually inspected the error and final compact captures.

### Validation

After the upstream sync, the 2026-10-12 commit pass reran the SDK status round-trip case
(1 passed, 2 unrelated cases deselected) and both populated browser scenarios (2 passed).
The earlier provider and scheduler results below remain the closure evidence. Every fixing
commit passed formatting, lint, and whole-workspace typecheck hooks.

- `cd packages/server && npx vitest run src/services/github-service.test.ts --bail=1`: 132 passed. The scheduling regression was first reproduced red.
- `cd packages/server && npx vitest run src/server/workspace-snooze/service.test.ts --bail=1`: 10 passed, including unavailable baseline/review and healthy change behavior through persistence.
- `cd packages/server && npx vitest run src/services/linear-service.test.ts --bail=1`: 27 passed. Partial nonzero-exit recovery was first reproduced red.
- `cd packages/server && npx vitest run src/server/workspace-snooze/transport.test.ts --bail=1`: 3 passed using isolated local daemons.
- After extracting the bootstrap dependency resolver, the changed transport case passed again with `-t 'status snooze round-trips'`; the unrelated two cases were not repeated.
- `npm run test:e2e:real --workspace=@getpaseo/app -- e2e/browser/workspace-snooze.real.spec.ts`: failure/retry passed; compact locator failed as described above. The corrected compact scenario passed with `--grep 'populated GitHub statuses' --output /tmp/cr3-browser-compact`, including full viewport assertions. Both browser scenarios now have passing evidence.
- `npm run build:server`: passed after the final production edit.
- `npm run format:check` and `git diff --check`: passed on the final changes.
- `npm run typecheck` and `npm run lint`: passed after integration. The first lint run caught an added bootstrap complexity branch; moving dependency resolution into a named helper restored the limit.

ROUND-1 tested source snapshot: SHA-256 `bd39d3caf4f6d034c0c3c9eff74f1f254bbec409e8fbc54c6584f411744b4676`, for the 11 changed/new files under `packages/` atop the round input. Computation concatenates each sorted repository-relative path, NUL, file contents, NUL. The per-file manifest is `/tmp/snooze-fix-tested-files.json`; records are excluded to avoid self-reference. Selected changes total production +229/−99 and tests/helpers +665/−86.

No native iOS/Android run, main-daemon restart, provider mutation, or full local suite was performed. The omitted-target editing question remains outside this round. Changes were uncommitted at the end of ROUND-1. Michael authorized separate commits and publication on 2026-10-12; the fixing commits are recorded above.
