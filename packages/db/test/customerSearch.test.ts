import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {createDatabase, createCustomer, listCustomers} from '@shop-things/db';
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
      expect(plan.map(row => row.detail).join('\n')).toContain('QUERY INDEX METHOD fts');
    } finally {
      client.prepare = prepare;
    }
  });
});
