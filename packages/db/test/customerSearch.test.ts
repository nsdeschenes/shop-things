import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  createDatabase,
  createCustomer,
  listCustomers,
  updateCustomer,
  deleteCustomer,
  importCustomerBatch,
  backupDatabase,
  openExistingDatabase,
} from '@shop-things/db';
import type {DatabaseHandle} from '@shop-things/db';
import {expect, test} from 'vitest';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const customerScan = /SCAN customers\b/i;

async function fixture(
  run: (handle: DatabaseHandle, directory: string) => Promise<void>
) {
  const directory = await mkdtemp(join(tmpdir(), 'customer-search-'));
  const handle = await createDatabase(join(directory, 'app.db'), {migrationsFolder});
  try {
    await run(handle, directory);
  } finally {
    handle.close();
    await rm(directory, {recursive: true, force: true});
  }
}

test('customer search uses indexed candidates without scanning customers', async () => {
  await fixture(async ({db}) => {
    const customer = await createCustomer(db, {firstName: 'Alice', lastName: 'Smith'});
    const client = db.$client;
    const prepare = client.prepare.bind(client);
    let captured: {source: string; params: unknown[]} | undefined;
    client.prepare = async source => {
      const statement = await prepare(source);
      const all = statement.all.bind(statement);
      statement.all = (...params) => {
        captured = {source, params};
        return all(...params);
      };

      return statement;
    };

    try {
      expect((await listCustomers(db, 'SMITH')).map(row => row.id)).toEqual([
        customer.id,
      ]);
      expect(captured).toBeDefined();
      const {source, params} = captured!;
      const plan = (await (
        await prepare('EXPLAIN QUERY PLAN ' + source)
      ).all(...params)) as Array<{detail: string}>;
      expect(plan.map(row => row.detail).join('\n')).not.toMatch(customerScan);
      expect(plan.map(row => row.detail).join('\n')).toContain(
        'SEARCH customer_name_grams USING INDEX'
      );
    } finally {
      client.prepare = prepare;
    }
  });
});

test('indexed search preserves literal substrings, Unicode folding and case variants', async () => {
  await fixture(async ({db}) => {
    for (const firstName of [
      'abc',
      'abC',
      'aBc',
      'aBC',
      'Abc',
      'AbC',
      'ABc',
      'ABC',
      'Kyle',
      'ſtan',
      'ÉMILIE',
      'Nul\0ÉMILIE',
      'ΣΩΚΡΆΤΗΣ',
      'ORIGIN',
      'aliZZce',
      'ab" OR x',
    ]) {
      await createCustomer(db, {firstName});
    }

    expect((await listCustomers(db, ' ABC ')).map(row => row.firstName)).toEqual([
      'abc',
      'abC',
      'aBc',
      'aBC',
      'Abc',
      'AbC',
      'ABc',
      'ABC',
    ]);
    for (const [query, expected] of [
      ['kyle', ['Kyle']],
      ['stan', ['ſtan']],
      [' éMi ', ['ÉMILIE', 'Nul\0ÉMILIE']],
      ['\0émi', ['Nul\0ÉMILIE']],
      ['σωκράτης', ['ΣΩΚΡΆΤΗΣ']],
      ['OR', ['ORIGIN', 'ab" OR x']],
      ['alice', []],
      ['ab" OR x', ['ab" OR x']],
      ['(?i)abc|.*', []],
      ['K', ['Kyle']],
      ['ſ', ['ſtan']],
    ] as const) {
      expect((await listCustomers(db, query)).map(row => row.firstName)).toEqual(
        expected
      );
    }

    expect((await listCustomers(db, '')).length).toBe(16);
    expect((await listCustomers(db, '   ')).length).toBe(16);
  });
});

test('number and indexed name hits share numeric ordering and never duplicate a customer', async () => {
  await fixture(async ({db}) => {
    const named = await createCustomer(db, {firstName: 'Name42', lastName: '42'});
    const exact = await createCustomer(db, {firstName: 'Number'});
    const leading = await createCustomer(db, {firstName: 'Name0042'});
    await updateCustomer(db, named, {customerNumber: 100});
    await updateCustomer(db, exact, {customerNumber: 42});
    expect((await listCustomers(db, '42')).map(row => row.customerNumber)).toEqual([
      3, 42, 100,
    ]);
    expect((await listCustomers(db, '0042')).map(row => row.customerNumber)).toEqual([
      3, 42,
    ]);
    expect((await listCustomers(db, '9007199254740992')).map(row => row.id)).toEqual([]);
    expect(leading.customerNumber).toBe(3);
  });
});

test.each(['wal', 'mvcc'])(
  'name search follows writes, rollback and backup reopening in %s mode',
  async mode => {
    await fixture(async ({db}, directory) => {
      await db.run(`pragma journal_mode = '${mode}'`);
      const customer = await createCustomer(db, {firstName: 'Original'});
      expect((await listCustomers(db, 'riginal')).map(row => row.id)).toEqual([
        customer.id,
      ]);
      const changed = await updateCustomer(db, customer, {firstName: 'Changed'});
      expect(await listCustomers(db, 'riginal')).toEqual([]);
      expect((await listCustomers(db, 'hanged')).map(row => row.id)).toEqual([
        customer.id,
      ]);
      await importCustomerBatch(db, () => [
        {customerNumber: 10, firstName: 'Imported', lastName: 'Backup'},
      ]);
      expect((await listCustomers(db, 'ported')).map(row => row.customerNumber)).toEqual([
        10,
      ]);
      await expect(
        importCustomerBatch(db, () => [
          {customerNumber: 11, firstName: 'Rolledback'},
          {customerNumber: 10, firstName: 'Conflicting'},
        ])
      ).rejects.toThrow();
      expect(await listCustomers(db, 'olledback')).toEqual([]);
      await db.run('BEGIN');
      await db.run(
        "update customers set firstName = 'Temporary' where customerNumber = 1"
      );
      expect((await listCustomers(db, 'emporary')).map(row => row.id)).toEqual([
        customer.id,
      ]);
      expect(await listCustomers(db, 'hanged')).toEqual([]);
      await db.run('ROLLBACK');
      expect(await listCustomers(db, 'emporary')).toEqual([]);
      expect((await listCustomers(db, 'hanged')).map(row => row.id)).toEqual([
        customer.id,
      ]);
      await deleteCustomer(db, changed);
      expect(await listCustomers(db, 'hanged')).toEqual([]);

      const backupPath = join(directory, 'backup.db');
      await backupDatabase(db, backupPath);
      const backup = await openExistingDatabase(backupPath, {migrationsFolder});
      try {
        expect(
          (await listCustomers(backup.db, 'ACK')).map(row => row.customerNumber)
        ).toEqual([10]);
        await createCustomer(backup.db, {firstName: 'Reopened'});
        expect(
          (await listCustomers(backup.db, 'opened')).map(row => row.firstName)
        ).toEqual(['Reopened']);
      } finally {
        backup.close();
      }
    });
  }
);

test.each([false, true])(
  'recognition rejects a missing or replaced name search index, replaced %s',
  async replaced => {
    await fixture(async ({db}, directory) => {
      await db.run('drop table customer_name_grams');
      if (replaced) {
        await db.run('create table customer_name_grams (gram text, customerId integer)');
      }

      await expect(
        openExistingDatabase(join(directory, 'app.db'), {migrationsFolder})
      ).rejects.toMatchObject({code: 'UNSUPPORTED_DATABASE'});
    });
  }
);

test('exceptional names and direct identity edits retain complete search results', async () => {
  await fixture(async ({db}) => {
    const long = await createCustomer(db, {firstName: 'x'.repeat(256) + 'Tail'});
    const nul = await createCustomer(db, {firstName: '\0Hidden'});
    const unicode = await createCustomer(db, {firstName: 'Ks', lastName: 'Unicode'});
    expect((await listCustomers(db, 'tail')).map(row => row.id)).toEqual([long.id]);
    expect((await listCustomers(db, 'hidden')).map(row => row.id)).toEqual([nul.id]);
    expect((await listCustomers(db, 'ks')).map(row => row.id)).toEqual([unicode.id]);
    await db.run(
      `update customers set id = 100, firstName = 'Direct' where id = ${nul.id}`
    );
    expect((await listCustomers(db, 'direct')).map(row => row.id)).toEqual([100]);
    expect(await listCustomers(db, 'hidden')).toEqual([]);
    expect(
      await db.all(`select gram from customer_name_grams where customerId = ${nul.id}`)
    ).toEqual([]);
    const [row] = await listCustomers(db, 'direct');
    expect(row).toBeDefined();
    await updateCustomer(db, row!, {firstName: 'Normal'});
    expect(
      await db.all(
        "select customerId from customer_name_grams where gram = '' and customerId = 100"
      )
    ).toEqual([]);
  });
});

test('recognition rejects an incomplete positions table or missing maintenance trigger', async () => {
  await fixture(async ({db}, directory) => {
    await db.run('delete from customer_name_positions where position = 128');
    await expect(
      openExistingDatabase(join(directory, 'app.db'), {migrationsFolder})
    ).rejects.toMatchObject({code: 'UNSUPPORTED_DATABASE'});
    await db.run('insert into customer_name_positions values (128)');
    await db.run('drop trigger customer_name_update');
    await expect(
      openExistingDatabase(join(directory, 'app.db'), {migrationsFolder})
    ).rejects.toMatchObject({code: 'UNSUPPORTED_DATABASE'});
  });
});
