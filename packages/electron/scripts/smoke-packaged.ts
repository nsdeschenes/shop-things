import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const fixture = fileURLToPath(new URL("../../db/test/fixtures", import.meta.url));

async function runPackagedDatabase(resources: string) {
  const dbModule = join(
    resources,
    "app.asar",
    "node_modules",
    "@shop-things",
    "db",
    "dist",
    "index.js",
  );
  const {
    openDatabase,
    runMigrations,
  }: Pick<typeof import("@shop-things/db"), "openDatabase" | "runMigrations"> = await import(
    pathToFileURL(dbModule).href
  );
  const directory = await mkdtemp(join(tmpdir(), "shop-things-packaged-db-"));
  const migrationsFolder = join(resources, "migrations");

  try {
    const handle = openDatabase(join(directory, "app.db"));
    let packagedMigrationNames;
    try {
      await runMigrations(handle.db, { migrationsFolder });
      packagedMigrationNames = await handle.db.all("select name from __drizzle_migrations");
    } finally {
      handle.close();
    }

    // Prove this packaged runner can execute fixture SQL without adding a test
    // migration to app data.
    const fixtureFolder = join(directory, "fixture");
    await cp(fixture, fixtureFolder, { recursive: true });
    const fixtureHandle = openDatabase(join(directory, "fixture.db"));
    try {
      await runMigrations(fixtureHandle.db, { migrationsFolder: fixtureFolder });
      assert.deepEqual(await fixtureHandle.db.all("select name from items"), []);
      assert.deepEqual(await fixtureHandle.db.all("select name from __drizzle_migrations"), [
        { name: "20260928200000_create_items" },
      ]);
    } finally {
      fixtureHandle.close();
    }

    return { packagedMigrationNames, fixtureMigrationNames: ["20260928200000_create_items"] };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const resources = process.argv[2];
assert.ok(resources, "Runtime smoke requires a resources directory");
process.stdout.write(`${JSON.stringify(await runPackagedDatabase(resources))}\n`);
