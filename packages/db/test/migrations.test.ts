import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import type {AppDatabase, DatabaseHandle} from '@shop-things/db';
import {openDatabase, runMigrations} from '@shop-things/db';
import {expect, test} from 'vitest';

const fixtureFolder = fileURLToPath(new URL('./fixtures', import.meta.url));
const checkedInFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const applyCommand = fileURLToPath(
  new URL('../scripts/applyMigrations.mjs', import.meta.url)
);
const missingFolderError = /ENOENT/;
const invalidFolderError = /ENOTDIR/;
const absolutePathError = /absolute path/;
const failedMigrationError = /missing_table/;
const databaseArgumentError = /--database <absolute database file path>/;

async function withDatabase(
  callback: (context: {
    handle: DatabaseHandle;
    databaseFilePath: string;
    directory: string;
  }) => Promise<void>
) {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-migrations-'));
  const databaseFilePath = join(directory, 'app.db');
  const handle = openDatabase(databaseFilePath);

  try {
    await callback({handle, databaseFilePath, directory});
  } finally {
    handle.close();
    await rm(directory, {recursive: true, force: true});
  }
}

test("applies a real migration once and leaves the caller's database usable", async () => {
  await withDatabase(async ({handle}) => {
    await runMigrations(handle.db, {migrationsFolder: fixtureFolder});
    await handle.db.run("insert into items (name) values ('first')");
    await runMigrations(handle.db, {migrationsFolder: fixtureFolder});

    expect(await handle.db.all('select name from items')).toStrictEqual([
      {name: 'first'},
    ]);
    expect(await handle.db.all('select name from __drizzle_migrations')).toStrictEqual([
      {name: '20260928200000_create_items'},
    ]);
  });
});

test('rejects missing and invalid migration paths without closing the database', async () => {
  await withDatabase(async ({handle, directory}) => {
    await expect(
      runMigrations(handle.db, {migrationsFolder: join(directory, 'missing')})
    ).rejects.toThrow(missingFolderError);

    const invalidFolder = join(directory, 'not-a-folder');
    await writeFile(invalidFolder, 'not a migration directory');
    await expect(
      runMigrations(handle.db, {migrationsFolder: invalidFolder})
    ).rejects.toThrow(invalidFolderError);
    await expect(
      runMigrations(handle.db, {migrationsFolder: 'relative/path'})
    ).rejects.toThrow(absolutePathError);
    expect(await handle.db.all('select 1 as value')).toStrictEqual([{value: 1}]);
  });
});

test('propagates a failed migration and rolls back its schema change', async () => {
  await withDatabase(async ({handle, directory}) => {
    const migrationsFolder = join(directory, 'migrations');
    const migration = join(migrationsFolder, '20260928200100_failed');
    await mkdir(migration, {recursive: true});
    await writeFile(
      join(migration, 'migration.sql'),
      'CREATE TABLE should_rollback (id INTEGER);\n--> statement-breakpoint\nINSERT INTO missing_table VALUES (1);'
    );

    await expect(runMigrations(handle.db, {migrationsFolder})).rejects.toThrow(
      failedMigrationError
    );
    expect(
      await handle.db.all("select name from sqlite_master where name = 'should_rollback'")
    ).toStrictEqual([]);
    expect(await handle.db.all('select * from __drizzle_migrations')).toStrictEqual([]);
  });
});

test('local apply requires an explicit absolute database path', () => {
  for (const args of [[], ['--database', 'relative.db']]) {
    const result = spawnSync(process.execPath, [applyCommand, ...args], {
      encoding: 'utf8',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(databaseArgumentError);
  }
});

test('local apply and exported runner produce the same database state', async () => {
  await withDatabase(async ({handle, directory}) => {
    const commandFilePath = join(directory, 'command.db');
    const result = spawnSync(
      process.execPath,
      [applyCommand, '--database', commandFilePath],
      {
        cwd: tmpdir(),
        encoding: 'utf8',
      }
    );
    expect(result.status, `${result.stderr}`).toBe(0);

    await runMigrations(handle.db, {migrationsFolder: checkedInFolder});
    const commandHandle = openDatabase(commandFilePath);
    try {
      async function inspect(db: AppDatabase) {
        return {
          tables: await db.all(
            "select name from sqlite_master where type = 'table' order by name"
          ),
          migrations: await db.all('select name from __drizzle_migrations'),
        };
      }

      expect(await inspect(commandHandle.db)).toStrictEqual(await inspect(handle.db));
    } finally {
      commandHandle.close();
    }
  });
});
