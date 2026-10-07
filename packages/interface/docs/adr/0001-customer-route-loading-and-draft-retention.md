# Customer route loading and draft retention

TanStack Query owns saved customer data, session-scoped caching, and mutation updates; Router loaders await initial customer reads and components retain Query subscriptions. Entering a customer route without an available database redirects to `/`, which redirects to `/customers` once ready. An outage during editing retains the editor and its draft.

Approving discard does not release the draft until destination loading succeeds. Destination reads may proceed within that approved navigation while draft changes and mutations remain frozen; if destination loading fails, navigation stays in the editor and retains the draft. Skipping destination reads would avoid the existing frozen-request conflict but would prevent the pre-navigation check from detecting data-loading failures.

Customer query keys contain the session and the requested data identity: search text for lists, customer ID for details, and import ID for reviews. Request scopes (`scope` and `readScope`) govern request lifetime and navigation admission, not the identity of cached data. Adding a scope to a key would split the same saved data or import review across navigation and component reads, separating them from cache updates made by mutations. Request scopes are passed through typed TanStack Query metadata and read from the query-function context, keeping request admission separate from cache identity without suppressing dependency checks.

The customer list alone validates `q` with Zod, and leaving the list clears the search. Route error components distinguish malformed or missing customer IDs from database failures.

Customer search uses TanStack Pacer's debounce hooks with the existing 250 ms delay. Search controls remain mounted and usable while updated results load; initial route entry may display a route pending component. Customer links use TanStack Router intent preloading, with TanStack Query determining data freshness. Speculative preloads do not receive the read admission reserved for an approved draft-discard navigation.

Explicit header refresh invalidates all customer queries for the current database, refetches active queries, and adopts fresh saved values and revisions in clean customer forms. It is disabled while edits are unsaved. Refresh retains the current route and search, uses the global loading overlay, and preserves displayed data on failure with retry feedback and an error toast. Background query refresh continues to retain the editor's values and original revision.
