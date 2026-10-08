import {spawnSync} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, readdir, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  backupDatabase,
  openDatabase,
  openExistingDatabase,
  runMigrations,
} from '@shop-things/db';
import {expect, test, vi} from 'vitest';

const faults = vi.hoisted(() => ({snapshotSync: false}));
vi.mock('node:fs/promises', async importOriginal => {
  const filesystem = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...filesystem,
    open: async (...args: Parameters<typeof filesystem.open>) => {
      const file = await filesystem.open(...args);
      if (faults.snapshotSync && String(args[0]).endsWith('snapshot.db')) {
        file.sync = async () => {
          throw new Error('EIO: snapshot fsync failed');
        };
      }

      return file;
    },
  };
});

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const legacyName = '20260929093112_wealthy_hemingway';

async function legacyFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'migration-backup-'));
  const legacyFolder = join(directory, 'legacy');
  await mkdir(legacyFolder);
  await cp(join(migrationsFolder, legacyName), join(legacyFolder, legacyName), {
    recursive: true,
  });
  const path = join(directory, 'customers.db');
  const handle = openDatabase(path);
  await runMigrations(handle.db, {migrationsFolder: legacyFolder});
  await handle.db.run(
    "insert into customers(customerNumber,firstName,homePhone) values(1,'Committed','555')"
  );
  handle.close();
  return {directory, path, migrationBackupDirectory: join(directory, 'backups')};
}

test('existing open retains a durable unmigrated snapshot and does not repeat it when current', async () => {
  const fixture = await legacyFixture();
  try {
    const migrated = await openExistingDatabase(fixture.path, {
      migrationsFolder,
      migrationBackupDirectory: fixture.migrationBackupDirectory,
    });
    migrated.close();
    const sources = await readdir(fixture.migrationBackupDirectory);
    expect(sources).toHaveLength(1);
    const sourceDirectory = join(fixture.migrationBackupDirectory, sources[0]!);
    const attempts = await readdir(sourceDirectory);
    expect(attempts).toHaveLength(1);
    const attemptDirectory = join(sourceDirectory, attempts[0]!);
    const snapshot = join(attemptDirectory, 'snapshot.db');
    const metadata = JSON.parse(
      await readFile(join(attemptDirectory, 'metadata.json'), 'utf8')
    );
    expect(metadata.sourceHistory.map((row: {name: string}) => row.name)).toEqual([
      legacyName,
    ]);
    expect(metadata.targetMigrations).toHaveLength(4);
    expect((await stat(snapshot)).mode & 0o777).toBe(0o600);
    expect((await stat(attemptDirectory)).mode & 0o777).toBe(0o700);
    const backup = openDatabase(snapshot);
    try {
      expect(await backup.db.all('select firstName,homePhone from customers')).toEqual([
        {firstName: 'Committed', homePhone: '555'},
      ]);
      expect(await backup.db.all('select name from __drizzle_migrations')).toEqual([
        {name: legacyName},
      ]);
      expect(await backup.db.all('pragma integrity_check')).toEqual([
        {integrity_check: 'ok'},
      ]);
    } finally {
      backup.close();
    }

    const current = await openExistingDatabase(fixture.path, {
      migrationsFolder,
      migrationBackupDirectory: fixture.migrationBackupDirectory,
    });
    current.close();
    expect(await readdir(sourceDirectory)).toEqual(attempts);
  } finally {
    await rm(fixture.directory, {recursive: true, force: true});
  }
});

test('retained pinned backend ownership excludes another process through snapshot creation', async () => {
  const fixture = await legacyFixture();
  const handle = openDatabase(fixture.path);
  try {
    await handle.db.all('select * from customers');
    await backupDatabase(handle.db, join(fixture.directory, 'locked-snapshot.db'));
    const child = spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import {connect} from '@tursodatabase/database';
      try { const db = await connect(process.argv[1]); await db.exec("insert into customers(customerNumber) values(2)"); db.close(); }
      catch(error) { console.error(error.message); process.exitCode = 2; }
    `,
        fixture.path,
      ],
      {encoding: 'utf8'}
    );
    expect(child.status).toBe(2);
    expect(child.stderr).toContain('locked by another process');
    expect(await handle.db.all('select customerNumber from customers')).toEqual([
      {customerNumber: 1},
    ]);
  } finally {
    handle.close();
    await rm(fixture.directory, {recursive: true, force: true});
  }
});

test('backup storage failure blocks migration and preserves the candidate for retry', async () => {
  const fixture = await legacyFixture();
  const {writeFile} = await import('node:fs/promises');
  try {
    await writeFile(fixture.migrationBackupDirectory, 'not a directory');
    await expect(
      openExistingDatabase(fixture.path, {
        migrationsFolder,
        migrationBackupDirectory: fixture.migrationBackupDirectory,
      })
    ).rejects.toThrow('Cannot preserve a verified migration backup');
    const unchanged = openDatabase(fixture.path);
    try {
      expect(await unchanged.db.all('select name from __drizzle_migrations')).toEqual([
        {name: legacyName},
      ]);
      expect(await unchanged.db.all('select firstName,homePhone from customers')).toEqual(
        [{firstName: 'Committed', homePhone: '555'}]
      );
    } finally {
      unchanged.close();
    }

    await rm(fixture.migrationBackupDirectory);
    const retry = await openExistingDatabase(fixture.path, {
      migrationsFolder,
      migrationBackupDirectory: fixture.migrationBackupDirectory,
    });
    retry.close();
  } finally {
    await rm(fixture.directory, {recursive: true, force: true});
  }
});

test('failed migration retains distinct verified snapshots on each explicit retry', async () => {
  const fixture = await legacyFixture();
  const {writeFile} = await import('node:fs/promises');
  try {
    const brokenFolder = join(fixture.directory, 'broken');
    await cp(migrationsFolder, brokenFolder, {recursive: true});
    const brokenMigration = join(brokenFolder, '20261008235959_failed');
    await mkdir(brokenMigration);
    await writeFile(
      join(brokenMigration, 'migration.sql'),
      'INSERT INTO missing_table VALUES(1);'
    );
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(
        openExistingDatabase(fixture.path, {
          migrationsFolder: brokenFolder,
          migrationBackupDirectory: fixture.migrationBackupDirectory,
        })
      ).rejects.toThrow('missing_table');
    }

    const [source] = await readdir(fixture.migrationBackupDirectory);
    const sourceDirectory = join(fixture.migrationBackupDirectory, source!);
    const attempts = await readdir(sourceDirectory);
    expect(attempts).toHaveLength(2);
    for (const attempt of attempts) {
      const backup = openDatabase(join(sourceDirectory, attempt, 'snapshot.db'));
      try {
        expect(await backup.db.all('select name from __drizzle_migrations')).toEqual([
          {name: legacyName},
        ]);
        expect(await backup.db.all('select firstName from customers')).toEqual([
          {firstName: 'Committed'},
        ]);
      } finally {
        backup.close();
      }
    }

    const unchanged = openDatabase(fixture.path);
    try {
      expect(await unchanged.db.all('select name from __drizzle_migrations')).toEqual([
        {name: legacyName},
      ]);
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(fixture.directory, {recursive: true, force: true});
  }
});

test('VACUUM snapshots committed WAL pages while retaining source ownership', async () => {
  const fixture = await legacyFixture();
  const handle = openDatabase(fixture.path);
  try {
    await handle.db.run(
      "insert into customers(customerNumber,firstName) values(2,'Journal-only')"
    );
    const snapshot = join(fixture.directory, 'journal-snapshot.db');
    await backupDatabase(handle.db, snapshot);
    const backup = openDatabase(snapshot);
    try {
      expect(await backup.db.all('select firstName from customers order by id')).toEqual([
        {firstName: 'Committed'},
        {firstName: 'Journal-only'},
      ]);
    } finally {
      backup.close();
    }
  } finally {
    handle.close();
    await rm(fixture.directory, {recursive: true, force: true});
  }
});

test('opening current data creates no backup and older application migration sets are rejected', async () => {
  const fixture = await legacyFixture();
  try {
    const upgraded = await openExistingDatabase(fixture.path, {
      migrationsFolder,
      migrationBackupDirectory: fixture.migrationBackupDirectory,
    });
    upgraded.close();
    await rm(fixture.migrationBackupDirectory, {recursive: true});
    const current = await openExistingDatabase(fixture.path, {
      migrationsFolder,
      migrationBackupDirectory: fixture.migrationBackupDirectory,
    });
    current.close();
    await expect(stat(fixture.migrationBackupDirectory)).rejects.toThrow('ENOENT');
    await expect(
      openExistingDatabase(fixture.path, {
        migrationsFolder: join(fixture.directory, 'legacy'),
        migrationBackupDirectory: fixture.migrationBackupDirectory,
      })
    ).rejects.toThrow('migration history does not match');
    await expect(stat(fixture.migrationBackupDirectory)).rejects.toThrow('ENOENT');
  } finally {
    await rm(fixture.directory, {recursive: true, force: true});
  }
});

test('failed snapshot fsync prevents migration even after snapshot validation', async () => {
  const fixture = await legacyFixture();
  try {
    faults.snapshotSync = true;
    await expect(
      openExistingDatabase(fixture.path, {
        migrationsFolder,
        migrationBackupDirectory: fixture.migrationBackupDirectory,
      })
    ).rejects.toThrow('snapshot fsync failed');
    faults.snapshotSync = false;
    const unchanged = openDatabase(fixture.path);
    try {
      expect(await unchanged.db.all('select name from __drizzle_migrations')).toEqual([
        {name: legacyName},
      ]);
      expect(await unchanged.db.all('select firstName,homePhone from customers')).toEqual(
        [{firstName: 'Committed', homePhone: '555'}]
      );
    } finally {
      unchanged.close();
    }

    const recovered = await openExistingDatabase(fixture.path, {
      migrationsFolder,
      migrationBackupDirectory: fixture.migrationBackupDirectory,
    });
    recovered.close();
  } finally {
    faults.snapshotSync = false;
    await rm(fixture.directory, {recursive: true, force: true});
  }
});
