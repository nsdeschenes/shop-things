import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  openDatabase,
  createDatabase,
  openExistingDatabase,
  backupDatabase,
  createCustomer,
  updateCustomer,
  listCustomers,
  safeQueryAttributes,
} from '@shop-things/db';
import type {QueryCompletion, QueryObserver, SafeQueryDetails} from '@shop-things/db';
import {Database} from '@tursodatabase/database';
import {expect, test} from 'vitest';

import {observeQueries} from '../src/queryObserver.js';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
function collector() {
  const queries: Array<SafeQueryDetails & QueryCompletion> = [];
  function observer(details: Readonly<SafeQueryDetails>): ReturnType<QueryObserver> {
    return completion => {
      queries.push({...details, ...completion});
    };
  }

  return {queries, observer};
}

test('indexed customer search retains sanitized query text and its customer collection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-query-search-'));
  const {queries, observer} = collector();
  const handle = await createDatabase(join(directory, 'app.sqlite'), {
    migrationsFolder,
    queryObserver: observer,
  });
  try {
    const customer = await createCustomer(handle.db, {firstName: 'PRIVATE_SENTINEL'});
    queries.length = 0;
    expect(
      (await listCustomers(handle.db, 'PRIVATE_SENTINEL')).map(row => row.id)
    ).toEqual([customer.id]);
    expect(queries).toHaveLength(1);
    const query = queries[0]!;
    expect(query).toMatchObject({
      method: 'all',
      operation: 'SELECT',
      table: 'customers',
      outcome: 'success',
    });
    expect(query.text).toContain('"customer_name_grams"');
    expect(query.text).toContain('"gram" IN ( ? , ? )');
    expect(query.text).toContain('UNION ALL SELECT');
    expect(safeQueryAttributes(query)).toMatchObject({
      'db.collection.name': 'customers',
      'db.query.text': query.text,
    });
    expect(JSON.stringify(queries)).not.toContain('PRIVATE_SENTINEL');
  } finally {
    handle.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('direct native calls and reusable fluent statements observe each execution once', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-query-'));
  try {
    const {queries, observer} = collector();
    const handle = openDatabase(join(directory, 'native.sqlite'), {
      queryObserver: observer,
    });
    try {
      const client = handle.db.$client;
      expect(client).toBeInstanceOf(Database);
      expect(Object.getPrototypeOf(client)).toBe(Database.prototype);
      expect(client.constructor).toBe(Database);
      await client.connect();
      await client.exec(
        'create table customers (id integer primary key, firstName text)'
      );
      expect(
        await client.run(
          'insert into customers values (?, ?)',
          1,
          'PRIVATE_SENTINEL_bind'
        )
      ).toMatchObject({changes: 1});
      expect(await client.all('select firstName from customers')).toEqual([
        {firstName: 'PRIVATE_SENTINEL_bind'},
      ]);
      expect(
        await client.get('select id from customers where id = :PRIVATE_SENTINEL', {
          PRIVATE_SENTINEL: 1,
        })
      ).toEqual({id: 1});
      expect(queries.map(query => query.method)).toEqual(['exec', 'run', 'all', 'get']);
      const statement = client.prepare(
        'select firstName from customers where id = ?'
      ) as unknown as Awaited<ReturnType<typeof client.prepare>>;
      expect(statement).not.toBeInstanceOf(Promise);
      expect(statement.constructor.name).toBe('Statement');
      expect(queries).toHaveLength(4);
      expect(statement.raw(true)).toBe(statement);
      expect(await statement.all([1])).toEqual([['PRIVATE_SENTINEL_bind']]);
      expect(statement.raw(false).pluck(true).safeIntegers(false)).toBe(statement);
      expect(await statement.get(1)).toBe('PRIVATE_SENTINEL_bind');
      expect(statement.pluck(false)).toBe(statement);
      expect(await statement.all(1, {queryTimeout: 1000})).toEqual([
        {firstName: 'PRIVATE_SENTINEL_bind'},
      ]);
      statement.close();
      expect(queries.map(query => query.method)).toEqual([
        'exec',
        'run',
        'all',
        'get',
        'all',
        'get',
        'all',
      ]);
      for (const query of queries) {
        expect(query.outcome).toBe('success');
        expect(Number.isFinite(query.durationMs) && query.durationMs >= 0).toBe(true);
        expect(Object.keys(query).sort()).toEqual(
          query.text
            ? ['durationMs', 'method', 'operation', 'outcome', 'table', 'text']
            : ['durationMs', 'method', 'operation', 'outcome']
        );
      }

      const update = client.prepare(
        'update customers set firstName = ? where id = ?'
      ) as unknown as Awaited<ReturnType<typeof client.prepare>>;
      expect(await update.run('PRIVATE_SENTINEL_updated', 1)).toMatchObject({changes: 1});
      expect(await update.run('PRIVATE_SENTINEL_reused', 1)).toMatchObject({changes: 1});
      update.close();
      expect(queries.slice(-2).map(query => query.method)).toEqual(['run', 'run']);
      expect(await client.get('select firstName from customers')).toEqual({
        firstName: 'PRIVATE_SENTINEL_reused',
      });
      expect(JSON.stringify(queries)).not.toContain('PRIVATE_SENTINEL');
      expect(() => client.prepare('')).toThrow(RangeError);
      expect(queries).toHaveLength(10);
    } finally {
      await handle.db.$client.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('native transaction modes, nested Drizzle savepoints, and rollback preserve results', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-query-tx-'));
  try {
    const {queries, observer} = collector();
    const handle = await createDatabase(join(directory, 'app.sqlite'), {
      migrationsFolder,
      queryObserver: observer,
    });
    try {
      queries.length = 0;
      const customer = await createCustomer(handle.db, {
        firstName: 'PRIVATE_SENTINEL',
        stock: 2,
      });
      expect(queries.map(query => query.operation)).toEqual([
        'BEGIN',
        'INSERT',
        'SELECT',
        'COMMIT',
      ]);
      expect(
        queries.every(
          query =>
            query.operation === 'BEGIN' ||
            query.operation === 'COMMIT' ||
            query.table === 'customers'
        )
      ).toBe(true);
      expect(await updateCustomer(handle.db, customer, {stock: 3})).toMatchObject({
        stock: 3,
      });
      queries.length = 0;
      expect(
        await handle.db.transaction(async tx => {
          await tx.run('update customers set stock = 4');
          return tx.transaction(async nested => {
            await nested.run('update customers set stock = 5');
            return 'saved';
          });
        })
      ).toBe('saved');
      expect(queries.map(query => query.operation)).toEqual([
        'BEGIN',
        'UPDATE',
        'SAVEPOINT',
        'UPDATE',
        'RELEASE',
        'COMMIT',
      ]);
      const failure = new Error('PRIVATE_SENTINEL_rollback');
      queries.length = 0;
      await expect(
        handle.db.transaction(async tx => {
          await tx.run('update customers set stock = 6');
          await tx.transaction(async nested => {
            await nested.run('update customers set stock = 7');
            throw failure;
          });
        })
      ).rejects.toBe(failure);
      expect(queries.map(query => query.operation)).toEqual([
        'BEGIN',
        'UPDATE',
        'SAVEPOINT',
        'UPDATE',
        'ROLLBACK',
        'ROLLBACK',
      ]);
      expect((await listCustomers(handle.db))[0]?.stock).toBe(5);
      queries.length = 0;
      const transaction = handle.db.$client.transaction(async () => {
        await handle.db.$client.run('update customers set stock = ?', 8);
        return customer;
      });
      expect(transaction.database).toBe(handle.db.$client);
      expect(await transaction.immediate()).toBe(customer);
      expect(queries.map(query => query.text)).toEqual([
        'BEGIN IMMEDIATE',
        'UPDATE "customers" SET "stock" = ?',
        'COMMIT',
      ]);
    } finally {
      await handle.db.$client.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('throwing observers preserve native results and the original native rejection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-query-errors-'));
  try {
    const raw = new Database(join(directory, 'native.sqlite'));
    try {
      let nativeFailure: unknown;
      const run = raw.run.bind(raw);
      raw.run = async (...args) => {
        try {
          return await run(...args);
        } catch (error) {
          nativeFailure = error;
          throw error;
        }
      };

      const client = observeQueries(raw, () => {
        throw new Error('observer start');
      });
      const {queries, observer} = collector();
      const finished = observeQueries(raw, details => {
        const finish = observer(details);
        return completion => {
          finish?.(completion);
          throw new Error('observer finish');
        };
      });
      await client.connect();
      await client.exec('create table customers (id integer primary key, stock integer)');
      expect(await client.run('insert into customers values (?, ?)', 1, 2)).toMatchObject(
        {
          changes: 1,
        }
      );
      expect(await finished.get('select stock from customers')).toEqual({stock: 2});
      await expect(
        finished.run('insert into customers values (?, ?)', 1, 3)
      ).rejects.toThrow();
      const caught = await finished
        .run('insert into customers values (?, ?)', 1, 4)
        .catch(error => error);
      expect(caught).toBeInstanceOf(Error);
      expect(caught).toBe(nativeFailure);
      expect(queries.map(query => query.outcome)).toEqual(['success', 'error', 'error']);
      expect(await client.all('select * from customers')).toEqual([{id: 1, stock: 2}]);
      expect(Object.keys(queries[1]!).sort()).toEqual([
        'durationMs',
        'method',
        'operation',
        'outcome',
        'table',
        'text',
      ]);
    } finally {
      await raw.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('observers are client-local and lifecycle observations begin before migrations and recognition', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-query-lifecycle-'));
  try {
    const first = collector();
    const second = collector();
    const path = join(directory, 'app.sqlite');
    const handle = await createDatabase(path, {
      migrationsFolder,
      queryObserver: first.observer,
    });
    try {
      const other = openDatabase(join(directory, 'other.sqlite'), {
        queryObserver: second.observer,
      });
      try {
        expect(first.queries.some(query => query.operation === 'CREATE')).toBe(true);
        expect(first.queries.some(query => query.operation === 'COMMIT')).toBe(true);
        const previous = first.queries.length;
        await Promise.all([
          handle.db.$client.get('select 1'),
          other.db.$client.get('select 2'),
        ]);
        expect(first.queries).toHaveLength(previous + 1);
        expect(second.queries).toHaveLength(1);
        const backup = join(directory, 'PRIVATE_SENTINEL_backup.sqlite');
        await backupDatabase(handle.db, backup);
        expect(first.queries.at(-1)).toMatchObject({
          operation: 'VACUUM',
          text: 'VACUUM INTO ?',
          outcome: 'success',
        });
        expect((await readFile(backup)).length).toBeGreaterThan(0);
      } finally {
        await other.db.$client.close();
      }
    } finally {
      await handle.db.$client.close();
    }

    const reopened = await openExistingDatabase(path, {
      migrationsFolder,
      queryObserver: second.observer,
    });
    try {
      expect(
        second.queries.some(
          query => query.operation === 'PRAGMA' && query.table === 'customers'
        )
      ).toBe(true);
      expect(second.queries.at(-1)).toMatchObject({
        operation: 'ROLLBACK',
        outcome: 'success',
      });
      expect(JSON.stringify([...first.queries, ...second.queries])).not.toContain(
        'PRIVATE_SENTINEL'
      );
    } finally {
      await reopened.db.$client.close();
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
