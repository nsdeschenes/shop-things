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
