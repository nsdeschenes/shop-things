import { defineConfig } from "tsdown";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { runCommand } from "../../scripts/processes.mjs";

const require = createRequire(import.meta.url);

export default defineConfig({
  entry: ["src/*.ts"],
  format: "esm",
  platform: "node",
  target: "es2024",
  fixedExtension: false,
  dts: true,
  unbundle: true,
  clean: true,
  hooks: {
    // tsdown's TypeScript 7 declaration generator emits with --noCheck.
    "build:done": () =>
      runCommand(
        process.execPath,
        [resolve(dirname(require.resolve("typescript/package.json")), "bin/tsc"), "--noEmit"],
        { cwd: dirname(require.resolve("./package.json")) },
      ),
  },
});
