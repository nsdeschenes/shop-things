import { rm, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { packageRoot, fingerprint, artifactHashes } from "./freshness.mjs";

const require = createRequire(import.meta.url);
await rm(resolve(packageRoot, "dist"), { recursive: true, force: true });
const source = await fingerprint();
const build = spawnSync(
  process.execPath,
  [resolve(dirname(require.resolve("typescript/package.json")), "bin/tsc"), "-p", "tsconfig.json"],
  { cwd: packageRoot, stdio: "inherit" },
);
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

if (source !== (await fingerprint())) {
  throw new Error("Contract changed during compilation; rebuild before consuming output.");
}

await writeFile(
  resolve(packageRoot, "dist/fingerprint.json"),
  JSON.stringify({ source, artifacts: await artifactHashes() }),
);
