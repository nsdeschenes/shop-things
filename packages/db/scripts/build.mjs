import { rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
await rm(new URL("../dist", import.meta.url), { recursive: true, force: true });
const result = spawnSync("pnpm", ["exec", "tsc", "-p", "tsconfig.json"], { stdio: "inherit" });
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}
