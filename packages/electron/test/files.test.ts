import {chmod, cp, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import type {DraftRequest, DraftResolution} from '@shop-things/contract';
import {openDatabase, openExistingDatabase, runMigrations} from '@shop-things/db';
import {expect, test} from 'vitest';

import {ActionService, databaseOperations} from '../src/actionService.js';
import {DraftCoordinator} from '../src/draftCoordinator.js';
import {fixture, migrationsFolder, success, values} from './backendFixture.js';

function protection() {
  const drafts = new DraftCoordinator();
  const editor = {draft: 'unsaved', selection: 1 as number | null, frozen: false};
  const participant = {
    documentId: 'files-document',
    prepare(request: DraftRequest) {
      editor.frozen = true;
      drafts.reply(participant, {...request, hasUnsavedDraft: true});
    },
    resolve(resolution: DraftResolution) {
      editor.frozen = false;
      if (resolution.outcome === 'committed') {
        editor.draft = '';
        editor.selection = null;
      }
    },
  };
  const unregister = drafts.register(participant);
  return {drafts, editor, unregister};
}

test('cancelled or failed file operations preserve active references and approved drafts', async () => {
  const participant = protection();
  const f = await fixture({drafts: participant.drafts});
  try {
    const state = success(await f.service.handlers['database.create']());
    const record = success(
      await f.service.handlers['customers.create']({session: state.session!, values})
    );
    f.choices.csv = null;
    f.choices.backup = null;
    expect(await f.service.handlers['exports.csv']({session: state.session!})).toEqual({
      status: 'cancelled',
    });
    expect(
      await f.service.handlers['database.backup']({session: state.session!})
    ).toEqual({
      status: 'cancelled',
    });
    f.choices.restoreSource = null;
    expect(await f.service.handlers['database.restore']()).toEqual({status: 'cancelled'});
    const source = join(f.directory, 'bad.db');
    await writeFile(source, 'not a database');
    f.choices.restoreSource = source;
    f.choices.restoreDestination = null;
    expect(await f.service.handlers['database.restore']()).toEqual({status: 'cancelled'});
    f.choices.restoreDestination = join(f.directory, 'failed-restore.db');
    expect(await f.service.handlers['database.restore']()).toMatchObject({
      status: 'error',
    });
    expect(await readFile(source, 'utf8')).toBe('not a database');
    await expect(readFile(f.choices.restoreDestination)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(f.service.status()).toEqual(state);
    expect(await f.settings.read()).toBe(state.selectedPath);
    expect(
      success(await f.service.handlers['customers.get']({session: state.session!, id: 1}))
    ).toEqual(record);
    expect(participant.editor).toMatchObject({
      draft: 'unsaved',
      selection: 1,
      frozen: false,
    });
    f.choices.backup = state.selectedPath;
    f.choices.csv = state.selectedPath;
    expect(
      await f.service.handlers['database.backup']({session: state.session!})
    ).toMatchObject({
      status: 'error',
    });
    expect(
      await f.service.handlers['exports.csv']({session: state.session!})
    ).toMatchObject({
      status: 'error',
    });
    expect(
      success(await f.service.handlers['customers.get']({session: state.session!, id: 1}))
    ).toEqual(record);
    expect((await readdir(f.directory)).filter(name => name.includes('.tmp'))).toEqual(
      []
    );
  } finally {
    participant.unregister();
    await f.cleanup();
  }
});

test('pending migration restore migrates only the separate writable copy of a read-only source', async () => {
  const participant = protection();
  const f = await fixture({drafts: participant.drafts});
  try {
    success(await f.service.handlers['database.create']());
    const source = join(f.directory, 'pending.db');
    const initialMigrations = join(f.directory, 'initial-migrations');
    await mkdir(initialMigrations);
    await cp(
      join(migrationsFolder, '20260929093112_wealthy_hemingway'),
      join(initialMigrations, '20260929093112_wealthy_hemingway'),
      {recursive: true}
    );
    const handle = openDatabase(source);
    try {
      await runMigrations(handle.db, {migrationsFolder: initialMigrations});
      await handle.db.run(
        "insert into customers (customerNumber,firstName,balance) values(7,'Pending',4.56)"
      );
    } finally {
      handle.close();
    }

    const original = await readFile(source);
    await chmod(source, 0o444);
    f.choices.restoreSource = source;
    const restored = success(await f.service.handlers['database.restore']());
    expect(await readFile(source)).toEqual(original);
    const record = success(
      await f.service.handlers['customers.get']({session: restored.session!, id: 1})
    );
    expect(record.customer).toMatchObject({
      firstName: 'Pending',
      customerNumber: 7,
      balance: '4.56',
    });
    const migrated = await openExistingDatabase(restored.selectedPath!, {
      migrationsFolder,
    });
    try {
      expect(
        await migrated.db.all('select name from __drizzle_migrations order by id')
      ).toHaveLength(2);
    } finally {
      migrated.close();
    }
  } finally {
    participant.unregister();
    await f.cleanup();
  }
});

test('injected native snapshot and remembered-path failures clean new files while preserving sources', async () => {
  const participant = protection();
  const f = await fixture({drafts: participant.drafts});
  let failSettings = false;
  const service = new ActionService({
    ...f.options,
    settings: {
      read: () => f.settings.read(),
      write: async path => {
        if (failSettings) {
          throw new Error('settings unavailable');
        }

        await f.settings.write(path);
      },
    },
    database: {
      ...databaseOperations,
      backupDatabase: async (...args) => {
        await databaseOperations.backupDatabase(...args);
        throw new Error('injected snapshot failure');
      },
    },
  });
  try {
    const state = success(await service.handlers['database.create']());
    const record = success(
      await service.handlers['customers.create']({session: state.session!, values})
    );
    expect(
      await service.handlers['database.backup']({session: state.session!})
    ).toMatchObject({
      status: 'error',
    });
    await expect(readFile(f.choices.backup!)).rejects.toMatchObject({code: 'ENOENT'});
    expect((await readdir(f.directory)).filter(name => name.includes('.tmp'))).toEqual(
      []
    );
    const original = await openExistingDatabase(state.selectedPath!, {migrationsFolder});
    try {
      await databaseOperations.backupDatabase(original.db, f.choices.backup!);
    } finally {
      original.close();
    }

    const backupBytes = await readFile(f.choices.backup!);
    failSettings = true;
    expect(await service.handlers['database.restore']()).toMatchObject({status: 'error'});
    expect(service.status()).toEqual(state);
    expect(await f.settings.read()).toBe(state.selectedPath);
    expect(await readFile(f.choices.backup!)).toEqual(backupBytes);
    await expect(readFile(f.choices.restoreDestination!)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(
      success(await service.handlers['customers.get']({session: state.session!, id: 1}))
    ).toEqual(record);
    expect(participant.editor).toMatchObject({
      draft: 'unsaved',
      selection: 1,
      frozen: false,
    });
  } finally {
    service.closeUnprotected();
    participant.unregister();
    await f.cleanup();
  }
});
