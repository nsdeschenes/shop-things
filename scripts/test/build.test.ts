import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { inspectBrowserDependencies, pnpm, root } from "../tasks.mjs";

const prohibitedDependency = /Prohibited contract dependency/;

// Source-mutating checks run serially, after all consumers finish.
test("direct Electron builds compile their contract and database prerequisites", async () => {
  for (const name of ["contract", "db", "electron"]) {
    await rm(join(root, "packages", name, "dist"), { recursive: true, force: true });
  }

  await pnpm(["--filter", "electron", "build:main"], { stdio: "ignore" });
  await expect(readFile(join(root, "packages/contract/dist/client.js"))).resolves.toBeDefined();
  await readFile(join(root, "packages/electron/dist/main.js"));
  await readFile(join(root, "packages/electron/dist/preload.cjs"));
  await readFile(join(root, "packages/db/dist/index.d.ts"));
});

test("failed real preload emission leaves no launchable build", async () => {
  const preload = join(root, "packages/electron/src/preload.ts");
  const original = await readFile(preload);
  try {
    await writeFile(preload, Buffer.concat([original, Buffer.from('\nimport "node:fs";\n')]));
    await assert.rejects(pnpm(["--filter", "electron", "build:main"], { stdio: "ignore" }));
    for (const output of ["preload.cjs", "preload.meta.json"]) {
      await assert.rejects(readFile(join(root, "packages/electron/dist", output)), {
        code: "ENOENT",
      });
    }
  } finally {
    await writeFile(preload, original);
    await pnpm(["--filter", "electron", "build:main"], { stdio: "ignore" });
  }

  await readFile(join(root, "packages/electron/dist/preload.cjs"));
});

test("dependency inspection rejects backend imports in the browser contract", async () => {
  const manifestPath = join(root, "packages/contract/package.json");
  const manifestBytes = await readFile(manifestPath);
  try {
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    manifest.dependencies["@shop-things/db"] = "workspace:*";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(inspectBrowserDependencies(), prohibitedDependency);
  } finally {
    await writeFile(manifestPath, manifestBytes);
  }

  await inspectBrowserDependencies();
});
