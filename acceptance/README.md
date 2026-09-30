# Renderer acceptance

The integrated application has startup/setup/recovery, protected Create/Open/Retry,
customer CRUD and search, explicit stale/deleted/unavailable recovery, all-saved
Backup/CSV, and separate-file Restore. Browser preview requires exactly
`preview=true`, identifies temporary data, and labels simulated file operations.

## Run the complete automated record

Use Node 26+, pnpm 12.4.2 and a clean committed checkout. Install Chromium with
`pnpm exec playwright install chromium`. Linux headless hosts need the Electron/
Chromium desktop libraries and Xvfb; the workflow installs them.

```sh
xvfb-run -a node --experimental-strip-types scripts/acceptance.ts
```

This is the required Linux glibc x64 automated command. A local unsigned macOS
arm64 supporting run is explicitly available:

```sh
node --experimental-strip-types scripts/acceptance.ts --supporting-macos
```

Set `ACCEPTANCE_REPORT_DIR` to an absolute report directory outside the checkout
when retaining evidence independently. Run source tests, builds, renderer tests,
packaging and watcher checks sequentially: they replace shared emitted outputs.
The runner refuses dirty sources, binds all reports to one commit, rejects skipped
source/renderer checks, and verifies source restoration after watcher probes.
It never certifies deferred release or manual GUI gates.

## Evidence layers

| Layer                                         | Runnable command                                          | What it establishes                                                                                                                                                                |
| --------------------------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Source/contract/database/components/processes | `pnpm test`, `pnpm typecheck`, `pnpm build`, `pnpm lint`  | Supporting behavior, conformance and clean emission; machine no-skip reports under acceptance orchestration                                                                        |
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
  nullable numbers, search, retained opaque revisions, persistence after reopen,
  delayed search/detail/write results, pending-save edits and lifecycle races.
- `recovery.spec.ts`: explicit stale reload with Stay/error/held-read/success,
  deleted copyable drafts, stale Delete, unavailable recovery and protected Retry.
- `database.spec.ts`: visible startup loading, setup/remembered reopen/failure,
  protected Create/Open/Retry, silent picker Cancel, existing-file/schema/settings
  failures preserving the old session/view/draft even after discard approval.
- `savedFiles.spec.ts`: all saved rows despite search, CSV escaping/money/null
  values, unsaved draft exclusion, independent backup reopen, no leave prompt,
  pending/Cancel/EEXIST/folder/BUSY feedback and temporary simulations.
- `restore.spec.ts`: explanation before native action, Stay/both picker Cancels,
  separate destination/source preservation, unsupported/migration/persistence
  failure cleanup, fresh-session reset and remembered reopen; preview snapshot
  cloning and correlated cancel/failure/commit.
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

## Reports and deferred gates

`acceptance.json` includes commit, OS/architecture/runtime, exact commands/results,
no-skip source counts, Playwright results, normal packaged artifacts/inventory and
watcher phase/PID evidence. Failed checks retain logs; Playwright retains traces.
Individual backend, packaged and watcher reports remain distinguishable.

The owner explicitly deferred Linux execution and required native GUI checks for
this session. GitHub Actions run
[36714438402](https://github.com/nsdeschenes/shop-things/actions/runs/36714438402)
could not start because the Actions budget prevented use. This is an external
execution blocker, not a passing CI or product test. macOS arm64, Windows x64 and
Linux arm64 release verification remain decision-52 deferred. Local macOS automation
is supporting evidence. Required manual tester/date/checklist remains unexecuted;
see [frontend acceptance](../docs/acceptance/frontend.md).
