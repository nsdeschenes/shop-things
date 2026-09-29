import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, copyFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vitest";
import {
  createDatabase,
  openExistingDatabase,
  openDatabase,
  runMigrations,
  createCustomer,
  listCustomers,
  getCustomer,
  updateCustomer,
  deleteCustomer,
  backupDatabase,
} from "@shop-things/db";
import type { DatabaseHandle, CustomerChanges, CustomerValues } from "@shop-things/db";
const reloadError = /reload/;
const changedError = /changed/;
const numberConflictError = /already assigned/;
const missingCustomerError = /no longer exists/;
const lockError = /busy|locked|conflict|transaction/i;
const missingFileError = /ENOENT/;
const existingFileError = /EEXIST/;
const unsupportedError = /recognized/;
const readonlyError = /writable/;
const migrationsFolder = fileURLToPath(new URL("../migrations", import.meta.url));
async function fixture(
  run: (handle: DatabaseHandle, path: string, directory: string) => Promise<void>,
) {
  const directory = await mkdtemp(join(tmpdir(), "customers-"));
  const path = join(directory, "app.db");
  const handle = await createDatabase(path, { migrationsFolder });
  try {
    await run(handle, path, directory);
  } finally {
    handle.close();
    await rm(directory, { recursive: true, force: true });
  }
}

test("customer workflow preserves cents, partial fields, identities and never revives revisions", async () => {
  await fixture(async ({ db }, _path, directory) => {
    const first = await createCustomer(db, {
      firstName: " Alice ",
      balance: "1000000000000.00",
      previousBalance: "-12.34",
      donate: true,
    });
    assert.equal(first.customerNumber, 1);
    assert.equal(first.balance, "1000000000000.00");
    assert.equal(first.previousBalance, "-12.34");
    assert.equal(first.province, "");
    const second = await createCustomer(db, { lastName: "Smith" });
    assert.equal(second.customerNumber, 2);
    const changed = await updateCustomer(db, first, { balance: "0.01", stock: 12 });
    assert.equal(changed.firstName, " Alice ");
    assert.equal(changed.donate, true);
    await updateCustomer(db, changed, { balance: first.balance });
    await assert.rejects(updateCustomer(db, first, { firstName: "Old" }), reloadError);
    await assert.rejects(deleteCustomer(db, first), changedError);
    await assert.rejects(
      updateCustomer(db, second, { firstName: "Changed", customerNumber: 1 }),
      numberConflictError,
    );
    assert.equal((await getCustomer(db, second.id))?.firstName, "");
    await deleteCustomer(db, second);
    const reused = await createCustomer(db, { firstName: "Reuse" });
    assert.equal(reused.customerNumber, 2);
    assert.ok(reused.id > second.id);
    await assert.rejects(updateCustomer(db, second, { firstName: "Wrong" }), missingCustomerError);
    const destination = join(directory, "backup.db");
    await backupDatabase(db, destination);
    const backup = await openExistingDatabase(destination, { migrationsFolder });
    try {
      assert.deepEqual(await listCustomers(backup.db), await listCustomers(db));
    } finally {
      backup.close();
    }
  });
});
test("invalid writes reject every field with no changes; nullable reads do not persist defaults", async () => {
  await fixture(async ({ db }) => {
    for (const invalid of [
      {},
      { firstName: " " },
      { firstName: "A", id: 3 },
      { firstName: "A", customerNumber: 4 },
      { firstName: 1 },
      { firstName: "A", stock: -1 },
      { firstName: "A", stock: 1.5 },
      { firstName: "A", donate: 1 },
      { firstName: "A", balance: "1.234" },
      { firstName: "A", balance: "1000000000000.01" },
      { firstName: "A", balance: 1 },
    ]) {
      await assert.rejects(createCustomer(db, invalid as CustomerValues));
    }

    assert.deepEqual(await listCustomers(db), []);
    await db.run("insert into customers (firstName) values ('Nullable')");
    const [row] = await listCustomers(db);
    assert.ok(row);
    assert.equal(row.customerNumber, null);
    assert.equal(row.balance, "0.00");
    assert.equal(row.donate, false);
    assert.deepEqual(await db.all("select lastName, donate, customerNumber from customers"), [
      { lastName: null, donate: null, customerNumber: null },
    ]);
    for (const invalid of [
      { firstName: "", lastName: " " },
      { firstName: "Altered", balance: "no" },
      { customerNumber: 0 },
      { customerNumber: null },
      { stock: Number.MAX_SAFE_INTEGER + 1 },
      { donate: "true" },
      { revision: "3" },
      { unknown: true },
    ]) {
      await assert.rejects(updateCustomer(db, row, invalid as CustomerChanges));
      assert.deepEqual(await getCustomer(db, row.id), row);
    }

    const assigned = await updateCustomer(db, row, { customerNumber: 3 });
    assert.equal(assigned.customerNumber, 3);
  });
});
test("SQL search treats wildcard characters literally and orders names/numbers deterministically", async () => {
  await fixture(async ({ db }) => {
    await createCustomer(db, { firstName: "Zed", lastName: "smith" });
    const alice = await createCustomer(db, { firstName: "Alice", lastName: "Smith" });
    await createCustomer(db, { firstName: "100%_", lastName: "A" });
    assert.deepEqual(
      (await listCustomers(db, "  SMITH  ")).map((row) => row.firstName),
      ["Alice", "Zed"],
    );
    assert.equal((await listCustomers(db, "%_"))[0]?.firstName, "100%_");
    assert.equal((await listCustomers(db, String(alice.customerNumber)))[0]?.id, alice.id);
    assert.deepEqual(await listCustomers(db, "Alice Smith"), []);
  });
});
test("simultaneous writes across real connections allocate uniquely or fail without partial insertion", async () => {
  await fixture(async ({ db }, path) => {
    const other = await openExistingDatabase(path, { migrationsFolder });
    try {
      const results = await Promise.allSettled([
        createCustomer(db, { firstName: "One" }),
        createCustomer(other.db, { firstName: "Two" }),
      ]);
      const rows = await listCustomers(db);
      assert.equal(rows.length, results.filter((result) => result.status === "fulfilled").length);
      assert.equal(new Set(rows.map((row) => row.customerNumber)).size, rows.length);
      for (const result of results) {
        if (result.status === "rejected") {
          assert.match(String(result.reason) + String(result.reason.cause), lockError);
        }
      }

      await createCustomer(db, { firstName: "After" });
    } finally {
      other.close();
    }
  });
});
test("recognition rejects missing, unrelated, newer and read-only files and migrates recognized pending schema", async () => {
  await fixture(async (_handle, path, directory) => {
    await assert.rejects(
      openExistingDatabase(join(directory, "missing.db"), { migrationsFolder }),
      missingFileError,
    );
    await assert.rejects(createDatabase(path, { migrationsFolder }), existingFileError);
    const unrelatedPath = join(directory, "unrelated.db");
    const unrelated = openDatabase(unrelatedPath);
    await unrelated.db.run("create table CustomersLegacy (name text)");
    unrelated.close();
    await assert.rejects(
      openExistingDatabase(unrelatedPath, { migrationsFolder }),
      unsupportedError,
    );
    const newerPath = join(directory, "newer.db");
    await backupDatabase(_handle.db, newerPath);
    const newer = openDatabase(newerPath);
    await newer.db.run(
      "insert into __drizzle_migrations (name, hash, created_at) values ('20990101000000_future', 'future', 9999999999999)",
    );
    newer.close();
    await assert.rejects(openExistingDatabase(newerPath, { migrationsFolder }), unsupportedError);
    const invalidIndexPath = join(directory, "invalid-index.db");
    await backupDatabase(_handle.db, invalidIndexPath);
    const invalidIndex = openDatabase(invalidIndexPath);
    await invalidIndex.db.run("drop index customers_customer_number_unique");
    invalidIndex.close();
    await assert.rejects(
      openExistingDatabase(invalidIndexPath, { migrationsFolder }),
      unsupportedError,
    );
    const duplicatePath = join(directory, "duplicate-history.db");
    await backupDatabase(_handle.db, duplicatePath);
    const duplicate = openDatabase(duplicatePath);
    await duplicate.db.run(
      "insert into __drizzle_migrations (name,hash,created_at) select name,hash,created_at from __drizzle_migrations where id = 1",
    );
    duplicate.close();
    await assert.rejects(
      openExistingDatabase(duplicatePath, { migrationsFolder }),
      unsupportedError,
    );
    const readonlyPath = join(directory, "readonly.db");
    await backupDatabase(_handle.db, readonlyPath);
    await chmod(readonlyPath, 0o444);
    await assert.rejects(openExistingDatabase(readonlyPath, { migrationsFolder }), readonlyError);
    await chmod(readonlyPath, 0o644);
    const pendingFolder = join(directory, "pending");
    const initial = "20260929093112_wealthy_hemingway";
    await mkdir(join(pendingFolder, initial), { recursive: true });
    await copyFile(
      join(migrationsFolder, initial, "migration.sql"),
      join(pendingFolder, initial, "migration.sql"),
    );
    const pendingPath = join(directory, "pending.db");
    const pending = openDatabase(pendingPath);
    await runMigrations(pending.db, { migrationsFolder: pendingFolder });
    await pending.db.run("insert into customers (firstName) values ('Pending')");
    pending.close();
    const migrated = await openExistingDatabase(pendingPath, { migrationsFolder });
    try {
      assert.equal((await listCustomers(migrated.db))[0]?.revision, "1");
    } finally {
      migrated.close();
    }
  });
});

test("stored-cent mismatch rolls back all fields and revision within the transaction", async () => {
  await fixture(async ({ db }) => {
    const row = await createCustomer(db, { firstName: "Before", balance: "0.10" });
    await db.run(
      "create trigger corrupt_money after update of balance on customers begin update customers set balance = new.balance + 0.01 where id = new.id; end",
    );
    await assert.rejects(updateCustomer(db, row, { firstName: "After", balance: "0.20" }), {
      code: "MONEY_PRECISION",
    });
    assert.deepEqual(await getCustomer(db, row.id), row);
    await db.run("drop trigger corrupt_money");
    const changed = await updateCustomer(db, row, { balance: "999999999999.99" });
    assert.equal(changed.balance, "999999999999.99");
  });
});
