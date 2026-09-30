import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { defineConfig } from "tsdown";
import { runCommand } from "../../scripts/processes.mjs";
const require = createRequire(import.meta.url);

export default defineConfig({
  entry: ["src/*.ts"],
  format: "esm",
  platform: "browser",
  target: "es2024",
  dts: true,
  unbundle: true,
  clean: true,
  hooks: {
    "build:done": () =>
      // tsdown's TypeScript 7 declaration generator emits with --noCheck.
      runCommand(
        process.execPath,
        [resolve(dirname(require.resolve("typescript/package.json")), "bin/tsc"), "--noEmit"],
        { cwd: dirname(require.resolve("./package.json")) },
      ),
  },
});
