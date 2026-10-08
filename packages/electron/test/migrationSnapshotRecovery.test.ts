import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {
  listMigrationSnapshots,
  openDatabase,
  openExistingDatabase,
  runMigrations,
} from '@shop-things/db';
import {expect, test} from 'vitest';

import {ActionService} from '../src/actionService.js';
import {DraftCoordinator} from '../src/draftCoordinator.js';
import type {DraftParticipant} from '../src/draftCoordinator.js';
import {fixture, migrationsFolder, success, values} from './backendFixture.js';

test('main-minted snapshot restoration preserves drafts through cancel/failure and commits a separate copy', async () => {
  const f = await fixture();
  const drafts = new DraftCoordinator();
  let draft = '';
  const participant: DraftParticipant = {
    documentId: 'snapshot-editor',
    prepare(request) {
      drafts.reply(participant, {...request, hasUnsavedDraft: Boolean(draft)});
    },
    resolve(resolution) {
      if (resolution.outcome === 'committed') {
        draft = '';
      }
    },
  };
  drafts.register(participant);
  const root = join(f.directory, 'migration-backups');
  const service = new ActionService({
    ...f.options,
    drafts,
    migrationBackupDirectory: root,
  });
  try {
    const active = success(await service.handlers['database.create']());
    success(
      await service.handlers['customers.create']({session: active.session!, values})
    );
    const legacyFolder = join(f.directory, 'legacy');
    await mkdir(legacyFolder);
    const name = '20260929093112_wealthy_hemingway';
    await cp(join(migrationsFolder, name), join(legacyFolder, name), {recursive: true});
    const source = join(f.directory, 'source.db');
    const legacy = openDatabase(source);
    await runMigrations(legacy.db, {migrationsFolder: legacyFolder});
    await legacy.db.run(
      "insert into customers(customerNumber,firstName) values(1,'Before update')"
    );
    legacy.close();
    const original = await openExistingDatabase(source, {
      migrationsFolder,
      migrationBackupDirectory: root,
    });
    await original.db.run("update customers set firstName='After update'");
    original.close();
    const listing = success(
      await service.handlers['database.listMigrationSnapshots']({})
    );
    expect(listing.snapshots).toHaveLength(1);
    const selected = listing.snapshots[0]!;
    expect(selected.sourcePath).toBe(source);
    expect(selected.snapshotId).not.toContain(source);
    expect(
      success(await service.handlers['database.listMigrationSnapshots']({}))
    ).toEqual(listing);
    expect(
      await service.handlers['database.restoreMigrationSnapshot']({
        snapshotId: '00000000-0000-4000-8000-000000000000',
      })
    ).toMatchObject({status: 'error', error: {code: 'VALIDATION'}});

    draft = 'Unsaved customer';
    f.choices.discard = false;
    expect(
      await service.handlers['database.restoreMigrationSnapshot']({
        snapshotId: selected.snapshotId,
      })
    ).toEqual({status: 'cancelled'});
    expect(draft).toBe('Unsaved customer');
    expect(service.status()).toEqual(active);
    f.choices.discard = true;
    f.choices.restoreDestination = null;
    expect(
      await service.handlers['database.restoreMigrationSnapshot']({
        snapshotId: selected.snapshotId,
      })
    ).toEqual({status: 'cancelled'});
    expect(draft).toBe('Unsaved customer');
    expect(service.status()).toEqual(active);

    const [snapshot] = (await listMigrationSnapshots(root)).snapshots;
    const before = await readFile(snapshot!.snapshotPath);
    await writeFile(snapshot!.snapshotPath, 'damaged snapshot');
    const destination = join(f.directory, 'recovered.db');
    f.choices.restoreDestination = destination;
    expect(
      await service.handlers['database.restoreMigrationSnapshot']({
        snapshotId: selected.snapshotId,
      })
    ).toMatchObject({status: 'error', error: {code: 'DATABASE_UNAVAILABLE'}});
    expect(service.status()).toEqual(active);
    expect(draft).toBe('Unsaved customer');
    await expect(readFile(destination)).rejects.toMatchObject({code: 'ENOENT'});
    await writeFile(snapshot!.snapshotPath, before);
    f.choices.restoreDestination = source;
    expect(
      await service.handlers['database.restoreMigrationSnapshot']({
        snapshotId: selected.snapshotId,
      })
    ).toMatchObject({status: 'error'});
    expect(service.status()).toEqual(active);
    expect(draft).toBe('Unsaved customer');

    f.choices.restoreDestination = destination;
    const restored = success(
      await service.handlers['database.restoreMigrationSnapshot']({
        snapshotId: selected.snapshotId,
      })
    );
    expect(restored.selectedPath).toBe(destination);
    expect(restored.session).not.toBe(active.session);
    expect(draft).toBe('');
    const customers = success(
      await service.handlers['customers.list']({session: restored.session!, query: ''})
    );
    expect(customers.map(row => row.customer.firstName)).toEqual(['Before update']);
    expect(await readFile(snapshot!.snapshotPath)).toEqual(before);
    expect(
      success(await service.handlers['database.listMigrationSnapshots']({})).snapshots
    ).toHaveLength(2);
    const retained = openDatabase(source);
    try {
      expect(await retained.db.all('select firstName from customers')).toEqual([
        {firstName: 'After update'},
      ]);
    } finally {
      retained.close();
    }
  } finally {
    service.closeUnprotected();
    await f.cleanup();
  }
});
