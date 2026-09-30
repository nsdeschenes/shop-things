# Frontend integration acceptance

Specification [#54](https://github.com/nsdeschenes/shop-things/issues/54), behavior
decisions #47–#52, and acceptance decision
[#52](https://github.com/nsdeschenes/shop-things/issues/52#issuecomment-5909254348)
remain authoritative. This document maps runnable evidence; it is not a release
certificate or a substitute for the generated same-commit record.

Linux glibc x64 and unsigned macOS arm64 have automated runners. Each report
identifies the actual target, revision, executed checks, and current outcome.
Automated success does not establish manual GUI, signing, installation, or
other-platform verification.

## Requirement mapping

| Required behavior/proof                                                                    | Automated evidence                                                                                                          |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Clean contract/database/frontend emission and supporting behavior                          | Sequential acceptance source JSON reports, typecheck/build/lint; zero skipped/todo tests                                    |
| Startup/loading/setup, remembered reopen/recovery, Create/Open/Retry, pending/cancel/error | `database.spec.ts` and `foundation.spec.ts`, real IPC and persisted settings/files                                          |
| Customer CRUD/defaults/numeric/text validation/immutable-ID search/reopen                  | `customers`, `create`, `edit`, `deletion` specs, real database reopen and Chromium equivalents                              |
| Saved query/mutation/session/revision coherence and explicit recovery                      | `customers`, `deletion`, `recovery` specs; real delayed responses, stale writes, same-file fresh sessions                   |
| Exact invalid dirty values, Save/transition/lifecycle races, matching-only protocol        | `create`, `edit`, `protection`, protocol and history cases through real renderer/preload; supporting correlated-owner tests |
| Back/Forward/Cancel/link guard, native preview unload and no persistent storage            | `history`, `unload`, preview cases; actual Chromium native beforeunload and empty local/session/IndexedDB                   |
| All saved Backup/CSV, search/draft exclusion, cancel/BUSY/EEXIST                           | `savedFiles.spec.ts`, actual files/independent backup reopen and temporary simulations                                      |
| Separate-file Restore, both picker Cancels, source/prior preservation, failure cleanup     | `restore.spec.ts`, real files, candidate faults and remembered reopen; cloned preview snapshots                             |
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

Record the tester, date, source commit, packaged artifact SHA, and observed
results when performing these checks. Do not infer completion from automation
that controls native picker functions.

| Platform/workflow        | Checklist still requiring actual GUI evidence                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Packaged Linux glibc x64 | Native Create/Open/Backup/Export selection and Cancel; each Restore picker Cancel; Restore source/new-destination explanation; real modal owner/window and Stay safe default; failed candidate leaves usable app/draft; close/quit/guarded reload; pending/error/BUSY/dismiss feedback; active filename/full path and destination results; nested-route reload |
| Development desktop      | Dirty source restart cancelled without process/draft loss; explicit retry; graceful closure before fresh build/replacement; failed prerequisite build prevents launch and fixed source recovers                                                                                                                                                                |
| Chromium on Linux        | Dirty preview reload/close shows exactly the native unload warning; dismiss preserves edits; confirmed reload resets temporary data; browser-controlled unload limitations recorded                                                                                                                                                                            |

Keep manual and release decisions outside automated reports. Use a current run's
logs and reports to diagnose execution failures; historical CI incidents do not
describe a later run's outcome.
