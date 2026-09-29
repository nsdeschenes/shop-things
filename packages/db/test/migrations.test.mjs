import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { openDatabase, runMigrations } from "@shop-things/db";

const fixtureFolder = fileURLToPath(new URL("./fixtures", import.meta.url));
const checkedInFolder = fileURLToPath(new URL("../migrations", import.meta.url));
const applyCommand = fileURLToPath(new URL("../scripts/apply-migrations.mjs", import.meta.url));
const missingFolderError = /ENOENT/;
const invalidFolderError = /ENOTDIR/;
const absolutePathError = /absolute path/;
const failedMigrationError = /missing_table/;
const databaseArgumentError = /--database <absolute database file path>/;

async function withDatabase(callback) {
  const directory = await mkdtemp(join(tmpdir(), "shop-things-migrations-"));
  const databaseFilePath = join(directory, "app.db");
  const handle = openDatabase(databaseFilePath);

  try {
    await callback({ handle, databaseFilePath, directory });
  } finally {
    handle.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("applies a real migration once and leaves the caller's database usable", async () => {
  await withDatabase(async ({ handle }) => {
    await runMigrations(handle.db, { migrationsFolder: fixtureFolder });
    await handle.db.run("insert into items (name) values ('first')");
    await runMigrations(handle.db, { migrationsFolder: fixtureFolder });

    assert.deepEqual(await handle.db.all("select name from items"), [{ name: "first" }]);
    assert.deepEqual(await handle.db.all("select name from __drizzle_migrations"), [
      { name: "20260928200000_create_items" },
    ]);
  });
});

test("rejects missing and invalid migration paths without closing the database", async () => {
  await withDatabase(async ({ handle, directory }) => {
    await assert.rejects(
      runMigrations(handle.db, { migrationsFolder: join(directory, "missing") }),
      missingFolderError,
    );

    const invalidFolder = join(directory, "not-a-folder");
    await writeFile(invalidFolder, "not a migration directory");
    await assert.rejects(
      runMigrations(handle.db, { migrationsFolder: invalidFolder }),
      invalidFolderError,
    );
    await assert.rejects(
      runMigrations(handle.db, { migrationsFolder: "relative/path" }),
      absolutePathError,
    );
    assert.deepEqual(await handle.db.all("select 1 as value"), [{ value: 1 }]);
  });
});

test("propagates a failed migration and rolls back its schema change", async () => {
  await withDatabase(async ({ handle, directory }) => {
    const migrationsFolder = join(directory, "migrations");
    const migration = join(migrationsFolder, "20260928200100_failed");
    await mkdir(migration, { recursive: true });
    await writeFile(
      join(migration, "migration.sql"),
      "CREATE TABLE should_rollback (id INTEGER);\n--> statement-breakpoint\nINSERT INTO missing_table VALUES (1);",
    );

    await assert.rejects(runMigrations(handle.db, { migrationsFolder }), failedMigrationError);
    assert.deepEqual(
      await handle.db.all("select name from sqlite_master where name = 'should_rollback'"),
      [],
    );
    assert.deepEqual(await handle.db.all("select * from __drizzle_migrations"), []);
  });
});

test("local apply requires an explicit absolute database path", () => {
  for (const args of [[], ["--database", "relative.db"]]) {
    const result = spawnSync(process.execPath, [applyCommand, ...args], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, databaseArgumentError);
  }
});

test("local apply and exported runner produce the same database state", async () => {
  await withDatabase(async ({ handle, directory }) => {
    const commandFilePath = join(directory, "command.db");
    const result = spawnSync(process.execPath, [applyCommand, "--database", commandFilePath], {
      cwd: tmpdir(),
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);

    await runMigrations(handle.db, { migrationsFolder: checkedInFolder });
    const commandHandle = openDatabase(commandFilePath);
    try {
      const inspect = async (db) => ({
        tables: await db.all("select name from sqlite_master where type = 'table' order by name"),
        migrations: await db.all("select name from __drizzle_migrations"),
      });
      assert.deepEqual(await inspect(commandHandle.db), await inspect(handle.db));
    } finally {
      commandHandle.close();
    }
  });
});
