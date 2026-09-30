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
Rejected or timed-out shutdown leaves the app open and resumes watching; it never
forcibly kills Electron. Renderer HMR is disabled. Type `r` and press Enter in the
development terminal to retry a rejected restart or failed build without a source edit.
New or failed emission prevents a replacement launch. Test watch commands run serialized
checks after source changes, including contract mutation checks.

The sandboxed preload is attached and exact-resource renderer authorization is active.
The renderer owns one subscription and a document-scoped draft participant. Native close,
quit, and reload wait for Save and require correlated draft approval; guarded reload keeps
the database session open. Editors remain unavailable until the CRUD integration stage.
Watcher draft preservation belongs to the next stage. See `acceptance/README.md` for
actual renderer checks, controlled editable coverage, and platform deferrals.

Run `node --experimental-strip-types scripts/acceptance.ts` from a clean committed checkout on Linux glibc x64
to install, run all required checks without skipped cases, build/package, and execute
the shipped backend under the packaged Electron executable in Node mode.
`ACCEPTANCE_REPORT_DIR` selects the report/log directory (default `acceptance-reports`).
Reports retain commit identity, execution environment, package SHA-256 hashes,
shipped-code comparisons against the current build inventory, migration/preload
inspection and real persisted-file workflow results. Failed prerequisites also
produce reports and logs; CI uploads the directory even on failure.

For Docker emulation, set `SMOKE_EXECUTION_ENVIRONMENT` to describe the host and
emulated target explicitly. Local Docker proof does not establish a successful
GitHub Actions run. Other platform targets and GUI/renderer acceptance remain deferred.
