# Renderer acceptance

The integrated application has startup/setup/recovery, protected Create/Open/Retry,
customer CRUD and search, explicit stale/deleted/unavailable recovery, all-saved
Backup/CSV, and separate-file Restore. Browser preview requires exactly
`preview=true` and identifies temporary customer data that clears on reload.
Database Settings uses the selected overview layout, with a filename link in the
header and a collapsed file location. File operations are available only in
Electron; browser preview shows the settings page with file actions disabled.
Entering settings from a dirty editor uses the normal Stay/Discard protection.

## Run the complete automated record

Use Node 26+, pnpm 12.4.2 and a clean committed checkout. Install Chromium with
`pnpm exec playwright install chromium`. Linux headless hosts need the Electron/
Chromium desktop libraries and Xvfb; the workflow installs them.

```sh
pnpm fmt:check
pnpm typecheck
pnpm lint
xvfb-run -a node --experimental-strip-types scripts/acceptance.ts
```

The Desktop application workflow runs formatting, typecheck and lint as separate
steps before the acceptance runner. Run these same prerequisites locally before
either acceptance command. The runner handles tests, builds, renderer, packaging
and watcher checks for the desktop packages. Root script tests run separately in
the Script tooling workflow or with `pnpm test:scripts`.

CI uses this command on Linux glibc arm64 to build and test the release.
It also supports local Linux glibc x64 runs. A local unsigned macOS
arm64 supporting run is explicitly available:

```sh
node --experimental-strip-types scripts/acceptance.ts --supporting-macos
```

Set `ACCEPTANCE_REPORT_DIR` to an absolute report directory outside the checkout
when retaining evidence independently. Run source tests, builds, renderer tests,
packaging and watcher checks sequentially: they replace shared emitted outputs.
The runner refuses dirty sources, binds all reports to one commit, rejects skipped
source/renderer checks, and verifies source restoration after watcher probes.
Package smoke checks consume the existing build without rebuilding after packaging.
Preload metadata uses sorted input paths so repeated builds retain identical bytes.
CI runs formatting, lint, TypeScript and unit tests as separate workflow steps before
build and acceptance. Lint first builds the shared contract/database declarations.
It passes `--reuse-source-checks` with the current commit marker
and unit-test JSON reports in `ACCEPTANCE_REPORT_DIR`, so acceptance validates their
revision and no-skip counts without repeating those checks or dependency installation.
A passed run covers only the recorded target and executed automated checks. It does
not certify manual GUI behavior, signing, installation, or other platforms.

## Evidence layers

| Layer                                         | Runnable command                                          | What it establishes                                                                                                                                                                |
| --------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source/contract/database/components/processes | `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm lint`  | Supporting behavior, conformance and clean emission; package no-skip reports under acceptance orchestration, script tests in their own workflow                                    |
| Built renderer                                | `pnpm test:renderer`                                      | Real Electron BrowserWindow, bundled sandboxed preload and named IPC against temporary real databases; actual Chromium workflows                                                   |
| Cold development                              | `developmentBootstrap.spec.ts` in renderer suite          | Actual configured Vite with fresh dependency cache and live Electron; HMR disabled and invalid drafts retained                                                                     |
| Complete development watcher                  | `node acceptance/watcher.mjs`                             | Original develop/supervisor child IPC; Stay/explicit retry, denied parent shutdown with resumed polling, graceful replacement, failed prerequisite build and fixed-source recovery |
| Shipped backend                               | `pnpm --filter electron test:smoke` after Linux packaging | Supporting backend resource/native-driver proof using Electron as Node; not renderer proof                                                                                         |
| Normal packaged application                   | `node acceptance/packagedRenderer.mjs` after packaging    | Normal shipped executable/main, file renderer/preload, resources/driver, persisted UI workflows and artifact/source hashes                                                         |

Normal packaged proof does not use the acceptance main entry or Electron-as-Node.
The watcher uses a test-only native-dialog control entry importing production main,
with the original parent IPC preserved and standard isolated `--user-data-dir`
verified before startup. Only exact test-owned processes and temporary files are
controlled; no operator settings or application processes are used.

## Workflow coverage

- `foundation.spec.ts`: exact preview switch, live precedence, handshake/retry,
  actual subscribe/protection-before-status, delayed status/newer notification,
  trusted development/bundled URLs, blocked external navigation/new windows.
- `customers.spec.ts`, `create.spec.ts`, `edit.spec.ts`, `deletion.spec.ts`:
  canonical saved CRUD, defaults/validation/decimal/contact text, immutable IDs,
  required numbers, search, retained opaque revisions, persistence after reopen,
  delayed search/detail/write results, disabled pending-save inputs and lifecycle races.
- `recovery.spec.ts`: explicit stale reload with Stay/error/held-read/success,
  deleted copyable drafts, stale Delete, unavailable recovery and protected Retry.
- `database.spec.ts`: visible startup loading, setup/remembered reopen/failure,
  settings navigation and file location, Create/Open/Retry, silent picker Cancel,
  existing-file/schema/settings failures preserving the old session and settings page.
- `savedFiles.spec.ts`: all saved rows from settings, CSV escaping/money/null
  values, independent backup reopen, unchanged session,
  pending/Cancel/EEXIST/folder/BUSY feedback.
- `restore.spec.ts`: protected settings navigation, Stay/both picker Cancels,
  separate destination/source preservation, unsupported/migration/persistence
  failure cleanup, fresh-session reset and remembered reopen.
- `history.spec.ts`, `unload.spec.ts`: actual Back/Forward safe Stay/Discard,
  editor handoff after approved navigation, native Chromium beforeunload dismissal
  retaining invalid edits and acceptance resetting temporary data without a stacked
  custom prompt; empty local/session/IndexedDB and no native bridge.
- Boundary/protocol cases: actual unauthorized sender/frame/stale-document IPC,
  stable registration across routes and replacement cleanup, and matching-only
  stale/duplicate resolution through the actual preload transport.

Controlled native picker choices and narrowly scoped holds/failures preserve the
actual protected service and IPC under test. Automation of dialog functions does
not prove OS modal ownership or native safe-default behavior.

## Current-run reports

`acceptance.json` includes commit, OS/architecture/runtime, exact commands/results,
no-skip source counts, Playwright results, normal packaged artifacts/inventory and
watcher phase/PID evidence. Failed checks retain logs; Playwright retains traces.
Individual backend, packaged and watcher reports remain distinguishable.

`acceptance.json` schema version 3 uses `running`, `passed`, or `failed` for the
automated outcome. The target is recorded separately in `environment.target`.
On macOS, `shippedBackend.applicable` is false with a reason: that smoke check
requires a Linux release artifact. The packaged renderer and backend reports use schema
version 2 and record only their current target and executed checks. CI uploads the
report directory and renderer artifacts even when a check fails.

A passing report does not establish manual or other-platform verification;
see [frontend acceptance](../docs/acceptance/frontend.md) for those checks.
