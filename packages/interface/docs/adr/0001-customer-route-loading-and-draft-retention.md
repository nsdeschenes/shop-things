# Customer route loading and draft retention

TanStack Query owns saved customer data, session-scoped caching, and mutation updates; Router loaders await initial customer reads and components retain Query subscriptions. Entering a customer route without an available database redirects to `/`, which redirects to `/customers` once ready. An outage during editing retains the editor and its draft.

Approving discard does not release the draft until destination loading succeeds. Destination reads may proceed within that approved navigation while draft changes and mutations remain frozen; if destination loading fails, navigation stays in the editor and retains the draft. Skipping destination reads would avoid the existing frozen-request conflict but would prevent the pre-navigation check from detecting data-loading failures.

The customer list alone validates `q` with Zod, and leaving the list clears the search. Route error components distinguish malformed or missing customer IDs from database failures.

Customer search uses TanStack Pacer's debounce hooks with the existing 250 ms delay. Search controls remain mounted and usable while updated results load; initial route entry may display a route pending component. Customer links use TanStack Router intent preloading, with TanStack Query determining data freshness. Speculative preloads do not receive the read admission reserved for an approved draft-discard navigation.
