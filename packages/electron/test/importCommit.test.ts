import {access, writeFile} from 'node:fs/promises';

import {openDatabase, listCustomers} from '@shop-things/db';
import {afterEach, expect, it, vi} from 'vitest';

import {DraftCoordinator} from '../src/draftCoordinator.js';
import {fixture, success, values} from './backendFixture.js';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
});
async function setup() {
  const f = await fixture();
  cleanup = f.cleanup;
  const session = success(await f.service.handlers['database.create']()).session!;
  return {
    ...f,
    session,
    async prepare(
      rows: ({id: number; customerNumber: number | string} & typeof values)[] = [
        {id: 1000, customerNumber: 9, ...values, firstName: 'First'},
        {id: 1001, customerNumber: 9, ...values, firstName: 'Second'},
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
      {id: 1000, customerNumber: 2, ...values},
      {id: 1001, customerNumber: 2, ...values, firstName: 'New'},
      {id: 1002, customerNumber: 0, ...values, firstName: 'Another'},
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
    added.every(row => row.reference.revision === '1' && row.customer.id < 1000)
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
    {id: 1000, customerNumber: 9, ...values},
    {id: 1001, customerNumber: 9, ...values},
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

it('rejects concurrent submissions with BUSY and permits a checked retry after cancellation', async () => {
  const f = await setup();
  const review = await f.prepare();
  const args = {session: f.session, importId: review.importId};
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
  expect(await f.list()).toEqual([]);
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
