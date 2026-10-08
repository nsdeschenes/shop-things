import {cp, mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  listMigrationSnapshots,
  openDatabase,
  openExistingDatabase,
  restoreMigrationSnapshot,
  runMigrations,
} from '@shop-things/db';
import {expect, test} from 'vitest';

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const legacyName = '20260929093112_wealthy_hemingway';

test('a retained snapshot restores validated pre-migration data into a separate copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'snapshot-recovery-'));
  try {
    const source = join(directory, 'source.db');
    const legacyFolder = join(directory, 'legacy');
    await mkdir(legacyFolder);
    await cp(join(migrationsFolder, legacyName), join(legacyFolder, legacyName), {
      recursive: true,
    });
    const legacy = openDatabase(source);
    await runMigrations(legacy.db, {migrationsFolder: legacyFolder});
    await legacy.db.run(
      "insert into customers(customerNumber,firstName) values(1,'Before update')"
    );
    legacy.close();
    const root = join(directory, 'backups');
    const current = await openExistingDatabase(source, {
      migrationsFolder,
      migrationBackupDirectory: root,
    });
    await current.db.run("update customers set firstName='After update'");
    current.close();
    const {snapshots, unavailableCount} = await listMigrationSnapshots(root);
    expect(unavailableCount).toBe(0);
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0]!;
    expect(snapshot.canonicalSource).toBe(source);
    expect(snapshot.sourceHistory.map(row => row.name)).toEqual([legacyName]);
    const before = await readFile(snapshot.snapshotPath);
    const destination = join(directory, 'restored.db');
    await restoreMigrationSnapshot(snapshot, destination);
    const restored = await openExistingDatabase(destination, {
      migrationsFolder,
      migrationBackupDirectory: root,
    });
    try {
      expect(await restored.db.all('select firstName from customers')).toEqual([
        {firstName: 'Before update'},
      ]);
    } finally {
      restored.close();
    }

    expect(await readFile(snapshot.snapshotPath)).toEqual(before);
    expect((await listMigrationSnapshots(root)).snapshots).toHaveLength(2);
    const original = openDatabase(source);
    try {
      expect(await original.db.all('select firstName from customers')).toEqual([
        {firstName: 'After update'},
      ]);
    } finally {
      original.close();
    }

    await expect(restoreMigrationSnapshot(snapshot, source)).rejects.toThrow();
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('future snapshot history is visible but an older recovery app rejects it without altering the snapshot', async () => {
  const {createHash, randomUUID} = await import('node:crypto');
  const {writeFile} = await import('node:fs/promises');
  function digest(value: unknown) {
    return createHash('sha256').update(JSON.stringify(value)).digest('hex');
  }

  const directory = await mkdtemp(join(tmpdir(), 'future-snapshot-'));
  try {
    const source = join(directory, 'newer.db');
    const handle = openDatabase(source);
    await runMigrations(handle.db, {migrationsFolder});
    await handle.db.run(
      "insert into __drizzle_migrations(hash,name,created_at) values('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa','20261009000000_future',1791504000000)"
    );
    const sourceHistory = await handle.db.all<{name: string; hash: string}>(
      'select name,hash from __drizzle_migrations order by id'
    );
    handle.close();
    const root = join(directory, 'backups');
    const attempt = `${Date.now()}-${randomUUID()}`;
    const saved = join(root, digest(source), attempt);
    await mkdir(saved, {recursive: true, mode: 0o700});
    const snapshotPath = join(saved, 'snapshot.db');
    await cp(source, snapshotPath);
    const bytes = await readFile(snapshotPath);
    await writeFile(
      join(saved, 'metadata.json'),
      JSON.stringify({
        schemaVersion: 1,
        attempt,
        canonicalSource: source,
        sourceIdentity: {device: 1, inode: 2},
        sourceHistory,
        targetMigrations: sourceHistory,
        sourceHistoryDigest: digest(sourceHistory),
        targetHistoryDigest: digest(sourceHistory),
        snapshotPath,
        snapshotDigest: createHash('sha256').update(bytes).digest('hex'),
      })
    );
    const listing = await listMigrationSnapshots(root);
    expect(listing.snapshots).toHaveLength(1);
    const destination = join(directory, 'restored.db');
    await expect(
      restoreMigrationSnapshot(listing.snapshots[0]!, destination)
    ).rejects.toThrow('supported schema');
    await expect(readFile(destination)).rejects.toMatchObject({code: 'ENOENT'});
    expect(await readFile(snapshotPath)).toEqual(bytes);
    const corruptBytes = Buffer.from('not a database');
    await writeFile(snapshotPath, corruptBytes);
    const corruptMetadata = JSON.parse(
      await readFile(join(saved, 'metadata.json'), 'utf8')
    );
    corruptMetadata.snapshotDigest = createHash('sha256')
      .update(corruptBytes)
      .digest('hex');
    await writeFile(join(saved, 'metadata.json'), JSON.stringify(corruptMetadata));
    const corruptListing = await listMigrationSnapshots(root);
    await expect(
      restoreMigrationSnapshot(corruptListing.snapshots[0]!, destination)
    ).rejects.toThrow('validated copy');
    await expect(readFile(destination)).rejects.toMatchObject({code: 'ENOENT'});
    expect(await readFile(snapshotPath)).toEqual(corruptBytes);
    expect(await readFile(source)).toEqual(bytes);
    await writeFile(join(saved, 'metadata.json'), '{damaged');
    expect(await listMigrationSnapshots(root)).toEqual({
      snapshots: [],
      unavailableCount: 1,
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
