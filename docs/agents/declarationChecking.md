# Dependency declaration checking

Audit for [#143](https://github.com/nsdeschenes/shop-things/issues/143), using the
locked dependencies at `4260b2589eb9982d5708b29f4fe5d0734202ed5f`.

The shared `tsconfig.json` no longer sets `skipLibCheck`. Contract builds, contract
tests, both consumer conformance checks, and automation scripts check dependency
and generated declarations. Contract builds use the DOM library because their
browser-facing Zod declarations reference `URL`; scripts use it because Electron
and Playwright expose browser objects in their automation APIs. These are type
libraries only and introduce no runtime browser or Node dependencies.

## Remaining exceptions

TypeScript cannot skip individual dependency declaration files. The exceptions
below apply only to configurations that reach the failing dependencies; source
checking, strictness settings, and negative conformance tests are unchanged.
Consumer conformance configs explicitly set `skipLibCheck: false` so they do not
inherit the application exceptions.

- **Database**: `packages/db/tsconfig.json`, `tsconfig.test.json`, and
  `tsconfig.typecheck.json` retain the exception for `drizzle-orm@1.0.0-rc.4`.
  Disabling it produces TS2339 in `cockroach-core/columns/common.d.ts` (`config`
  is missing), TS2636 in `column-builder.d.ts` (variance), and TS2344 in
  `sqlite-core/query-builders/select.d.ts` (excluded method constraints), among
  other Drizzle errors. These are declaration inconsistencies, not missing
  application types. The installed version is the registry's `rc` release;
  stable `0.45.4` is not a compatible replacement for the application's
  `defineRelations` API. Do not migrate the database API or use an unpublished
  fix solely to remove this exception. Recheck on a compatible Drizzle release.
- **Electron**: `packages/electron/tsconfig.json` reaches those same Drizzle
  declarations through the database package. `tsconfig.test.json` (and its
  `tsconfig.typecheck.json` child) also reaches `electron@44.4.5` declarations
  referencing `VideoFrame`, `HTMLElement`, and DOM event types (TS2304) in a
  Node-only configuration. Keep the main-process source environment Node-only.
  Recheck both configurations when Drizzle declarations are fixed; evaluate
  browser types separately for the automation tests at that point.
- **Renderer application and tests**: `packages/interface/tsconfig.app.json`
  reaches `@testing-library/jest-dom@7.0.1/types/vitest.d.ts`, whose
  `Assertion<T = any>` augmentation conflicts with Vitest 5's
  `Assertion<R extends void | Promise<void> = void, T = unknown>` (TS2428).
  The installed Vitest is `5.0.2`; inspecting the compatible patch `5.0.3`
  shows the same two-parameter declaration. Jest-dom `7.0.1` is the latest
  published version checked in this audit. Keep this exception until jest-dom
  supports the Vitest 5 declaration, rather than downgrading the test runner or
  weakening matcher types. The contract-only child overrides the exception.
- **Renderer build configuration**: `packages/interface/tsconfig.node.json`
  reaches `@stylexjs/unplugin@0.19.1` and its required `unplugin@2.3.11` peer.
  TS7016 reports missing Babel core/traverse types; TS2307 reports optional
  Farm, Rspack, Rollup, unloader, and Webpack declarations, including
  `webpack-virtual-modules`. TanStack router-core `1.171.33` also references
  DOM types such as `ScrollIntoViewOptions` (TS2304). StyleX `0.19.1` is the
  latest checked release, and unplugin 3 is outside its `^2.3.11` peer range.
  Adding types alone does not resolve the optional bundler imports; installing
  unused bundlers or changing the build-plugin major version is not justified.
  Recheck when compatible StyleX/unplugin declarations change.

## Reproducing the audit

Use Node 26 or later, as required by the acceptance-command fixtures. Install
the lockfile and generate workspace declarations first:

```sh
pnpm install --frozen-lockfile
pnpm prepare:backend
```

For each configuration, run its package-local TypeScript compiler with an
explicit override. For example:

```sh
pnpm --filter electron exec tsc --noEmit -p tsconfig.json --skipLibCheck false
pnpm --filter @shop-things/interface exec tsc --noEmit -p tsconfig.app.json --skipLibCheck false
pnpm --filter @shop-things/interface exec tsc --noEmit -p tsconfig.node.json --skipLibCheck false
pnpm --filter @shop-things/db exec tsc --noEmit -p tsconfig.typecheck.json --skipLibCheck false
```

The original root configuration was also checked directly with
`pnpm exec tsc --noEmit -p tsconfig.json --skipLibCheck false`. It is a shared
base, not an aggregate project: its default include spans renderer JSX and
acceptance files using incompatible Node module settings, so that invocation
also reports unrelated source diagnostics. Use `pnpm typecheck` to check the
actual project boundaries, and `pnpm test` to check generated declarations,
negative conformance cases, and the full unit suite.
