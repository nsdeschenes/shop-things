import {chmod, mkdtemp, rm, copyFile, mkdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

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
} from '@shop-things/db';
import type {DatabaseHandle, CustomerChanges, CustomerValues} from '@shop-things/db';
import {assert, expect, test} from 'vitest';
const reloadError = /reload/;
const changedError = /changed/;
const numberConflictError = /already assigned/;
const missingCustomerError = /no longer exists/;
const lockError = /busy|locked|conflict|transaction/i;
const missingFileError = /ENOENT/;
const existingFileError = /EEXIST/;
const unsupportedError = /recognized/;
const readonlyError = /writable/;
const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));

async function fixture(
  run: (handle: DatabaseHandle, path: string, directory: string) => Promise<void>
) {
  const directory = await mkdtemp(join(tmpdir(), 'customers-'));
  const path = join(directory, 'app.db');
  const handle = await createDatabase(path, {migrationsFolder});
  try {
    await run(handle, path, directory);
  } finally {
    handle.close();
    await rm(directory, {recursive: true, force: true});
  }
}

test('customer workflow preserves cents, partial fields, identities and never revives revisions', async () => {
  await fixture(async ({db}) => {
    const first = await createCustomer(db, {
      firstName: ' Alice ',
      balance: '1000000000000.00',
      previousBalance: '-12.34',
      donate: true,
    });
    expect(first.customerNumber).toBe(1);
    expect(first.balance).toBe('1000000000000.00');
    expect(first.previousBalance).toBe('-12.34');
    expect(first.province).toBe('');

    const second = await createCustomer(db, {lastName: 'Smith'});
    expect(second.customerNumber).toBe(2);

    const changed = await updateCustomer(db, first, {balance: '0.01', stock: 12});
    expect(changed.firstName).toBe(' Alice ');
    expect(changed.donate).toBe(true);

    await updateCustomer(db, changed, {balance: first.balance});
    await expect(updateCustomer(db, first, {firstName: 'Old'})).rejects.toThrow(
      reloadError
    );
    await expect(deleteCustomer(db, first)).rejects.toThrow(changedError);
    await expect(
      updateCustomer(db, second, {firstName: 'Changed', customerNumber: 1})
    ).rejects.toThrow(numberConflictError);
    expect((await getCustomer(db, second.id))?.firstName).toBe('');

    await deleteCustomer(db, second);
    const reused = await createCustomer(db, {firstName: 'Reuse'});
    expect(reused.customerNumber).toBe(2);
    expect(reused.id > second.id).toBeTruthy();
    await expect(updateCustomer(db, second, {firstName: 'Wrong'})).rejects.toThrow(
      missingCustomerError
    );
  });
});

test('invalid writes reject every field with no changes; nullable reads do not persist defaults', async () => {
  await fixture(async ({db}) => {
    for (const invalid of [
      {},
      {firstName: ' '},
      {firstName: 'A', id: 3},
      {firstName: 'A', customerNumber: 4},
      {firstName: 1},
      {firstName: 'A', stock: -1},
      {firstName: 'A', stock: 1.5},
      {firstName: 'A', donate: 1},
      {firstName: 'A', balance: '1.234'},
      {firstName: 'A', balance: '1000000000000.01'},
      {firstName: 'A', balance: 1},
    ]) {
      await expect(createCustomer(db, invalid as CustomerValues)).rejects.toThrow();
    }

    expect(await listCustomers(db)).toStrictEqual([]);

    await db.run("insert into customers (firstName) values ('Nullable')");
    const [row] = await listCustomers(db);
    assert.isOk(row);
    expect(row.customerNumber).toBe(null);
    expect(row.balance).toBe('0.00');
    expect(row.donate).toBe(false);
    expect(
      await db.all('select lastName, donate, customerNumber from customers')
    ).toStrictEqual([{lastName: null, donate: null, customerNumber: null}]);

    for (const invalid of [
      {firstName: '', lastName: ' '},
      {firstName: 'Altered', balance: 'no'},
      {customerNumber: 0},
      {customerNumber: null},
      {stock: Number.MAX_SAFE_INTEGER + 1},
      {donate: 'true'},
      {revision: '3'},
      {unknown: true},
    ]) {
      await expect(updateCustomer(db, row, invalid as CustomerChanges)).rejects.toThrow();
      expect(await getCustomer(db, row.id)).toStrictEqual(row);
    }

    const assigned = await updateCustomer(db, row, {customerNumber: 3});
    expect(assigned.customerNumber).toBe(3);
  });
});

test('SQL search treats wildcard characters literally and orders by customer number', async () => {
  await fixture(async ({db}) => {
    await createCustomer(db, {firstName: 'Zed', lastName: 'smith'});
    const alice = await createCustomer(db, {firstName: 'Alice', lastName: 'Smith'});
    await createCustomer(db, {firstName: '100%_', lastName: 'A'});

    expect(
      (await listCustomers(db, '  SMITH  ')).map(row => row.firstName)
    ).toStrictEqual(['Zed', 'Alice']);
    expect((await listCustomers(db, '%_'))[0]?.firstName).toBe('100%_');
    expect((await listCustomers(db, String(alice.customerNumber)))[0]?.id).toBe(alice.id);
    expect(await listCustomers(db, 'Alice Smith')).toStrictEqual([]);
  });
});

test('customer numbers sort numerically with unassigned customers last in stable order', async () => {
  await fixture(async ({db}) => {
    const first = await createCustomer(db, {firstName: 'Alice'});
    const second = await createCustomer(db, {firstName: 'Zoe'});
    const third = await createCustomer(db, {firstName: 'Bob'});
    const fourth = await createCustomer(db, {firstName: 'Aaron'});
    await updateCustomer(db, first, {customerNumber: 10});
    await db.run(
      'update customers set customerNumber = null where customerNumber in (3, 4)'
    );
    expect((await listCustomers(db)).map(row => [row.id, row.customerNumber])).toEqual([
      [second.id, 2],
      [first.id, 10],
      [third.id, null],
      [fourth.id, null],
    ]);
  });
});

test('Unicode search matches literal mixed-case first and last names without regex or SQL injection', async () => {
  await fixture(async ({db}) => {
    const first = await createCustomer(db, {firstName: 'ÉMILIE', lastName: 'ÅNGSTRÖM'});
    const greek = await createCustomer(db, {firstName: 'ΣΩΚΡΆΤΗΣ', lastName: 'Other'});
    const literals = ".*+?^${}()|[]\\%_'; OR 1=1 --";
    const special = await createCustomer(db, {
      firstName: 'Before ' + literals + ' After',
      lastName: 'Literal',
    });
    const nul = await createCustomer(db, {firstName: 'Nul\0ÉMILIE', lastName: 'Nul'});
    expect((await listCustomers(db, ' éMi ')).map(row => row.id)).toStrictEqual([
      first.id,
      nul.id,
    ]);
    expect((await listCustomers(db, 'ångström')).map(row => row.id)).toStrictEqual([
      first.id,
    ]);
    expect((await listCustomers(db, 'σωκράτης')).map(row => row.id)).toStrictEqual([
      greek.id,
    ]);
    for (const needle of [literals, '.*', '[', '\\', '%_', "'; OR 1=1 --"]) {
      expect((await listCustomers(db, needle)).map(row => row.id)).toStrictEqual([
        special.id,
      ]);
    }

    expect(await listCustomers(db, '(?i)other|.*')).toStrictEqual([]);
    expect((await listCustomers(db, '\0émi')).map(row => row.id)).toStrictEqual([nul.id]);
  });
});

test('simultaneous writes across real connections allocate uniquely or fail without partial insertion', async () => {
  await fixture(async ({db}, path) => {
    const other = await openExistingDatabase(path, {migrationsFolder});
    try {
      const results = await Promise.allSettled([
        createCustomer(db, {firstName: 'One'}),
        createCustomer(other.db, {firstName: 'Two'}),
      ]);
      const rows = await listCustomers(db);
      expect(rows.length).toBe(
        results.filter(result => result.status === 'fulfilled').length
      );
      expect(new Set(rows.map(row => row.customerNumber)).size).toBe(rows.length);

      for (const result of results.filter(result => result.status === 'rejected')) {
        expect(String(result.reason) + String(result.reason.cause)).toMatch(lockError);
      }

      await createCustomer(db, {firstName: 'After'});
    } finally {
      other.close();
    }
  });
});

test('recognition rejects missing, unrelated, newer and read-only files and migrates recognized pending schema', async () => {
  await fixture(async (_handle, path, directory) => {
    await expect(
      openExistingDatabase(join(directory, 'missing.db'), {migrationsFolder})
    ).rejects.toThrow(missingFileError);
    await expect(createDatabase(path, {migrationsFolder})).rejects.toThrow(
      existingFileError
    );

    const unrelatedPath = join(directory, 'unrelated.db');
    const unrelated = openDatabase(unrelatedPath);
    await unrelated.db.run('create table CustomersLegacy (name text)');
    unrelated.close();
    await expect(openExistingDatabase(unrelatedPath, {migrationsFolder})).rejects.toThrow(
      unsupportedError
    );

    const newerPath = join(directory, 'newer.db');
    await backupDatabase(_handle.db, newerPath);
    const newer = openDatabase(newerPath);
    await newer.db.run(
      "insert into __drizzle_migrations (name, hash, created_at) values ('20990101000000_future', 'future', 9999999999999)"
    );
    newer.close();
    await expect(openExistingDatabase(newerPath, {migrationsFolder})).rejects.toThrow(
      unsupportedError
    );
    const invalidIndexPath = join(directory, 'invalid-index.db');
    await backupDatabase(_handle.db, invalidIndexPath);
    const invalidIndex = openDatabase(invalidIndexPath);
    await invalidIndex.db.run('drop index customers_customer_number_unique');
    invalidIndex.close();
    await expect(
      openExistingDatabase(invalidIndexPath, {migrationsFolder})
    ).rejects.toThrow(unsupportedError);

    const duplicatePath = join(directory, 'duplicate-history.db');
    await backupDatabase(_handle.db, duplicatePath);
    const duplicate = openDatabase(duplicatePath);
    await duplicate.db.run(
      'insert into __drizzle_migrations (name,hash,created_at) select name,hash,created_at from __drizzle_migrations where id = 1'
    );
    duplicate.close();
    await expect(openExistingDatabase(duplicatePath, {migrationsFolder})).rejects.toThrow(
      unsupportedError
    );

    const readonlyPath = join(directory, 'readonly.db');
    await backupDatabase(_handle.db, readonlyPath);
    await chmod(readonlyPath, 0o444);
    await expect(openExistingDatabase(readonlyPath, {migrationsFolder})).rejects.toThrow(
      readonlyError
    );

    await chmod(readonlyPath, 0o644);
    const pendingFolder = join(directory, 'pending');
    const initial = '20260929093112_wealthy_hemingway';
    await mkdir(join(pendingFolder, initial), {recursive: true});
    await copyFile(
      join(migrationsFolder, initial, 'migration.sql'),
      join(pendingFolder, initial, 'migration.sql')
    );
    const pendingPath = join(directory, 'pending.db');
    const pending = openDatabase(pendingPath);
    await runMigrations(pending.db, {migrationsFolder: pendingFolder});
    await pending.db.run("insert into customers (firstName) values ('Pending')");
    pending.close();
    const migrated = await openExistingDatabase(pendingPath, {migrationsFolder});
    try {
      expect((await listCustomers(migrated.db))[0]?.revision).toBe('1');
    } finally {
      migrated.close();
    }
  });
});

test('stored-cent mismatch rolls back all fields and revision within the transaction', async () => {
  await fixture(async ({db}) => {
    const row = await createCustomer(db, {firstName: 'Before', balance: '0.10'});
    await db.run(
      'create trigger corrupt_money after update of balance on customers begin update customers set balance = new.balance + 0.01 where id = new.id; end'
    );
    await expect(
      updateCustomer(db, row, {firstName: 'After', balance: '0.20'})
    ).rejects.toMatchObject({
      code: 'MONEY_PRECISION',
    });
    expect(await getCustomer(db, row.id)).toStrictEqual(row);
    await db.run('drop trigger corrupt_money');
    const changed = await updateCustomer(db, row, {balance: '999999999999.99'});
    expect(changed.balance).toBe('999999999999.99');
  });
});
