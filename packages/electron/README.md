# Electron Backend

Run `pnpm build` from the workspace root to build contract and database prerequisites,
compile Electron, bundle the sandbox-compatible preload, and build the placeholder renderer.
Emitted output stays untracked. Each successful build records source and artifact hashes;
missing, changed, partial, or failed output cannot pass the launch gate.

`pnpm test` runs contract mutation checks before consumer tests, then real database,
IPC/client, native-dialog boundary, connected development-output, build, and process checks.
Direct Electron/interface build and test commands also prepare their prerequisites.
`pnpm --filter electron test:smoke` prepares fresh output and checks the existing package;
Linux glibc x64 packaged backend acceptance requires the corresponding package artifact.

`pnpm dev` first builds all prerequisites and preload, then starts Vite and Electron.
Changes trigger serialized rebuilds. The supervisor asks Electron to quit through its
private parent-process channel and waits for startup/current database work to finish.
Rejected or timed-out shutdown leaves the app open; it never forcibly kills Electron.
New or failed emission prevents a replacement launch. Test watch commands run serialized
checks after source changes, including contract mutation checks.

The preload stays unattached and renderer authorization/protected hooks stay inactive.
Actual renderer refresh, draft preservation during watcher restarts, native-dialog GUI,
and navigation/security journeys remain deferred to renderer integration. Build/process
checks exercise emitted code and controlled participants rather than a connected GUI.
