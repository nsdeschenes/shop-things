# Effect ownership in Shop Things

Shop Things uses Effect 4.0.6 for database workflows, backend admission and lifecycle operations, renderer coordination, and monitoring settings persistence. Customer records, saved database files, IPC messages, and React screens retain their existing formats.

## Where operations run

The backend owns the active database, session, import reviews, and lifecycle admission together. Ordinary actions fail immediately with `BUSY` if another operation has admission. Close and reload reserve lifecycle admission before waiting for active work. Draft preparation remains correlated to one request and editor document.

The renderer has a different concurrency policy. Its Effect semaphore queues requests. Generation, session, cancellation, and relevance checks prevent an obsolete response from replacing current data. A request already sent to the backend can still commit. Disposing the renderer invalidates its result without claiming that the write was cancelled.

React owns component state. TanStack Query owns saved customer cache entries. TanStack Router owns route loading and navigation. Zod remains the canonical schema registry for the wire contract and editable form validation. Effect composes these operations without duplicating their schemas or state.

## Database and error boundaries

`@shop-things/db/effect` exposes composable database operations. The package root retains Promise APIs for driver tooling and existing external consumers. Both use one implementation. Runtime execution stays in the compatibility adapter or a framework entry point.

Native database and filesystem promises cannot stop merely because an Effect fiber is interrupted. They drain before cleanup releases a handle, rolls back a transaction, or releases admission. Import planning and inserts stay inside `BEGIN IMMEDIATE`. The backend protects the successful commit through consumption of the import review.

Native failures retain the immediate original error. Promise adapters unwrap native error wrappers. IPC returns the existing safe result envelopes. User cancellation remains a value and is distinct from fiber interruption. Cleanup keeps the prior error precedence. Superseded database close failures are diagnostic; failed candidate cleanup or transaction rollback can replace the initiating failure.

Monitoring uses the existing Sentry initialization and privacy projection. The matching official `@sentry/effect` tracer keeps Effect phase spans active during asynchronous native calls. Monitoring settings save through an independent semaphore and atomic temporary-file replacement. Saved monitoring configuration activates on restart.

## Source references

`repos/effect/` is a pinned, read-only git subtree. Application code imports installed packages. Lint rejects imports from the reference tree. Workspace builds, formatting, lint discovery, build fixtures, and type checking exclude it. GitHub marks its diff as vendored and generated so application changes remain easier to review.

See [reference revisions and update commands](agents/effect.md).

## Verify behavior

Run `pnpm test`, `pnpm typecheck`, `pnpm lint`, and `pnpm build`. The database and application tests include native-call interruption, rollback failure, draft revocation, admission, and obsolete-response cases.

Run `pnpm test:renderer` under the desktop prerequisites in [renderer acceptance](../acceptance/README.md). It exercises the built Electron renderer, sandboxed preload, IPC, and real temporary databases. Source tests alone do not establish packaged application behavior. The complete acceptance runner also checks packaging and development watcher replacement from a clean committed checkout.
