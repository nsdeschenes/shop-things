/* oxlint-disable vitest-js/no-import-node-test -- Build gates execute the real prerequisite and consumer entrypoints. */
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildAll,
  checkElectronOutput,
  inspectBrowserDependencies,
  pnpm,
  root,
} from "../tasks.mjs";

const prohibitedDependency = /Prohibited contract dependency/;

// Source-mutating checks run serially, after contract mutation tests and all consumers finish.
test("clean direct builds regenerate prerequisites and remove obsolete emitted output", async () => {
  for (const name of ["contract", "db", "electron"]) {
    await rm(join(root, "packages", name, "dist"), { recursive: true, force: true });
  }

  await pnpm(["--filter", "electron", "build:main"], { stdio: "ignore" });
  for (const name of ["contract", "db", "electron"]) {
    await writeFile(join(root, "packages", name, "dist/obsolete.js"), "obsolete");
  }

  await pnpm(["build"], { stdio: "ignore" });
  for (const name of ["contract", "db", "electron"]) {
    await assert.rejects(readFile(join(root, "packages", name, "dist/obsolete.js")), {
      code: "ENOENT",
    });
  }

  await readFile(join(root, "packages/electron/dist/renderer/index.html"));
  await readFile(join(root, "packages/electron/dist/preload.cjs"));
  await readFile(join(root, "packages/db/dist/index.d.ts"));
  await checkElectronOutput();
});

test("failed real preload emission leaves no launchable build", async () => {
  const preload = join(root, "packages/electron/src/preload.ts");
  const original = await readFile(preload);
  try {
    await writeFile(preload, Buffer.concat([original, Buffer.from('\nimport "node:fs";\n')]));
    await assert.rejects(pnpm(["--filter", "electron", "build:main"], { stdio: "ignore" }));
    await assert.rejects(checkElectronOutput());
    for (const output of ["build.json", "preload.cjs", "preload.meta.json"]) {
      await assert.rejects(readFile(join(root, "packages/electron/dist", output)), {
        code: "ENOENT",
      });
    }
  } finally {
    await writeFile(preload, original);
    await buildAll();
  }

  await checkElectronOutput();
});

test("failed real prerequisite emission cannot authorize dependent output and dependency inspection rejects backend imports", async () => {
  const schema = join(root, "packages/contract/src/schemas.ts");
  const original = await readFile(schema);
  const buildMarker = await readFile(join(root, "packages/electron/dist/build.json"));
  try {
    await writeFile(
      schema,
      Buffer.concat([original, Buffer.from("\nconst brokenEmission: never = 1;\n")]),
    );
    await assert.rejects(pnpm(["--filter", "electron", "build:main"], { stdio: "ignore" }));
    await assert.rejects(checkElectronOutput());
    await assert.rejects(readFile(join(root, "packages/contract/dist/fingerprint.json")), {
      code: "ENOENT",
    });
    assert.deepEqual(await readFile(join(root, "packages/electron/dist/build.json")), buildMarker);
  } finally {
    await writeFile(schema, original);
    await buildAll();
  }

  const manifestPath = join(root, "packages/contract/package.json");
  const manifestBytes = await readFile(manifestPath);
  try {
    const manifest = JSON.parse(manifestBytes);
    manifest.dependencies["@shop-things/db"] = "workspace:*";
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(inspectBrowserDependencies(), prohibitedDependency);
    await assert.rejects(checkElectronOutput());
  } finally {
    await writeFile(manifestPath, manifestBytes);
  }

  await checkElectronOutput();
});
