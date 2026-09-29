import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { packageRoot, checkFreshness } from "../scripts/freshness.mjs";

const forbiddenRuntime =
  /(?:node:|electron|drizzle|@shop-things\/db|@tursodatabase|better-sqlite|sqlite3)/;

function build() {
  return spawnSync(process.execPath, ["scripts/build.mjs"], { cwd: packageRoot, encoding: "utf8" });
}

test("freshness rejects source/config/dependency changes, absent exports and failed output", async () => {
  await checkFreshness();
  const obsolete = resolve(packageRoot, "dist/obsolete.js");
  await writeFile(obsolete, "obsolete");
  assert.equal(build().status, 0);
  await assert.rejects(readFile(obsolete));
  await checkFreshness();
  for (const name of ["src/bridge.ts", "tsconfig.json", "package.json", "../../pnpm-lock.yaml"]) {
    const path = resolve(packageRoot, name);
    const original = await readFile(path, "utf8");
    try {
      // JSON remains valid; whitespace is still part of the relevant configuration content.
      await writeFile(path, original + "\n");
      await assert.rejects(checkFreshness());
    } finally {
      await writeFile(path, original);
    }

    await checkFreshness();
  }

  const artifact = resolve(packageRoot, "dist/client.js");
  const originalArtifact = await readFile(artifact);
  await writeFile(artifact, "partial output");
  await assert.rejects(checkFreshness());
  await writeFile(artifact, originalArtifact);
  await rm(artifact);
  await assert.rejects(checkFreshness());
  assert.equal(build().status, 0);
  const source = resolve(packageRoot, "src/bridge.ts");
  const original = await readFile(source, "utf8");
  try {
    await writeFile(source, original + "\nconst broken: string = 1;\n");
    assert.notEqual(build().status, 0);
    await assert.rejects(checkFreshness());
    await assert.rejects(readFile(resolve(packageRoot, "dist/fingerprint.json")));
  } finally {
    await writeFile(source, original);
  }

  assert.equal(build().status, 0);
  await checkFreshness();
});
test("compiled runtime entrypoints contain only browser-safe contract dependencies", async () => {
  for (const name of ["index", "bridge", "client", "schemas"]) {
    const code = await readFile(resolve(packageRoot, `dist/${name}.js`), "utf8");
    assert.doesNotMatch(code, forbiddenRuntime);
    const imports = Array.from(
      code.matchAll(/(?:from|import)\s*["']([^"']+)["']/g),
      (match) => match[1],
    );
    assert.ok(
      imports.every((name) => name === "zod" || name.startsWith("./")),
      imports.join(","),
    );
    if (name === "index" || name === "bridge") {
      assert.deepEqual(imports, []);
    }
  }
});
