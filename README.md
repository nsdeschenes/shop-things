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
