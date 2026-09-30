import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {openDatabase} from '@shop-things/db';
import {expect, test} from 'vitest';

test('opens and closes a caller-selected database file', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-db-'));
  const databaseFilePath = join(directory, 'app.db');
  const handle = openDatabase(databaseFilePath);

  try {
    expect(await handle.db.all('select 1 as value')).toStrictEqual([{value: 1}]);
    expect((await stat(databaseFilePath)).isFile()).toBeTruthy();
    expect('client' in handle).toBe(false);
  } finally {
    handle.close();
    await rm(directory, {recursive: true, force: true});
  }
});
