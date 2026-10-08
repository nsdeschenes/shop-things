# Contract negative tests

Reviewed for [#141](https://github.com/nsdeschenes/shop-things/issues/141).
`@ts-expect-error` is allowed only in `conformance.ts` and `runtime.test.ts`
within this package, with a description of at least ten characters. Other
TypeScript suppression directives retain the lint rule's default restrictions.
The exception does not apply to production code or other test files.

## Compile-time conformance

The eleven directives in `conformance.ts` are assertions that the public API
rejects invalid code. TypeScript reports an unused directive if the expected
error disappears. The same file is compiled under both Electron and interface
consumer configurations by `pnpm --filter @shop-things/contract test:conformance`.

Each directive protects a separate guarantee:

- A result must be narrowed to success before reading its value.
- Listing customers requires a session.
- Money is a string transport value, never a number.
- Updating a customer requires a revision.
- Updates cannot edit generated identity.
- Creation cannot supply a generated customer number.
- Creation cannot supply generated identity.
- Opening a database cannot accept arbitrary filesystem paths.
- Customer identifiers must be numeric.
- Handler results must match their action's schema.
- Handler maps must include every action.

Keep these call-site assertions: a generic assignability helper would not check
excess-property rejection on object literals or result narrowing at the actual
client call sites. A separate type-test runner would add another tool and must
still preserve both consumer compiler configurations. Neither is needed to
justify these narrowly scoped, compiler-checked negative tests.

## Runtime validation

Three directives in `runtime.test.ts` deliberately bypass the typed boundary:

- A malformed customer response must become an `INTERNAL` error.
- An incomplete draft request must reject before invoking draft preparation.
- An invalid draft resolution must not reach the registered callback.

These values cannot satisfy the public types. Keeping the directive at each
invalid expression exposes the precise violation and ensures the compiler
continues to reject it, without casts, untyped invocation helpers, or broader
production types. The runtime assertions verify the client's validation path,
not just the schemas in isolation.

The generated-identity runtime case needs no directive: a variable containing
an extra `id` property is structurally assignable to creation values. The test
passes that variable through the client and checks that runtime validation
rejects it without calling transport. The corresponding literal conformance
test still checks compile-time excess-property rejection.

Run `pnpm --filter @shop-things/contract test` for runtime and conformance checks,
`pnpm --filter @shop-things/contract typecheck` for the package type check, and
`pnpm lint` to enforce the exception boundaries.
