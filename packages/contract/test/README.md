# Contract negative tests

These tests use `@ts-expect-error` to check invalid code and malformed runtime
inputs, as reviewed in [#141](https://github.com/nsdeschenes/shop-things/issues/141).

## Compile-time conformance

`conformance.ts` checks that invalid client calls and handler definitions fail to
compile under both Electron and interface configurations. Each directive names
the guarantee it protects; TypeScript fails the check if the expected error
disappears. Keeping assertions at the call sites also tests result narrowing and
excess-property rejection, which generic assignability helpers would miss.

## Runtime validation

`runtime.test.ts` uses three directives to inject a malformed response, an
incomplete draft request, and an invalid draft resolution through the client.
They keep these invalid inputs explicit without casts or changes to public types.
The generated-identity case uses a structurally assignable fixture and needs no
suppression.

Run `pnpm --filter @shop-things/contract test` for runtime and conformance checks.
