# Renderer Acceptance

Run `pnpm exec playwright install chromium` and install the workspace Electron runtime,
then `pnpm test:renderer`. Linux headless hosts require a display, for example
`xvfb-run -a pnpm test:renderer`. Run builds/tests sequentially: both the backend suite
and renderer suite replace emitted output.

The foundation suite executes the built frontend in Chromium and real Electron
BrowserWindows with the bundled sandboxed preload and actual IPC. The test launcher
isolates user data, can deny handshakes and can hold a startup status response at the
transport boundary. The ordering check selects a temporary real database through the
production create action and delivers its notification before releasing the old status. It imports the
built production entry point; it does not provide a replacement frontend client.

The development resource check serves the built renderer at one configured origin.
The bundled HTML check uses actual file loading and hash routes. Neither check claims
execution of an electron-builder packaged artifact. Packaged execution and the complete
workflow matrix belong to the final acceptance stage.

Reports and retained failure traces are written to `acceptance-reports/renderer`.
The foundation checks cover exact preview gating, route/reload parameter preservation,
live precedence, private subscription/participant admission before status, early handshake
recovery, live failure/Retry, nested file hash routing, and blocked navigation/new windows.
Editors and unfinished file actions remain disabled during this stage.

Local foundation run: September 30, 2026, macOS arm64, Electron 44.4.5 and Chromium
153.0.8010.12; all nine renderer checks passed. The controller/QueryClient tests also
cover superseded searches and old-session completion suppression. Actual customer UI
late-completion evidence remains with the customer and final acceptance stages. This is supporting local evidence.
Linux glibc x64 automated renderer/packaged checks and manual GUI/native-dialog gates
were explicitly deferred by the owner during implementation; they are not certified here.

## Shared Draft Protection

`application.protection` owns one renderer participant across route changes.
Forms supply a stable `{values(), baseline(), reset()}` editor via
`useDraftProtection`, call `changed()` after exact editable values change, and disable
editing while `frozen`. Invalid text is compared exactly against the baseline.

Use `await protection.save(work)` to track persistence plus cache/baseline callbacks.
Then verify the captured session and call `navigateAfterSave(navigate)` outside that
tracked work. It refuses navigation while saving, frozen, or newer edits remain.
Preparation never initiates Save. Matching aborted messages release the freeze silently;
matching committed messages reset the captured editor. Keep errors in the caller's
operation feedback. Browser preview uses the renderer Discard/Stay dialog with Stay
focused, and its single native beforeunload warning.

The protection acceptance journey mounts test-only controlled editable values in the
real BrowserWindow and uses the production protection owner, bundled preload and IPC.
It verifies invalid drafts survive Stay on window close/app quit/guarded reload,
clean reversion permits reload, unresponsive Save preparation times out without consent,
and missing participation aborts with retry guidance. Main-owned cold startup can open
remembered data before a renderer exists; all public recovery transitions require an
explicit current participant, including when no database is active.

## Customer Browsing

The customer suite seeds temporary migrated databases through the emitted database
package and remembered settings, then exercises the production renderer and IPC in
both development-resource and bundled-file/hash modes. It covers backend ordering,
debounced search with preserved focus, Enter/Clear, immutable-ID links, query-preserving
Back/header navigation and reload, nullable numbers, decimal-string balances, missing
records and explicit Retry. Customer create/edit/delete remain disabled in this stage.

The launcher can hold a real handler result or supply one controlled error after the
real handler completes. Superseded search errors and detail successes cannot paint a
new target. Reopening the same file rotates its session and clears selection/search
only after matching protection commit; a held prior-session error cannot affect the
new list. Chromium proves temporary empty/search/missing behavior and separation of
outer preview switches from hash-route search parameters.

Local run on September 30, 2026: all 14 renderer/protection/customer checks and 26
interface checks passed on macOS arm64. Linux/packaged artifact and manual acceptance
remain deferred as recorded above; these local runs do not certify release acceptance.

`deletion.spec.ts` drives identifying confirmation/cancellation and deletion through
actual development-resource and bundled hash renderers, then independently reopens
the real database after graceful Electron closure. It also creates a genuine revision
conflict through the named IPC update action and delays an actual deletion completion
across a committed session change. This verifies retained references, no stale retry,
searched-list cache retirement and suppression of obsolete success navigation.
Chromium create/delete preview coverage joins the Create implementation; injected
preview-client component checks alone do not certify the complete browser UI workflow.

### Protected Create (#60)

`create.spec.ts` exercises the actual bundled renderer, sandboxed preload, named IPC,
and persisted database. It creates a customer with unrestricted contact text and a
negative decimal balance, revisits a previously cached search, reloads, and reopens
its database before inspecting saved detail. A held actual Create response proves
repeat Save prevention, permitted newer edits, native close Stay, retained saved
identity for the subsequent Update, and full Save settlement before database replacement.
A pre-dispatch test boundary failure proves supplied inline/form feedback and
retained input when quit preparation waits on the failed Save. Chromium exercises
canonical draft validation, Stay default focus, temporary Create, saved detail/list,
and refresh clearing the document's temporary records. These checks remain local
macOS arm64/Chromium evidence; the authorized Linux acceptance deferral still applies.

### Retained Edit references (#61)

`edit.spec.ts` proves real IPC Update persistence after database reopen, authoritative
duplicate-number feedback, explicit assignment of a previously unnumbered record,
and exact loaded/typed contact and decimal text. A held Update permits newer edits,
blocks repeat Save and route navigation, waits during native close preparation,
and retains the newer draft after Stay. Its next Save uses the returned fresh
reference. An external actual Update then makes the retained editor revision stale;
Save keeps the draft and blocks further writes, including during quit Stay.
Chromium proves equivalent temporary editing and leading-zero numeric search.
Source tests supplement this with query-cache replacement that cannot substitute
the editor's reference, preview read cloning, and number ordering before ID ties.
The explicit guarded reload control belongs to #63. Platform acceptance remains
subject to the existing authorized Linux deferral.

### Cold Vite development bootstrap (#58 follow-up)

`developmentBootstrap.spec.ts` starts the real configured Vite server programmatically
on an ephemeral loopback port with a fresh temporary dependency cache, then launches
actual Electron through Playwright. It checks live named IPC, opens a saved editor,
and retains an invalid exact balance draft after native close Stay. The check keeps
StrictMode and disabled HMR. Disabling Vite's dependency-crawl hold prevents cold
optimized-module requests from leaving the renderer blank; a warm cache is not used
as startup evidence. Test-owned processes/server are cleaned up separately from the
user's application. This case proves development bootstrap and draft protection;
watcher source-change, retry, failed-build, and replacement evidence remains with #67.

`database.spec.ts` covers startup loading before remembered recovery settles, first-launch
Create cancellation/success and remembered reopen, missing-file Retry/Open recovery,
and dirty-editor preservation after cancelled or failed candidates (existing destination,
unsupported file, and remembered-path write failure). Chromium exercises labelled
Create/Open/Retry simulations with correlated draft abort/commit and temporary state.
The launcher queues test-only picker selections in `acceptanceFiles`; it continues to use
the actual protected action service and IPC boundary. Linux and native manual gates remain
deferred as recorded in the parent acceptance plan.

`acceptance/savedFiles.spec.ts` drives Backup and CSV export through the real Electron
renderer, bundled preload, and named IPC. It inspects independent backup/CSV outputs
for every saved customer despite search, quoted multiline comments, decimal strings,
and unassigned customer numbers; the active editor's unsaved values and route remain.
Held pickers exercise the pending layer. Cancel, existing-file rejection, folder
failure, and BUSY leave the draft intact and release pending UI. Chromium separately
checks visibly labelled simulations and empty browser storage. Run this focused suite
with `pnpm build && pnpm exec playwright test --config acceptance/playwright.config.ts
acceptance/savedFiles.spec.ts`. These local checks supplement the deferred Linux and
manual native-dialog acceptance gates.

### Separate-file Restore (#66)

`restore.spec.ts` drives the explanatory Continue/Cancel step through the persistent
Database menu before the native action. Actual BrowserWindow/preload/IPC checks
cover Stay before pickers, each picker cancellation after approval, destination
conflicts with preserved bytes, unsupported backups, failed migration and settings
persistence with candidate cleanup, and BUSY during a held picker. They retain the
original session, reference, exact draft, route and search after failure. Successful
Restore migrates a separate copy of a read-only backup, preserves both source and
previous working file, clears the old view on commit and reopens the remembered
restored destination. Restore also works without an active database.

Chromium exercises visibly labelled Restore simulation, explanatory cancellation,
Stay, simulated cancellation/failure and committed restoration of all saved backup
records despite search and unsaved edits. Restored records receive fresh references;
changing the working copy cannot mutate the saved backup snapshot. No native dialogs,
files or persistent browser storage are used in preview. These local checks remain
supporting evidence; the authorized Linux/manual acceptance deferral still applies.
