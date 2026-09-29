# Shop Things

## Desktop app

Install dependencies with `pnpm install`, then run `pnpm dev` to start the Vite
renderer and Electron together. React changes use Vite's HMR.

Build installers on their target operating systems:

- macOS: `pnpm dist:mac` creates a `.dmg`.
- Windows: `pnpm dist:win` creates an NSIS `.exe` installer.
- Linux: `pnpm dist:linux` creates a Debian `.deb` package.

Installers are written to `release/`. Run each command on its target operating
system.

## Tests

All test suites are written in TypeScript. Run `pnpm test` to type-check tests
and run Vitest in all three packages, or `pnpm test:watch` to
watch all suites. Run a single suite with `pnpm --filter <package-name> test`
or `test:watch` (`@shop-things/db`, `electron`, or `@shop-things/interface`).

Database tests build the package first and exercise real temporary databases,
migrations, and the migration CLI. Rebuild the database package after changing
its source during watch mode.

Interface tests use jsdom, React Testing Library, user-event, and jest-dom
matchers. Electron tests run the main entry point in Node with the Electron API
boundary mocked; packaged application checks remain a separate smoke test.

Run `pnpm lint` to check source and tests, including the companion testing lint
rules, and `pnpm fmt:check` to check formatting.
