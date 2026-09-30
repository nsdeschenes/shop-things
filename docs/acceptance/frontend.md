# Frontend integration acceptance

Specification: [#54](https://github.com/nsdeschenes/shop-things/issues/54).
Behavior and required evidence: decisions #47–#52, especially
[#52](https://github.com/nsdeschenes/shop-things/issues/52#issuecomment-5909254348).

## Completion status

Implementation and local validation are in progress. On September 30, 2026,
the owner explicitly deferred Linux automated acceptance and the required
native-dialog GUI checklist for this session ("Not yet, we can ignore this for
now"). These checks remain required for Linux release acceptance; they do not
block this implementation PR. No Linux renderer or GUI acceptance is certified.

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

## Supporting prerequisite checks

Before integration, baseline `fced36767131f8a1d65c8bcc8395499ac342c99c`
passed `pnpm test` (68 tests across contract, database, Electron, interface and
scripts) and `pnpm build` on macOS arm64 using Node 26.5.0 and pnpm 12.4.2.
These establish the starting backend/build prerequisites, not renderer acceptance.

## Customer recovery supporting checks

Ticket #63 adds `acceptance/recovery.spec.ts` using the built BrowserWindow,
preload and IPC with real temporary databases. It covers concurrent external
updates/deletes, Stay and failed reload retention, frozen delayed reads,
successful fresh-reference adoption, copyable deleted drafts, stale Delete,
unavailable database state and cancelled/failed/successful protected Retry.
The unavailable case closes the production service handle through the test-only
launcher; injected faults and holds retain the actual transport. Chromium also
checks temporary saved-customer reload with Stay/Discard.

These local macOS checks supplement the deferred Linux/native GUI acceptance.
