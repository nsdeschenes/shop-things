# Dependency declaration checking

Audit for [#143](https://github.com/nsdeschenes/shop-things/issues/143), using the
lockfile at `4260b2589eb9982d5708b29f4fe5d0734202ed5f`.

Declaration checking is enabled by default, including contract builds/tests,
both consumer conformance checks, and automation scripts. Contract builds use
DOM types for Zod's `URL`; scripts need them for Electron and Playwright APIs.
Consumer conformance configs explicitly set `skipLibCheck: false`.

## Remaining exceptions

TypeScript cannot exempt individual dependency declarations. Each exception
below stays local to affected configs; compiler strictness is unchanged.

- **Database** (`packages/db/tsconfig{,.test,.typecheck}.json`): Drizzle
  `1.0.0-rc.4` has missing `config` properties (TS2339), invalid variance in
  `column-builder.d.ts` (TS2636), and SQLite select constraints (TS2344).
  Stable `0.45.4` lacks the application's `defineRelations` API. Recheck on
  a compatible Drizzle release.
- **Electron** (`packages/electron/tsconfig{,.test}.json`, plus the inherited
  typecheck config): the same Drizzle errors; tests also reach Electron
  `44.4.5` declarations requiring `VideoFrame` and `HTMLElement` (TS2304).
  Recheck after Drizzle fixes, then evaluate DOM types for automation tests
  while keeping main-process source checking Node-only.
- **Renderer** (`packages/interface/tsconfig.app.json`): jest-dom `7.0.1`
  augments `Assertion` with one type parameter; Vitest `5.0.2` expects two
  (TS2428). Patch `5.0.3` has the same declaration. Recheck when jest-dom
  supports Vitest 5; retain the current runner and matcher types.
- **Build config** (`packages/interface/tsconfig.node.json`): StyleX
  `0.19.1` / unplugin `2.3.11` lack Babel types (TS7016) and optional bundler
  declarations (TS2307); router-core `1.171.33` requires DOM types (TS2304).
  Babel types alone cannot fix all errors, and unplugin 3 is outside StyleX's
  peer range. Recheck compatible plugin releases rather than installing
  unused bundlers.

## Recheck

Use Node 26+, run `pnpm install --frozen-lockfile` and `pnpm prepare:backend`,
then run each affected config with its package-local compiler:

```sh
pnpm --filter <package> exec tsc --noEmit -p <config> --skipLibCheck false
```

Validate with `pnpm lint`, `pnpm typecheck`, and `pnpm test`. The root tsconfig
is a shared base; checking it directly mixes incompatible project environments.
