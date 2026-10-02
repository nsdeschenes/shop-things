# Shop Things

## Desktop app

Use Node.js 22.18+ (or 24.11+). Install dependencies with `pnpm install`, then run
`pnpm dev` to start the Vite renderer and Electron together. Source changes request
a guarded app restart; Vite HMR is disabled to preserve drafts before approval.
If you keep editing or a build fails, type `r` and press Enter to retry. Cancelling
shutdown keeps development watching active.

Build installers on their target operating systems:

- macOS: `pnpm dist:mac` creates a `.dmg`.
- Windows: `pnpm dist:win` creates an NSIS `.exe` installer.
- Linux: `pnpm dist:linux` creates a Debian `.deb` package.

Installers are written to `release/`. Run each command on its target operating
system.

## GitHub releases

Releases publish the Linux x64 `.deb` installer and `SHA256SUMS` to GitHub through
[Craft](https://craft.sentry.dev/). The root and every workspace package share the
product version; workspace packages are not published to a registry.

1. Run **Prepare release** in GitHub Actions on `main`. The version input defaults
   to `auto`; you can override it with `major`, `minor`, `patch`, or an explicit
   stable version such as `0.2.0` (without `v`). Craft creates a release branch,
   synchronizes versions, generates `CHANGELOG.md`, and the workflow opens a PR
   and explicitly starts Desktop application and Script tooling checks.
2. Review and squash-merge the release PR after both workflows pass. Wait for
   **Desktop application** and **Script tooling** on the resulting `main` commit. The desktop
   run uploads the tested installer and checksums as an artifact named with the
   full commit SHA.
3. Run **Publish release** on `main` with the prepared version and that full
   merge commit SHA. It checks the merged release PR, synchronized versions,
   and successful acceptance before Craft creates the stable `v<version>`
   GitHub release with the generated notes and existing artifacts.

Auto-versioning uses conventional commits since the latest release tag. With no
tags, Craft starts from `0.0.0` and considers the full history. Features bump minor,
fixes bump patch, and breaking changes bump major, including before `1.0.0`.
Prereleases are excluded from this workflow.

Publishing does not rebuild the installer or merge branches. If acceptance fails,
fix the release PR or prepare a corrected release rather than publishing a failed
build. For a transient publish failure, rerun Publish with the same version and
SHA; Craft handles incomplete draft releases. If the CI artifact has expired,
rerun the original acceptance run for that exact main commit before publishing.

Both workflows use the repository's `GITHUB_TOKEN`. Enable **Allow GitHub Actions
to create and approve pull requests** in the repository Actions settings so
Prepare can open the release PR. No custom token or release-validation issue is
required. A successful automated run establishes CI acceptance; device installation
checks remain a separate manual activity.

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

Run `pnpm test:scripts` to type-check and test the root script tooling on its own.
The **Script tooling** workflow runs these tests when scripts or their build-test
dependencies change. Desktop acceptance runs package tests with `pnpm test --packages-only`;
the default `pnpm test` still includes package and script tests locally.

Run `pnpm lint` to check source and tests, including the companion testing lint
rules, and `pnpm fmt:check` to check formatting.
The **Desktop application** workflow runs formatting, typecheck and lint as separate
steps before the sequential test, build and packaged application acceptance run.
It runs for Electron, its shipped interface/database/contract packages, acceptance
code, or shared build configuration changes. Root script-test-only changes and
root documentation changes skip the desktop workflow.
