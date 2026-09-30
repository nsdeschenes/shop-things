# Shop Things

## Desktop app

Use Node.js 22.18+ (or 24.11+). Install dependencies with `pnpm install`, then run
`pnpm dev` to start the Vite renderer and Electron together. React changes use
Vite's HMR.

Build installers on their target operating systems:

- macOS: `pnpm dist:mac` creates a `.dmg`.
- Windows: `pnpm dist:win` creates an NSIS `.exe` installer.
- Linux: `pnpm dist:linux` creates a Debian `.deb` package.

Installers are written to `release/`. Run each command on its target operating
system.

## Tests

Run `pnpm typecheck` from the workspace root to check all packages and the root
test tooling without running tests or building the desktop app. Checks include
source, tests, TypeScript configuration files, and contract conformance in both
Electron and the interface. All check results are collected before the command
fails. Workspace imports resolve directly to source, so no generated declarations
or prior build are required.

Run `pnpm typecheck` inside any package, or select one from the root:

```sh
pnpm --filter @shop-things/contract typecheck
pnpm --filter @shop-things/db typecheck
pnpm --filter electron typecheck
pnpm --filter @shop-things/interface typecheck
```

All test suites are written in TypeScript. Run `pnpm test` to type-check tests
and run Vitest in all three packages, or `pnpm test:watch` to
watch all suites. Run a single suite with `pnpm --filter <package-name> test`
or `test:watch` (`@shop-things/db`, `electron`, or `@shop-things/interface`).

Database tests build the package first and exercise real temporary databases,
migrations, and the migration CLI. Rebuild the database package after changing
its source during watch mode, or run `pnpm --filter @shop-things/db dev` alongside
the test watcher to rebuild automatically.

The contract and database packages build JavaScript and declarations with tsdown.
Run `pnpm --filter @shop-things/contract dev` or `pnpm --filter @shop-things/db dev`
to watch a package, or `pnpm dev:packages` to watch both. Their `build` commands
perform a clean, one-time build. The root `pnpm dev` command continues to rebuild
these packages before restarting Electron.

Interface tests use jsdom, React Testing Library, user-event, and jest-dom
matchers. Electron tests run the main entry point in Node with the Electron API
boundary mocked. After building an installer on its target OS, run
`pnpm --filter electron test:smoke` to check the packaged app with Vitest.
The smoke suite launches the built Electron executable to verify its bundled
database code, native addon, and migrations. CI runs this command after packaging
and saves the smoke report.

Run `pnpm lint` to check source and tests, including the companion testing lint
rules, and `pnpm fmt:check` to check formatting.
