import {readFile, readdir} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {safeQueryDetails, safeQueryAttributes} from '@shop-things/db';
import {expect, test} from 'vitest';

const safeCases = [
  [
    'select "id", `customerNumber` from [customers] where firstName = \'private\' /* private */ and stock >= -12.3e2',
    'SELECT "id" , "customerNumber" FROM "customers" WHERE "firstName" = ? AND "stock" >= ?',
    'customers',
  ],
  [
    "select id from customers where email = 'escaped ''PRIVATE_SENTINEL' and stock = 0xAB",
    'SELECT "id" FROM "customers" WHERE "email" = ? AND "stock" = ?',
    'customers',
  ],
  [
    "select X'1234', ?123, :PRIVATE_SENTINEL, @PRIVATE_SENTINEL, $PRIVATE_SENTINEL",
    'SELECT ? , ? , ? , ? , ?',
    undefined,
  ],
  ["VACUUM INTO '/PRIVATE_SENTINEL/it''s.sqlite'", 'VACUUM INTO ?', undefined],
  [
    "select coalesce(firstName, '') from customers where customerNumber is not null",
    'SELECT COALESCE ( "firstName" , ? ) FROM "customers" WHERE "customerNumber" IS NOT ?',
    'customers',
  ],
  [
    'pragma index_info(customers_customer_number_unique)',
    'PRAGMA INDEX_INFO ( "customers_customer_number_unique" )',
    'customers',
  ],
  ['savepoint sp12', 'SAVEPOINT "sp"', undefined],
  ['rollback to savepoint sp12', 'ROLLBACK TO SAVEPOINT "sp"', undefined],
  ['release savepoint sp12', 'RELEASE SAVEPOINT "sp"', undefined],
] as const;

test.each(safeCases)(
  'reconstructs only trusted canonical tokens for %s',
  (source, text, table) => {
    const details = safeQueryDetails(source, 'all');
    expect(details.text).toBe(text);
    expect(details.table).toBe(table);
    expect(safeQueryDetails(details.text, 'all')).toEqual(details);
    expect(safeQueryAttributes(details)['db.query.text']).toBe(text);
  }
);

const unsafeCases = [
  'select private_column from customers',
  'select id from PRIVATE_SENTINEL',
  'select id as PRIVATE_SENTINEL from customers',
  'select PRIVATE_SENTINEL(id) from customers',
  'select id from PRIVATE_SENTINEL.customers',
  'select "PRIVATE_SENTINEL" from customers',
  'select `PRIVATE_SENTINEL` from customers',
  'select [PRIVATE_SENTINEL] from customers',
  'select id from customers as PRIVATE_SENTINEL',
  'select id from customers; select id from customers',
  "select 'unclosed",
  'select /* unclosed',
  "select X'123'",
  "select X'gg'",
  'select $PRIVATE_SENTINEL::suffix(also_private)',
  'select ?1PRIVATE_SENTINEL',
  'select 123ePRIVATE_SENTINEL',
  'select 0xPRIVATE_SENTINEL',
  'select (id from customers',
  'select id) from customers',
  'select id from customers where',
  'select id id from customers',
  'select id from customers join customers',
  'select id from customers\0',
  'select π from customers',
  'pragma database_list',
  'pragma table_info(PRIVATE_SENTINEL)',
  "attach '/PRIVATE_SENTINEL' as customers",
  'with PRIVATE_SENTINEL as (select 1) select 1',
  'create trigger PRIVATE_SENTINEL after update on customers begin select 1; end',
  'savepoint PRIVATE_SENTINEL',
  'select ' + '('.repeat(40) + '1' + ')'.repeat(40),
  'select ' + '1,'.repeat(2050) + '1',
  'select 1' + ' union all select 1'.repeat(40),
  'select ' + ' '.repeat(17000) + '1',
];

test.each(unsafeCases)(
  'omits the complete SQL and table for unsupported or malformed %s',
  source => {
    const details = safeQueryDetails(source, 'run');
    expect(details.text).toBeUndefined();
    expect(details.table).toBeUndefined();
    expect(Object.keys(details).sort()).toEqual(['method', 'operation']);
    expect(JSON.stringify(details)).not.toContain('PRIVATE_SENTINEL');
  }
);

test('literal, comment, and parameter contents do not influence emitted metadata', () => {
  const queries = [
    "select id from customers where email = 'private_one' -- private_comment\n",
    "select id from customers where email = 'very different '' secret' /* other_comment */",
    'select id from customers where email = :private_parameter',
    'select id from customers where email = ?',
  ].map(source => safeQueryDetails(source, 'get'));
  expect(queries).toEqual(
    Array.from({length: 4}, () => ({
      method: 'get',
      operation: 'SELECT',
      table: 'customers',
      text: 'SELECT "id" FROM "customers" WHERE "email" = ?',
    }))
  );
  expect(
    safeQueryAttributes({
      method: 'get',
      operation: 'SELECT',
      text: 'SELECT "id" FROM "customers" WHERE "email" = ?',
      table: 'sqlite_master',
    })
  ).not.toHaveProperty('db.collection.name');
  expect(
    safeQueryAttributes({
      method: 'get',
      operation: 'SELECT',
      text: 'select firstName from customers',
      table: 'customers',
    })
  ).not.toHaveProperty('db.query.text');
});

test('checked-in migrations yield canonical idempotent displays or bounded operation-only metadata', async () => {
  const folder = fileURLToPath(new URL('../migrations', import.meta.url));
  for (const name of await readdir(folder)) {
    const source = await readFile(join(folder, name, 'migration.sql'), 'utf8');
    for (const statement of source.split('--> statement-breakpoint')) {
      const details = safeQueryDetails(statement, 'run');
      expect(details.text ? safeQueryDetails(details.text, 'run') : details).toEqual(
        details
      );
      expect(details.text === undefined && details.table !== undefined).toBe(false);
    }
  }
});
