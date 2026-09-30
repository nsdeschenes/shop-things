# Frontend integration acceptance

Specification [#54](https://github.com/nsdeschenes/shop-things/issues/54), behavior
decisions #47–#52, and acceptance decision
[#52](https://github.com/nsdeschenes/shop-things/issues/52#issuecomment-5909254348)
remain authoritative, with browser preview scope superseded by [#69](https://github.com/nsdeschenes/shop-things/issues/69). This document maps runnable evidence; it is not a release
certificate or a substitute for the generated same-commit record.

The owner deferred Linux automated execution and all required manual GUI checks
on September 30, 2026: “Not yet, we can ignore this for now.” Runnable Linux tooling
is retained. Linux glibc x64 is the required release platform; macOS arm64,
Windows x64 and Linux arm64 release verification remains explicitly deferred.
Unsigned local macOS automation supplies supporting evidence only.

## Requirement mapping

| Required behavior/proof                                                                    | Automated evidence                                                                                                          |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Clean contract/database/frontend emission and supporting behavior                          | Sequential acceptance source JSON reports, typecheck/build/lint; zero skipped/todo tests                                    |
| Startup/loading/setup, remembered reopen/recovery, Create/Open/Retry, pending/cancel/error | `database.spec.ts` and `foundation.spec.ts`, real IPC and persisted settings/files                                          |
| Customer CRUD/defaults/numeric/text validation/immutable-ID search/reopen                  | `customers`, `create`, `edit`, `deletion` specs, real database reopen and Chromium equivalents                              |
| Saved query/mutation/session/revision coherence and explicit recovery                      | `customers`, `deletion`, `recovery` specs; real delayed responses, stale writes, same-file fresh sessions                   |
| Exact invalid dirty values, Save/transition/lifecycle races, matching-only protocol        | `create`, `edit`, `protection`, protocol and history cases through real renderer/preload; supporting correlated-owner tests |
| Back/Forward/Cancel/link guard, native preview unload and no persistent storage            | `history`, `unload`, preview cases; actual Chromium native beforeunload and empty local/session/IndexedDB                   |
| All saved Backup/CSV, search/draft exclusion, cancel/BUSY/EEXIST                           | `savedFiles.spec.ts`, actual files/independent backup reopen                                                                |
| Separate-file Restore, both picker Cancels, source/prior preservation, failure cleanup     | `restore.spec.ts`, real files, candidate faults and remembered reopen                                                       |
| Trusted development/bundled authorization; wrong sender/frame/stale identity and cleanup   | `foundation` and boundary cases, actual IPC metadata and session frame preload fixture alongside unchanged shipped preload  |
| Guarded reload and cooperative development restarts                                        | Protection/cold Vite cases and `acceptance/watcher.mjs`, original parent IPC, graceful child exits before build/replacement |
| Normal packaged main/resources/native SQLite/preload/hash routes                           | `acceptance/packagedRenderer.mjs`, normal executable, artifact/inventory/source hashes and real UI persistence              |
| Supporting shipped backend                                                                 | Linux `test:smoke` separately identified as Electron-as-Node; never substituted for packaged renderer                       |

See [runnable commands and evidence layers](../../acceptance/README.md).
The machine record must tie all phases to clean committed sources and identify
artifacts/hashes, distribution/architecture, Electron/Chromium versions and exact
commands/logs. Final review fixes require a new clean same-head run; a report-only
commit must not invalidate the recorded source commit.

## Required manual record

Status: **deferred by owner, not executed**. Tester: **not assigned**. Date:
**not recorded**. Source commit and packaged artifact SHA: **to be supplied by
actual GUI tester**. Never infer these fields from mocked picker automation.

| Platform/workflow        | Checklist still requiring actual GUI evidence                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaged Linux glibc x64 | Native Create/Open/Backup/Export selection and Cancel; each Restore picker Cancel; Restore source/new-destination explanation; real modal owner/window and Stay safe default; failed candidate leaves usable app/draft; close/quit/guarded reload; pending/error/BUSY/dismiss feedback; active filename/full path and destination results; nested-route reload |
| Development desktop      | Dirty source restart cancelled without process/draft loss; explicit retry; graceful closure before fresh build/replacement; failed prerequisite build prevents launch and fixed source recovers                                                                                                                                                                |
| Chromium on Linux        | Dirty preview reload/close shows exactly the native unload warning; dismiss preserves edits; confirmed reload resets temporary data; browser-controlled unload limitations recorded                                                                                                                                                                            |

Required Linux automation also remains unexecuted in this session. Actions
[run 36714438402](https://github.com/nsdeschenes/shop-things/actions/runs/36714438402)
was denied before job steps by the account Actions budget, as was the earlier
[run 36704113612](https://github.com/nsdeschenes/shop-things/actions/runs/36704113612).
Retain these external blockers separately from product failures. Missing, failed,
or skipped required release checks keep release acceptance incomplete even when
local supporting automation passes.
