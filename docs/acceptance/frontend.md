# Frontend integration acceptance

Specification: [#54](https://github.com/nsdeschenes/shop-things/issues/54).
Behavior and required evidence: decisions #47–#52, especially
[#52](https://github.com/nsdeschenes/shop-things/issues/52#issuecomment-5909254348).

## Completion status

Implementation and acceptance are in progress. No renderer or GUI acceptance
has been certified by this record.

## Required evidence

- Clean contract/database emission, build, source/backend/component checks.
- Development BrowserWindow/preload/IPC authorization, handshake, subscriptions,
  document replacement, guarded reload and cooperative restart.
- Linux glibc x64 live and packaged renderer customer/database workflows,
  deterministic failure and race coverage, real database/file assertions.
- Chromium on Linux explicit preview gating, temporary CRUD, simulated file
  operations, route guards, reload reset and parameter preservation.
- Packaged Linux GUI native selection/cancellation (both restore pickers),
  Discard/Stay safe default and modal ownership, close/quit/reload, pending/error
  feedback, active filename/path/results and nested-route reload.
- Development GUI dirty restart cancellation and failed prerequisite builds.
- Chromium GUI native unload warning and confirmed temporary-data reset.

The final record must identify the source commit, packaged artifact and hash,
OS/distribution/architecture, Electron and Chromium versions, commands/results,
logs, GUI tester/date/checklist, failures and explicit deferrals. Missing, failed
or skipped required checks keep acceptance incomplete.

macOS arm64, Windows x64 and Linux arm64 verification remain explicitly deferred.
Their existing build targets remain available.
