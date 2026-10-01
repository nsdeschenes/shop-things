import {access, writeFile} from 'node:fs/promises';

import {openDatabase, listCustomers, type AppDatabase} from '@shop-things/db';
import {afterEach, expect, it, vi} from 'vitest';

import {databaseOperations, type ActionServiceOptions} from '../src/actionService.js';
import {DraftCoordinator} from '../src/draftCoordinator.js';
import {fixture, success, values} from './backendFixture.js';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
});
async function setup(overrides: Partial<ActionServiceOptions> = {}) {
  const f = await fixture(overrides);
  cleanup = f.cleanup;
  const session = success(await f.service.handlers['database.create']()).session!;
  return {
    ...f,
    session,
    async prepare(
      rows: ({customerNumber: number | string} & typeof values)[] = [
        {customerNumber: 9, ...values, firstName: 'First'},
        {customerNumber: 9, ...values, firstName: 'Second'},
      ]
    ) {
      const header = Object.keys(rows[0]!);
      function quote(v: unknown) {
        return `"${String(v).replaceAll('"', '""')}"`;
      }

      await writeFile(
        f.choices.csv!,
        [
          header.join(','),
          ...rows.map(row => header.map(key => quote(Reflect.get(row, key))).join(',')),
        ].join('\n')
      );
      return success(await f.service.handlers['imports.prepare']({session}));
    },
    async list() {
      return success(await f.service.handlers['customers.list']({session, query: ''}));
    },
  };
}

it('adds included rows with planned numbers, fresh IDs/revisions, and preserves saved customers and backup', async () => {
  const f = await setup();
  const existing = success(
    await f.service.handlers['customers.create']({session: f.session, values})
  );
  const initial = await f.prepare(
    [
      {customerNumber: 2, ...values},
      {customerNumber: 2, ...values, firstName: 'New'},
      {customerNumber: 0, ...values, firstName: 'Another'},
    ].map(row => ({...row, customerNumber: row.customerNumber || ''}))
  );
  const args = {session: f.session, importId: initial.importId};
  const review = success(
    await f.service.handlers['imports.resolve']({
      ...args,
      recordNumber: 1,
      choice: 'skip',
    })
  );
  expect(review.rows.map(row => row.assignedCustomerNumber)).toEqual([null, 2, 3]);
  expect(success(await f.service.handlers['imports.commit'](args))).toEqual({
    kind: 'committed',
    session: f.session,
    addedCount: 2,
    skippedCount: 1,
  });
  const saved = await f.list();
  expect(saved).toContainEqual(existing);
  const added = saved.filter(row => row.customer.id !== existing.customer.id);
  expect(added.map(row => row.customer.customerNumber).sort((a, b) => a! - b!)).toEqual([
    2, 3,
  ]);
  expect(
    added.every(
      row => row.reference.revision === '1' && row.customer.id > existing.customer.id
    )
  ).toBe(true);
  const backup = openDatabase(f.choices.backup!);
  try {
    expect(await listCustomers(backup.db)).toHaveLength(1);
  } finally {
    backup.close();
  }

  expect(await f.service.handlers['imports.commit'](args)).toMatchObject({
    status: 'error',
    error: {code: 'STALE_SESSION'},
  });
  expect(await f.list()).toHaveLength(3);
});

it('fails closed for unresolved reviews before opening backup', async () => {
  const f = await setup();
  const backup = vi.spyOn(f.options.dialogs, 'backupDatabase');
  const review = await f.prepare([
    {customerNumber: 9, ...values},
    {customerNumber: 9, ...values},
  ]);
  expect(
    await f.service.handlers['imports.commit']({
      session: f.session,
      importId: review.importId,
    })
  ).toMatchObject({status: 'error', error: {code: 'VALIDATION'}});
  expect(backup).not.toHaveBeenCalled();
  expect(await f.list()).toEqual([]);
});

it('retains review after backup cancellation and failure; every retry backs up again', async () => {
  const f = await setup();
  const review = await f.prepare();
  const args = {session: f.session, importId: review.importId};
  const backupPath = f.choices.backup!;
  const dialog = vi.spyOn(f.options.dialogs, 'backupDatabase');
  f.choices.backup = null;
  expect(await f.service.handlers['imports.commit'](args)).toEqual({status: 'cancelled'});
  await writeFile(backupPath, 'do not overwrite');
  f.choices.backup = backupPath;
  expect(await f.service.handlers['imports.commit'](args)).toMatchObject({
    status: 'error',
  });
  expect(await f.list()).toEqual([]);
  expect(success(await f.service.handlers['imports.review'](args))).toEqual(review);
  f.choices.backup = backupPath + '.retry';
  expect(success(await f.service.handlers['imports.commit'](args))).toMatchObject({
    kind: 'committed',
    addedCount: 2,
  });
  expect(dialog).toHaveBeenCalledTimes(3);
});

it('rejects concurrent submissions with BUSY and retains choices for a checked retry after cancellation', async () => {
  const f = await setup();
  success(await f.service.handlers['customers.create']({session: f.session, values}));
  const initial = await f.prepare([
    {customerNumber: 9, ...values},
    {customerNumber: 10, ...values, firstName: 'Second'},
  ]);
  const args = {session: f.session, importId: initial.importId};
  const review = success(
    await f.service.handlers['imports.resolve']({...args, recordNumber: 1, choice: 'add'})
  );
  let release!: (path: string | null) => void;
  const held = new Promise<string | null>(resolve => {
    release = resolve;
  });
  const dialog = vi.spyOn(f.options.dialogs, 'backupDatabase').mockReturnValueOnce(held);
  const first = f.service.handlers['imports.commit'](args);
  await vi.waitFor(() => expect(dialog).toHaveBeenCalledOnce());
  expect(await f.service.handlers['imports.commit'](args)).toMatchObject({
    status: 'error',
    error: {code: 'BUSY'},
  });
  release(null);
  expect(await first).toEqual({status: 'cancelled'});
  expect(success(await f.service.handlers['imports.review'](args))).toEqual(review);
  expect(await f.list()).toHaveLength(1);
  expect(success(await f.service.handlers['imports.commit'](args))).toMatchObject({
    kind: 'committed',
    addedCount: 2,
  });
});

it.each([false, true])(
  'rejects changed numbering before writing, including changes during backup: %s',
  async duringBackup => {
    const f = await setup();
    const review = await f.prepare();
    const args = {session: f.session, importId: review.importId};
    const external = openDatabase(f.choices.create!);
    async function change() {
      await external.db.run(
        "INSERT INTO customers (customerNumber,firstName) VALUES (9,'External')"
      );
    }

    const dialog = vi.spyOn(f.options.dialogs, 'backupDatabase');
    if (duringBackup) {
      dialog.mockImplementationOnce(async () => {
        await change();
        return f.choices.backup;
      });
    } else {
      await change();
    }

    try {
      const result = success(await f.service.handlers['imports.commit'](args));
      expect(result.kind).toBe('changed');
      if (result.kind !== 'changed') {
        throw new Error('Expected a revised plan');
      }

      expect(result.review.rows.map(row => row.assignedCustomerNumber)).toEqual([1, 2]);
      expect(await f.list()).toHaveLength(1);
      expect(dialog).toHaveBeenCalledTimes(duringBackup ? 1 : 0);
      f.choices.backup += '.renewed';
      expect(success(await f.service.handlers['imports.commit'](args))).toMatchObject({
        kind: 'committed',
        addedCount: 2,
      });
      expect(dialog).toHaveBeenCalledTimes(duringBackup ? 2 : 1);
      expect(
        (await f.list()).map(row => row.customer.customerNumber).sort((a, b) => a! - b!)
      ).toEqual([1, 2, 9]);
    } finally {
      external.close();
    }
  }
);

it('rejects newly matching saved customers without silently adding an unresolved row', async () => {
  const f = await setup();
  const review = await f.prepare();
  success(
    await f.service.handlers['customers.create']({
      session: f.session,
      values: {...values, firstName: 'First'},
    })
  );
  const dialog = vi.spyOn(f.options.dialogs, 'backupDatabase');
  const result = success(
    await f.service.handlers['imports.commit']({
      session: f.session,
      importId: review.importId,
    })
  );
  if (result.kind !== 'changed') {
    throw new Error('Expected a revised review');
  }

  expect(result.review).toMatchObject({choicesResolved: false, unresolvedCount: 1});
  expect(result.review.rows[0]?.choice).toBe('unresolved');
  expect(await f.list()).toHaveLength(1);
  expect(dialog).not.toHaveBeenCalled();
});

it('rolls back a later insert failure, keeps the successful backup, and retries the retained review', async () => {
  const f = await setup();
  const review = await f.prepare();
  const args = {session: f.session, importId: review.importId};
  const external = openDatabase(f.choices.create!);
  try {
    await external.db.run(
      "CREATE TRIGGER reject_import BEFORE INSERT ON customers WHEN NEW.firstName='Second' BEGIN SELECT RAISE(ABORT,'reject import'); END"
    );
    expect(await f.service.handlers['imports.commit'](args)).toMatchObject({
      status: 'error',
    });
    expect(await f.list()).toEqual([]);
    await expect(access(f.choices.backup!)).resolves.toBeUndefined();
    expect(success(await f.service.handlers['imports.review'](args))).toEqual(review);
    await external.db.run('DROP TRIGGER reject_import');
    f.choices.backup += '.retry';
    expect(success(await f.service.handlers['imports.commit'](args))).toMatchObject({
      kind: 'committed',
      addedCount: 2,
    });
  } finally {
    external.close();
  }
});

it('expires a review when reopening the same destination under a new session', async () => {
  const f = await setup();
  const review = await f.prepare();
  f.choices.open = f.choices.create;
  const drafts = new DraftCoordinator();
  const participant = {
    documentId: 'test',
    prepare(request: Parameters<typeof drafts.reply>[1]) {
      drafts.reply(participant, {...Object(request), hasUnsavedDraft: false});
    },
    resolve() {},
  };
  drafts.register(participant);
  f.options.drafts = drafts;
  success(await f.service.handlers['database.open']());
  expect(
    await f.service.handlers['imports.commit']({
      session: f.session,
      importId: review.importId,
    })
  ).toMatchObject({status: 'error', error: {code: 'STALE_SESSION'}});
});

it.each([false, true])(
  'retains unaffected choices and requires fresh choices for changed targets before/during backup: %s',
  async duringBackup => {
    const f = await setup();
    success(await f.service.handlers['customers.create']({session: f.session, values}));
    success(
      await f.service.handlers['customers.create']({
        session: f.session,
        values: {...values, firstName: 'Other'},
      })
    );
    const initial = await f.prepare([
      {customerNumber: 9, ...values},
      {customerNumber: 10, ...values, firstName: 'Other'},
    ]);
    const args = {session: f.session, importId: initial.importId};
    success(
      await f.service.handlers['imports.resolve']({
        ...args,
        recordNumber: 1,
        choice: 'add',
      })
    );
    success(
      await f.service.handlers['imports.resolve']({
        ...args,
        recordNumber: 2,
        choice: 'skip',
      })
    );
    const external = openDatabase(f.choices.create!);
    const dialog = vi.spyOn(f.options.dialogs, 'backupDatabase');
    async function change() {
      await external.db.run(
        "INSERT INTO customers (customerNumber,firstName,lastName) VALUES (9,'Anne','Smith')"
      );
    }

    try {
      if (duringBackup) {
        dialog.mockImplementationOnce(async () => {
          await change();
          return f.choices.backup;
        });
      } else {
        await change();
      }

      const revised = success(await f.service.handlers['imports.commit'](args));
      if (revised.kind !== 'changed') {
        throw new Error('Expected changed review');
      }

      expect(revised.review.rows.map(row => row.choice)).toEqual(['unresolved', 'skip']);
      expect(revised.review).toMatchObject({
        includedCount: 0,
        skippedCount: 1,
        unresolvedCount: 1,
      });
      expect(await f.list()).toHaveLength(3);
      expect(await f.service.handlers['imports.commit'](args)).toMatchObject({
        status: 'error',
        error: {code: 'VALIDATION'},
      });
      const resolved = success(
        await f.service.handlers['imports.resolve']({
          ...args,
          recordNumber: 1,
          choice: 'add',
        })
      );
      expect(resolved.rows.map(row => row.assignedCustomerNumber)).toEqual([3, null]);
      f.choices.backup += '.renewed';
      expect(success(await f.service.handlers['imports.commit'](args))).toMatchObject({
        kind: 'committed',
        addedCount: 1,
        skippedCount: 1,
      });
      expect(dialog).toHaveBeenCalledTimes(duringBackup ? 2 : 1);
    } finally {
      external.close();
    }
  }
);

it('retains choices through temporary destination unavailability and retries in the same session', async () => {
  let destination!: AppDatabase;
  const f = await setup({
    database: {
      ...databaseOperations,
      listCustomers: async db => {
        destination = db;
        return listCustomers(db);
      },
    },
  });
  success(await f.service.handlers['customers.create']({session: f.session, values}));
  const initial = await f.prepare([{customerNumber: 9, ...values}]);
  const args = {session: f.session, importId: initial.importId};
  const review = success(
    await f.service.handlers['imports.resolve']({...args, recordNumber: 1, choice: 'add'})
  );
  const dialog = vi.spyOn(f.options.dialogs, 'backupDatabase');
  await destination.run('PRAGMA query_only = 1');
  expect(await f.service.handlers['imports.commit'](args)).toMatchObject({
    status: 'error',
  });
  expect(success(await f.service.handlers['imports.review'](args))).toEqual(review);
  expect(await f.list()).toHaveLength(1);
  await destination.run('PRAGMA query_only = 0');
  f.choices.backup = f.directory + '/recovered.db';
  expect(success(await f.service.handlers['imports.commit'](args))).toMatchObject({
    kind: 'committed',
    addedCount: 1,
  });
  expect(dialog).toHaveBeenCalledTimes(2);
});

it('keeps choices when match target identities remain unchanged while display details and numbering change', async () => {
  const f = await setup();
  success(await f.service.handlers['customers.create']({session: f.session, values}));
  const initial = await f.prepare([{customerNumber: 9, ...values}]);
  const args = {session: f.session, importId: initial.importId};
  success(
    await f.service.handlers['imports.resolve']({...args, recordNumber: 1, choice: 'add'})
  );
  const external = openDatabase(f.choices.create!);
  try {
    await external.db.run('UPDATE customers SET customerNumber=9');
    const result = success(await f.service.handlers['imports.commit'](args));
    if (result.kind !== 'changed') {
      throw new Error('Expected revised plan');
    }

    expect(result.review.rows[0]).toMatchObject({
      choice: 'add',
      assignedCustomerNumber: 1,
    });
    expect(result.review.choicesResolved).toBe(true);
    expect(result.review.matchGroups[0]?.targets).toContainEqual({
      kind: 'customer',
      id: 1,
      customerNumber: 9,
      firstName: 'Anne',
      lastName: 'Smith',
    });
    expect(await f.list()).toHaveLength(1);
  } finally {
    external.close();
  }
});
