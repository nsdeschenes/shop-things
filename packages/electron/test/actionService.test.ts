import {chmod, cp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {createDatabase, openDatabase, runMigrations} from '@shop-things/db';
import {expect, test} from 'vitest';

import {ActionService, databaseOperations} from '../src/actionService.js';
import {DraftCoordinator} from '../src/draftCoordinator.js';
import type {DraftParticipant} from '../src/draftCoordinator.js';
import {fixture, migrationsFolder, success, values} from './backendFixture.js';

test('remembered missing file recovery never creates a replacement and Retry recovers', async () => {
  const f = await fixture();
  try {
    const remembered = join(f.directory, 'missing.db');
    await f.settings.write(remembered);
    await f.service.start();
    expect(f.service.status()).toMatchObject({
      available: false,
      selectedPath: remembered,
      session: null,
      recoveryError: {code: 'DATABASE_UNAVAILABLE'},
    });
    await expect(readFile(remembered)).rejects.toMatchObject({code: 'ENOENT'});
    const initialized = await createDatabase(remembered, {migrationsFolder});
    initialized.close();
    const recovered = success(await f.service.handlers['database.retry']());
    expect(recovered.available).toBe(true);
    expect(recovered.version).toBe(2);
    expect(recovered.recoveryError).toBeUndefined();
  } finally {
    await f.cleanup();
  }
});

test('cancelled selection, unsupported/read-only candidates and failed persistence keep state safe', async () => {
  const f = await fixture();
  try {
    f.choices.create = null;
    expect(await f.service.handlers['database.create']()).toEqual({status: 'cancelled'});
    const invalid = join(f.directory, 'unrelated.db');
    const handle = openDatabase(invalid);
    await handle.db.run('create table unrelated(id integer)');
    handle.close();
    f.choices.open = invalid;
    expect(await f.service.handlers['database.open']()).toMatchObject({
      status: 'error',
      error: {code: 'DATABASE_UNAVAILABLE'},
    });
    const valid = join(f.directory, 'valid.db');
    const recognized = await createDatabase(valid, {migrationsFolder});
    recognized.close();
    await chmod(valid, 0o444);
    f.choices.open = valid;
    expect(await f.service.handlers['database.open']()).toMatchObject({
      status: 'error',
      error: {message: expect.stringContaining('writable')},
    });
    await chmod(valid, 0o600);
    let candidateClosed = false;
    const failing = new ActionService({
      ...f.options,
      settings: {
        read: async () => null,
        write: async () => {
          throw new Error('secret settings path');
        },
      },
      database: {
        ...databaseOperations,
        openExistingDatabase: async (...args) => {
          const candidate = await databaseOperations.openExistingDatabase(...args);
          return {
            ...candidate,
            close: () => {
              candidateClosed = true;
              candidate.close();
            },
          };
        },
      },
    });
    expect(await failing.handlers['database.open']()).toMatchObject({
      status: 'error',
      error: {code: 'DATABASE_UNAVAILABLE'},
    });
    expect(candidateClosed).toBe(true);
    expect(failing.status().available).toBe(false);
    failing.closeUnprotected();
    expect(await f.settings.read()).toBeNull();
  } finally {
    await f.cleanup();
  }
});

test('one operation is admitted while status bypasses the gate and internal errors stay safe', async () => {
  const f = await fixture();
  let release!: () => void;
  let reached!: () => void;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const started = new Promise<void>(resolve => {
    reached = resolve;
  });
  const service = new ActionService({
    ...f.options,
    database: {
      ...databaseOperations,
      listCustomers: async (...args) => {
        reached();
        await pending;
        return databaseOperations.listCustomers(...args);
      },
      createCustomer: async () => {
        throw new Error('native secret stack');
      },
    },
  });
  try {
    const state = success(await service.handlers['database.create']());
    const call = service.handlers['customers.list']({session: state.session!, query: ''});
    await started;
    expect(
      await service.handlers['customers.create']({session: state.session!, values})
    ).toMatchObject({status: 'error', error: {code: 'BUSY'}});
    expect(success(await service.handlers['database.status']())).toEqual(state);
    release();
    expect(success(await call)).toEqual([]);
    expect(
      await service.handlers['customers.create']({session: state.session!, values})
    ).toEqual({
      status: 'error',
      error: {
        code: 'INTERNAL',
        message:
          'The operation failed. Check the file and folder permissions, then try again.',
      },
    });
  } finally {
    release();
    service.closeUnprotected();
    await f.cleanup();
  }
});

test('placeholder shutdown waits admitted work and closes once without renderer coordination', async () => {
  const f = await fixture();
  let release!: () => void;
  let reached!: () => void;
  let closed = 0;
  const pending = new Promise<void>(resolve => {
    release = resolve;
  });
  const entered = new Promise<void>(resolve => {
    reached = resolve;
  });
  const service = new ActionService({
    ...f.options,
    database: {
      ...databaseOperations,
      createDatabase: async (...args) => {
        const handle = await databaseOperations.createDatabase(...args);
        return {
          ...handle,
          close() {
            closed++;
            handle.close();
          },
        };
      },
      listCustomers: async (...args) => {
        reached();
        await pending;
        return databaseOperations.listCustomers(...args);
      },
    },
  });
  try {
    const state = success(await service.handlers['database.create']());
    const read = service.handlers['customers.list']({session: state.session!, query: ''});
    await entered;
    const closing = service.closeUnprotectedWhenIdle();
    expect(service.closeUnprotectedWhenIdle()).toBe(closing);
    expect(closed).toBe(0);
    expect(
      await service.handlers['customers.create']({session: state.session!, values})
    ).toMatchObject({error: {code: 'BUSY'}});
    release();
    expect(success(await read)).toEqual([]);
    await closing;
    expect(closed).toBe(1);
    expect(service.status()).toMatchObject({
      available: false,
      version: state.version + 1,
    });
  } finally {
    release();
    await service.closeUnprotectedWhenIdle();
    await f.cleanup();
  }
});

test.each([true, false])(
  'migration snapshot failure recovers startup=%s and retains an unaffected session',
  async startup => {
    const f = await fixture();
    const backupDirectory = join(f.directory, 'migration-backups');
    const drafts = new DraftCoordinator();
    const participant: DraftParticipant = {
      documentId: 'backup-test-document',
      prepare(request) {
        drafts.reply(participant, {...request, hasUnsavedDraft: false});
      },
      resolve() {},
    };
    drafts.register(participant);
    const service = new ActionService({
      ...f.options,
      drafts,
      migrationBackupDirectory: backupDirectory,
    });
    try {
      const legacyFolder = join(f.directory, 'legacy');
      await mkdir(legacyFolder);
      const name = '20260929093112_wealthy_hemingway';
      await cp(join(migrationsFolder, name), join(legacyFolder, name), {recursive: true});
      const candidatePath = join(f.directory, 'legacy.db');
      const legacy = openDatabase(candidatePath);
      await runMigrations(legacy.db, {migrationsFolder: legacyFolder});
      await legacy.db.run(
        "insert into customers(customerNumber,firstName) values(1,'Retained')"
      );
      legacy.close();
      await writeFile(backupDirectory, 'storage failure');
      let failure: unknown;
      let retainedState: unknown;
      if (startup) {
        await f.settings.write(candidatePath);
        await service.start();
        failure = {status: 'error', error: service.status().recoveryError};
        retainedState = service.status();
      } else {
        success(await service.handlers['database.create']());
        retainedState = service.status();
        f.choices.open = candidatePath;
        failure = await service.handlers['database.open']();
      }

      expect(failure).toMatchObject({
        status: 'error',
        error: {
          code: 'DATABASE_UNAVAILABLE',
          message: expect.stringContaining('verified migration backup'),
        },
      });
      expect(service.status()).toEqual(retainedState);
      expect(service.status().available).toBe(!startup);

      await rm(backupDirectory);
      f.choices.open = candidatePath;
      const recovered = success(
        await service.handlers[startup ? 'database.retry' : 'database.open']()
      );
      expect(recovered).toMatchObject({available: true, selectedPath: candidatePath});
    } finally {
      service.closeUnprotected();
      await f.cleanup();
    }
  }
);
