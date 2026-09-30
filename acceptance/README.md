# Renderer Acceptance

Run `pnpm exec playwright install chromium` and install the workspace Electron runtime,
then `pnpm test:renderer`. Linux headless hosts require a display, for example
`xvfb-run -a pnpm test:renderer`. Run builds/tests sequentially: both the backend suite
and renderer suite replace emitted output.

The foundation suite executes the built frontend in Chromium and real Electron
BrowserWindows with the bundled sandboxed preload and actual IPC. The test launcher
isolates user data and can deny handshakes at the transport boundary. It imports the
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
153.0.8010.12; all eight renderer checks passed. This is supporting local evidence.
Linux glibc x64 automated renderer/packaged checks and manual GUI/native-dialog gates
were explicitly deferred by the owner during implementation; they are not certified here.
