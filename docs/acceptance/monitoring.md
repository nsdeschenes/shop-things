# Application monitoring

Settings is available from the header before database setup and during recovery. Enter a Sentry DSN in Monitoring and save. A blank DSN disables monitoring. Enabling, disabling, or changing the destination takes effect after quitting and restarting Shop Things. Reloading the window retains the active destination.

Main owns `telemetry.json` in Electron's user-data directory. Its only field is `dsn`. Writes replace the file atomically with owner-only permissions. `database.json` remains independent. Missing or malformed monitoring settings disable monitoring while the application remains usable. Settings shows the saved value and whether a restart is required. The startup DSN stays immutable for the process lifetime. Authorized `telemetry.status` also returns that active DSN to initialize the renderer. It never travels in command-line arguments.

The native adapter uses `@sentry/node` 11.4.0. The renderer uses `@sentry/react` 11.4.0 with direct browser ingestion. The sandboxed preload contains only the application bridge. The renderer restricts `connect-src` to the active DSN origin. Self-hosted ingestion must accept CORS requests from the packaged `file://` renderer. HTTP and HTTPS DSNs are supported. Saving validates the DSN format without contacting its destination.

## Signals

Each authorized action produces a named main span. Database operations and import, export, restore, startup, reload, and protected shutdown produce phase spans. Renderer client calls produce elapsed action spans. Router spans measure navigation through resolution and use route templates. Main and renderer traces are independent. There is no IPC trace-parent propagation.

`application.action.count` counts completion outcomes. `application.action.duration` records milliseconds. Both include static action, outcome, process, and an optional contract error code. `Application action completed` logs the same bounded attributes. Known cancellation, validation, busy, stale, and unavailable outcomes produce these signals without exception events.

Main captures original unexpected exceptions through the existing service and IPC error handlers, plus uncaught failures and abnormal renderer load or lifecycle failures. Renderer captures React root, unexpected router, global error, unhandled rejection, and client-caught transport faults. Native safe error responses do not create duplicate renderer exceptions. Reporting failures cannot change client results. Protected close waits for a bounded main flush. Renderer pagehide requests a bounded flush without blocking the interface.

## Privacy

Collection defaults and integrations are explicitly restricted. Emission hooks retain fixed operation names, outcomes, error codes, process, timing, exception types, and sanitized application-relative stack locations. Validated trace and span IDs link errors within their owning process. Exception messages are replaced. Customer records, identifiers, search values, action arguments or results, query keys, DSNs, selected paths, SQL, and source context are excluded.

Native dumps, screenshots, replay, console and DOM breadcrumbs, automatic network and database instrumentation, local variables, user information, cookies, headers, request bodies, and query strings are disabled. Preview never initializes either SDK and never persists monitoring configuration. No source-map upload or external credentials are required.

Inherited Sentry environment trace and baggage are ignored. Span streaming is explicit, and Spotlight is disabled, so environment overrides cannot bypass span sanitization or add an ingestion destination. Log parent span IDs are retained only when they are valid 16-character hexadecimal identifiers.

## Verification

Run the package tests, typecheck, production build, lint, and formatting checks. Then run the production Electron collector test:

```sh
pnpm build
node acceptance/buildHarness.mjs
pnpm exec playwright test --config acceptance/playwright.config.ts telemetry.spec.ts
```

The collector listens on localhost and inspects real event, streamed-span, log, and metric envelopes from both processes. It verifies cold-restart activation, disabled delivery, private payloads, and Settings during held database startup. Linux containers may need Xvfb and runtime libraries. Set `SHOP_THINGS_ACCEPTANCE_NO_SANDBOX=true` only in a test container whose Electron sandbox helper cannot be used. The production BrowserWindow still sets `sandbox: true`.
