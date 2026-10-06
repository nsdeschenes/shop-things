import {spawnSync} from 'node:child_process';
import {cp, mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import type {AppDatabase, DatabaseHandle} from '@shop-things/db';
import {
  openDatabase,
  openExistingDatabase,
  runMigrations,
  listCustomers,
  createCustomer,
} from '@shop-things/db';
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

test.each([1, 2])(
  'opening a database with %i migrations preserves phone values through the rename',
  async migrationCount => {
    const directory = await mkdtemp(join(tmpdir(), 'shop-things-phone-migration-'));
    const databaseFilePath = join(directory, 'app.db');
    const legacyFolder = join(directory, 'legacy');
    const legacyMigrations = [
      '20260929093112_wealthy_hemingway',
      '20260929120000_customer_integrity',
    ];
    try {
      await mkdir(legacyFolder);
      for (const name of legacyMigrations.slice(0, migrationCount)) {
        await cp(join(checkedInFolder, name), join(legacyFolder, name), {
          recursive: true,
        });
      }

      const legacy = openDatabase(databaseFilePath);
      try {
        await runMigrations(legacy.db, {migrationsFolder: legacyFolder});
        await legacy.db.run(
          "insert into customers (customerNumber,firstName,homePhone) values (1,'Number',' +1 (902) 555-1234 ext. 5 '),(2,'Empty',''),(3,'Null',NULL)"
        );
      } finally {
        legacy.close();
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        const migrated = await openExistingDatabase(databaseFilePath, {
          migrationsFolder: checkedInFolder,
        });
        try {
          expect(
            await migrated.db.all(
              'select id,customerNumber,firstName,phone,revision from customers order by id'
            )
          ).toStrictEqual([
            {
              id: 1,
              customerNumber: 1,
              firstName: 'Number',
              phone: ' +1 (902) 555-1234 ext. 5 ',
              revision: 1,
            },
            {id: 2, customerNumber: 2, firstName: 'Empty', phone: '', revision: 1},
            {id: 3, customerNumber: 3, firstName: 'Null', phone: null, revision: 1},
          ]);
          const columns = await migrated.db.all<{name: string}>(
            'pragma table_info(customers)'
          );
          expect(columns.map(column => column.name)).toContain('phone');
          expect(columns.map(column => column.name)).not.toContain('homePhone');
          expect(
            await migrated.db.all('select name from __drizzle_migrations order by id')
          ).toStrictEqual([
            ...legacyMigrations.map(name => ({name})),
            {name: '20261001005150_rename_home_phone'},
            {name: '20261006232551_required_customer_numbers'},
          ]);
        } finally {
          migrated.close();
        }
      }
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  }
);

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

const legacyNames = [
  '20260929093112_wealthy_hemingway',
  '20260929120000_customer_integrity',
  '20261001005150_rename_home_phone',
];

async function withLegacyDatabase(
  migrationCount: number,
  callback: (path: string) => Promise<void>
) {
  const directory = await mkdtemp(join(tmpdir(), 'customer-numbers-'));
  const path = join(directory, 'app.db');
  const legacyFolder = join(directory, 'legacy');
  try {
    await mkdir(legacyFolder);
    for (const name of legacyNames.slice(0, migrationCount)) {
      await cp(join(checkedInFolder, name), join(legacyFolder, name), {recursive: true});
    }

    const legacy = openDatabase(path);
    try {
      await runMigrations(legacy.db, {migrationsFolder: legacyFolder});
    } finally {
      legacy.close();
    }

    await callback(path);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
}

test.each([1, 2, 3])(
  'opening legacy prefix %i assigns gaps in customer ID order and preserves data',
  async count => {
    await withLegacyDatabase(count, async path => {
      const legacy = openDatabase(path);
      const phone = count === 3 ? 'phone' : 'homePhone';
      let before: Record<string, unknown>[];
      try {
        await legacy.db.run(
          `insert into customers (id,customerNumber,firstName,lastName,address,city,province,postalCode,${phone},email,stock,balance,previousBalance,donate,comments) values (9,NULL,'Nine','Last','Street','City','NS','Code','555','a@example.test',7,12.34,-5.67,1,'Comment'),(3,NULL,'Three',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),(1,1,'One',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),(5,3,'Five',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),(10,1000000,'Sparse',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL),(99,99,'Deleted',NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL,NULL)`
        );
        await legacy.db.run('delete from customers where id = 99');
        before = await legacy.db.all('select * from customers order by id');
      } finally {
        legacy.close();
      }

      for (let attempt = 0; attempt < 2; attempt++) {
        const upgraded = await openExistingDatabase(path, {
          migrationsFolder: checkedInFolder,
        });
        try {
          const after = await upgraded.db.all<Record<string, unknown>>(
            'select * from customers order by id'
          );
          expect(after).toEqual(
            before.map(row => {
              const {homePhone, ...fields} = row;
              return {
                ...fields,
                ...(count < 3 ? {phone: homePhone} : {}),
                customerNumber: row.id === 3 ? 2 : row.id === 9 ? 4 : row.customerNumber,
                revision: row.customerNumber === null ? 2 : 1,
              };
            })
          );
          expect(
            (await listCustomers(upgraded.db)).map(row => row.customerNumber)
          ).toEqual([1, 2, 3, 4, 1000000]);
          expect((await listCustomers(upgraded.db, '4')).map(row => row.id)).toEqual([9]);
        } finally {
          upgraded.close();
        }
      }

      const upgraded = await openExistingDatabase(path, {
        migrationsFolder: checkedInFolder,
      });
      try {
        const created = await createCustomer(upgraded.db, {firstName: 'New'});
        expect(created.customerNumber).toBe(5);
        expect(created.id).toBe(100);
      } finally {
        upgraded.close();
      }
    });
  }
);

test.each([
  ...['0', '-1', '1.5', '9007199254740992', "'invalid'", '1'].map(invalid => ({
    count: 1,
    invalid,
  })),
  {count: 2, invalid: '0'},
  {count: 3, invalid: '0'},
])(
  'invalid legacy assigned number $invalid in prefix $count fails without any migration or data change',
  async ({count, invalid}) => {
    await withLegacyDatabase(count, async path => {
      const legacy = openDatabase(path);
      let before: unknown;
      try {
        await legacy.db.run(
          `insert into customers (customerNumber,firstName) values (NULL,'Missing'),(1,'Assigned'),(${invalid},'Invalid')`
        );
        before = {
          rows: await legacy.db.all('select * from customers order by id'),
          schema: await legacy.db.all('select name,sql from sqlite_master order by name'),
          history: await legacy.db.all('select * from __drizzle_migrations'),
        };
      } finally {
        legacy.close();
      }

      await expect(
        openExistingDatabase(path, {migrationsFolder: checkedInFolder})
      ).rejects.toThrow();
      const original = openDatabase(path);
      try {
        expect({
          rows: await original.db.all('select * from customers order by id'),
          schema: await original.db.all(
            'select name,sql from sqlite_master order by name'
          ),
          history: await original.db.all('select * from __drizzle_migrations'),
        }).toEqual(before);
      } finally {
        original.close();
      }
    });
  }
);

test.each([true, false])(
  'legacy customers with all numbers missing: %s keep valid assigned numbers or receive consecutive numbers',
  async missing => {
    await withLegacyDatabase(3, async path => {
      const legacy = openDatabase(path);
      try {
        await legacy.db.run(
          `insert into customers (id,customerNumber,firstName,revision) values (5,${missing ? 'NULL' : '10'},'Five',7),(2,${missing ? 'NULL' : '2'},'Two',3)`
        );
      } finally {
        legacy.close();
      }

      const upgraded = await openExistingDatabase(path, {
        migrationsFolder: checkedInFolder,
      });
      try {
        expect(
          (await listCustomers(upgraded.db)).map(row => [
            row.id,
            row.customerNumber,
            row.revision,
          ])
        ).toEqual(
          missing
            ? [
                [2, 1, '4'],
                [5, 2, '8'],
              ]
            : [
                [2, 2, '3'],
                [5, 10, '7'],
              ]
        );
      } finally {
        upgraded.close();
      }
    });
  }
);

test('upgrading an empty legacy database preserves deleted customer identity high-water mark', async () => {
  await withLegacyDatabase(3, async path => {
    const legacy = openDatabase(path);
    try {
      await legacy.db.run(
        "insert into customers (id, customerNumber, firstName) values (99, 1, 'Deleted')"
      );
      await legacy.db.run('delete from customers');
    } finally {
      legacy.close();
    }

    const upgraded = await openExistingDatabase(path, {
      migrationsFolder: checkedInFolder,
    });
    try {
      const created = await createCustomer(upgraded.db, {firstName: 'New'});
      expect([created.id, created.customerNumber]).toEqual([100, 1]);
    } finally {
      upgraded.close();
    }
  });
});
