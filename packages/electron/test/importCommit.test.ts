import {access, cp, mkdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {
  openDatabase,
  runMigrations,
  listCustomers,
  type AppDatabase,
} from '@shop-things/db';
import {afterEach, expect, it, vi} from 'vitest';

import {databaseOperations, type ActionServiceOptions} from '../src/actionService.js';
import {DraftCoordinator} from '../src/draftCoordinator.js';
import {fixture, migrationsFolder, success, values} from './backendFixture.js';

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
});
async function setup(
  overrides: Partial<ActionServiceOptions> = {},
  initialize?: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>
) {
  const f = await fixture(overrides);
  cleanup = f.cleanup;
  await initialize?.(f);
  const session = success(
    await f.service.handlers[initialize ? 'database.open' : 'database.create']()
  ).session!;
  return {
    ...f,
    session,
    async prepare(
      rows: ({customerNumber: number | string; stock: number | string} & Omit<
        typeof values,
        'stock'
      >)[] = [
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
    await f.service.handlers['customers.create']({
      session: f.session,
      values: {...values, email: 'shared@example.test'},
    })
  );
  const initial = await f.prepare(
    [
      {customerNumber: 2, ...values, email: 'shared@example.test'},
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

it('imports into an opened legacy database using upgraded numbers for matches and allocation', async () => {
  const f = await setup({}, async fixture => {
    const legacyFolder = join(fixture.directory, 'legacy');
    await mkdir(legacyFolder);
    for (const name of [
      '20260929093112_wealthy_hemingway',
      '20260929120000_customer_integrity',
      '20261001005150_rename_home_phone',
    ]) {
      await cp(join(migrationsFolder, name), join(legacyFolder, name), {recursive: true});
    }

    fixture.choices.open = fixture.choices.create;
    const legacy = openDatabase(fixture.choices.open!);
    try {
      await runMigrations(legacy.db, {migrationsFolder: legacyFolder});
      await legacy.db.run(
        "INSERT INTO customers (customerNumber,firstName,email,phone,stock,balance,comments) VALUES (1,'Assigned one','','',1,12.34,'Keep one'),(NULL,'Backfilled two','shared@example.test','555-1234',2,23.45,'Keep two'),(3,'Assigned three','','',3,34.56,'Keep three'),(NULL,'Backfilled four','','',4,45.67,'Keep four')"
      );
    } finally {
      legacy.close();
    }
  });
  const existing = await f.list();
  expect(existing.map(row => [row.customer.id, row.customer.customerNumber])).toEqual([
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
  ]);
  expect(existing[1]?.customer).toMatchObject({
    firstName: 'Backfilled two',
    email: 'shared@example.test',
    phone: '555-1234',
    stock: 2,
    balance: '23.45',
    comments: 'Keep two',
  });
  const initial = await f.prepare([
    {customerNumber: '', ...values, email: 'shared@example.test'},
    {customerNumber: '', ...values, firstName: 'Blank'},
    {customerNumber: 3, ...values, firstName: 'Collision'},
    {customerNumber: 6, ...values, firstName: 'Reserved'},
  ]);
  expect(initial.rows[0]).toMatchObject({
    sourceCustomerNumber: null,
    assignedCustomerNumber: null,
    choice: 'unresolved',
  });
  expect(initial.matchGroups.flatMap(group => group.targets)).toContainEqual({
    kind: 'customer',
    id: 2,
    customerNumber: 2,
    firstName: 'Backfilled two',
    lastName: '',
  });
  const args = {session: f.session, importId: initial.importId};
  expect(await f.service.handlers['imports.commit'](args)).toMatchObject({
    status: 'error',
  });
  expect(await f.list()).toEqual(existing);
  const review = success(
    await f.service.handlers['imports.resolve']({
      ...args,
      recordNumber: 1,
      choice: 'skip',
    })
  );
  expect(review.rows.map(row => row.assignedCustomerNumber)).toEqual([null, 5, 7, 6]);
  expect(success(await f.service.handlers['imports.commit'](args))).toMatchObject({
    kind: 'committed',
    addedCount: 3,
    skippedCount: 1,
  });
  const saved = await f.list();
  expect(saved.filter(row => row.customer.id <= 4)).toEqual(existing);
  expect(saved.map(row => row.customer.customerNumber)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  const backup = openDatabase(f.choices.backup!);
  try {
    expect(await listCustomers(backup.db)).toEqual(
      existing.map(row => ({...row.customer, revision: row.reference.revision}))
    );
  } finally {
    backup.close();
  }
});

it.each([
  {amount: '', saved: '0.00'},
  {amount: '0', saved: '0.00'},
  {amount: '0.1', saved: '0.10'},
  {amount: '12', saved: '12.00'},
  {amount: '12.3', saved: '12.30'},
  {amount: '-12.3', saved: '-12.30'},
])('imports decimal balances: $amount', async ({amount, saved}) => {
  const f = await setup();
  const review = await f.prepare([
    {
      customerNumber: 9,
      ...values,
      balance: amount,
      previousBalance: amount,
    },
  ]);
  expect(review.status).toBe('ready');
  expect(review.diagnostics).toEqual([]);
  expect(
    success(
      await f.service.handlers['imports.commit']({
        session: f.session,
        importId: review.importId,
      })
    )
  ).toMatchObject({kind: 'committed', addedCount: 1});
  expect((await f.list())[0]?.customer).toMatchObject({
    balance: saved,
    previousBalance: saved,
  });
});

it('imports and saves empty stock as zero', async () => {
  const f = await setup();
  const review = await f.prepare([{customerNumber: 9, ...values, stock: ''}]);
  expect(review.status).toBe('ready');
  expect(review.diagnostics).toEqual([]);
  expect(review.rows[0]?.values.stock).toBe(0);
  expect(
    success(
      await f.service.handlers['imports.commit']({
        session: f.session,
        importId: review.importId,
      })
    )
  ).toMatchObject({kind: 'committed', addedCount: 1});
  expect((await f.list())[0]?.customer.stock).toBe(0);
});

it('imports reordered CSV balances and numeric donate', async () => {
  const f = await setup();
  await writeFile(
    f.choices.csv!,
    '"customerNumber","firstName","lastName","address","city","province","postalCode","phone","email","donate","stock","previousBalance","balance","comments"\n' +
      '"9","<firstName>","<lastName>","<address>","Exampleville","NS","<postalCode>","<phone>","<email>","0","0","25.83","25.93","Imported customer"'
  );
  const review = success(
    await f.service.handlers['imports.prepare']({session: f.session})
  );
  expect(review.status).toBe('ready');
  expect(review.diagnostics).toEqual([]);
  expect(review.rows[0]).toMatchObject({
    recordNumber: 1,
    sourceCustomerNumber: 9,
    values: {balance: '25.93', previousBalance: '25.83', donate: false},
  });
  expect(
    success(
      await f.service.handlers['imports.commit']({
        session: f.session,
        importId: review.importId,
      })
    )
  ).toMatchObject({kind: 'committed', addedCount: 1});
  expect((await f.list())[0]?.customer).toMatchObject({
    customerNumber: 9,
    balance: '25.93',
    previousBalance: '25.83',
    donate: false,
    comments: 'Imported customer',
  });
});

it('imports customers sharing first and last names with each other and a saved customer', async () => {
  const f = await setup();
  success(await f.service.handlers['customers.create']({session: f.session, values}));
  const review = await f.prepare([
    {customerNumber: 9, ...values},
    {customerNumber: 10, ...values},
  ]);
  expect(review.matchGroups).toEqual([]);
  expect(review).toMatchObject({
    includedCount: 2,
    unresolvedCount: 0,
    choicesResolved: true,
  });
  expect(
    success(
      await f.service.handlers['imports.commit']({
        session: f.session,
        importId: review.importId,
      })
    )
  ).toMatchObject({kind: 'committed', addedCount: 2});
  expect(
    (await f.list()).map(row => [row.customer.firstName, row.customer.lastName])
  ).toEqual([
    ['Anne', 'Smith'],
    ['Anne', 'Smith'],
    ['Anne', 'Smith'],
  ]);
});

it.each<{field: 'email' | 'phone'; shared: string; replacement: string}>([
  {field: 'email', shared: 'shared@example.test', replacement: 'new@example.test'},
  {field: 'phone', shared: '9025550100', replacement: '9025550199'},
])(
  'edits a matching $field, replans all affected rows, and saves the replacement',
  async ({field, shared, replacement}) => {
    const f = await setup();
    const saved = success(
      await f.service.handlers['customers.create']({
        session: f.session,
        values: {...values, [field]: shared},
      })
    );
    const initial = await f.prepare([
      {customerNumber: 9, ...values, [field]: shared},
      {customerNumber: 10, ...values, [field]: shared},
    ]);
    const args = {session: f.session, importId: initial.importId};
    const edited = success(
      await f.service.handlers['imports.resolve']({
        ...args,
        recordNumber: 1,
        field,
        value: replacement,
      })
    );
    expect(edited.rows[0]).toMatchObject({
      choice: 'unresolved',
      matches: [],
      values: {[field]: replacement},
    });
    expect(edited.rows[1]?.choice).toBe('unresolved');
    expect(edited.unresolvedCount).toBe(2);
    expect(await f.list()).toEqual([saved]);
    expect(success(await f.service.handlers['imports.review'](args))).toEqual(edited);
    success(
      await f.service.handlers['imports.resolve']({
        ...args,
        recordNumber: 2,
        field,
        value: '',
      })
    );
    expect(await f.service.handlers['imports.commit'](args)).toMatchObject({
      status: 'error',
      error: {code: 'VALIDATION'},
    });
    for (const recordNumber of [1, 2]) {
      success(
        await f.service.handlers['imports.resolve']({
          ...args,
          recordNumber,
          choice: 'add',
        })
      );
    }

    expect(success(await f.service.handlers['imports.commit'](args))).toMatchObject({
      kind: 'committed',
      addedCount: 2,
    });
    const customers = await f.list();
    expect(customers).toContainEqual(saved);
    expect(
      customers.find(item => item.customer.customerNumber === 9)?.customer[field]
    ).toBe(replacement);
    expect(
      customers.find(item => item.customer.customerNumber === 10)?.customer[field]
    ).toBe('');
  }
);

it.each(['add', 'skip'] as const)(
  'keeps the other CSV record pending until explicitly confirmed: %s',
  async choice => {
    const f = await setup();
    const contact = {...values, email: 'shared@example.test'};
    const initial = await f.prepare([
      {customerNumber: 9, ...contact},
      {customerNumber: 10, ...contact},
    ]);
    const args = {session: f.session, importId: initial.importId};
    const edited = success(
      await f.service.handlers['imports.resolve']({
        ...args,
        recordNumber: 1,
        field: 'email',
        value: 'new@example.test',
      })
    );
    expect(edited.matchGroups).toEqual([]);
    expect(edited.rows.map(row => row.collisionFields)).toEqual([['email'], ['email']]);
    expect(edited.rows[1]?.proposedCustomerNumber).toBe(10);
    expect(edited.rows.map(row => row.choice)).toEqual(['unresolved', 'unresolved']);
    expect(edited).toMatchObject({
      includedCount: 0,
      unresolvedCount: 2,
      choicesResolved: false,
    });
    const backup = vi.spyOn(f.options.dialogs, 'backupDatabase');
    expect(await f.service.handlers['imports.commit'](args)).toMatchObject({
      status: 'error',
      error: {code: 'VALIDATION'},
    });
    expect(backup).not.toHaveBeenCalled();
    expect(success(await f.service.handlers['imports.review'](args))).toEqual(edited);
    const corrected = success(
      await f.service.handlers['imports.resolve']({
        ...args,
        recordNumber: 2,
        field: 'email',
        value: 'corrected@example.test',
      })
    );
    expect(corrected.rows[1]).toMatchObject({
      collisionFields: ['email'],
      choice: 'unresolved',
      values: {email: 'corrected@example.test'},
    });
    success(
      await f.service.handlers['imports.resolve']({
        ...args,
        recordNumber: 1,
        choice: 'add',
      })
    );
    const confirmed = success(
      await f.service.handlers['imports.resolve']({...args, recordNumber: 2, choice})
    );
    expect(confirmed.choicesResolved).toBe(true);
    expect(confirmed.rows[1]?.proposedCustomerNumber).toBeUndefined();
    expect(success(await f.service.handlers['imports.commit'](args))).toMatchObject({
      kind: 'committed',
      addedCount: choice === 'add' ? 2 : 1,
    });
    expect(
      (await f.list()).find(row => row.customer.customerNumber === 9)?.customer.email
    ).toBe('new@example.test');
  }
);

it('previews a replacement number when the pending record number is already saved', async () => {
  const f = await setup();
  success(await f.service.handlers['customers.create']({session: f.session, values}));
  const contact = {...values, email: 'shared@example.test'};
  const initial = await f.prepare([
    {customerNumber: 9, ...contact},
    {customerNumber: 1, ...contact},
  ]);
  const args = {session: f.session, importId: initial.importId};
  const edited = success(
    await f.service.handlers['imports.resolve']({
      ...args,
      recordNumber: 1,
      field: 'email',
      value: 'new@example.test',
    })
  );
  expect(edited.rows[1]).toMatchObject({
    sourceCustomerNumber: 1,
    assignedCustomerNumber: null,
    proposedCustomerNumber: 2,
    choice: 'unresolved',
  });
  const confirmed = success(
    await f.service.handlers['imports.resolve']({...args, recordNumber: 2, choice: 'add'})
  );
  expect(confirmed.rows[1]?.assignedCustomerNumber).toBe(2);
});

it('keeps unresolved contact matches until each replacement is different', async () => {
  const f = await setup();
  const contact = {...values, email: 'shared@example.test', phone: '9025550100'};
  success(
    await f.service.handlers['customers.create']({session: f.session, values: contact})
  );
  const initial = await f.prepare([{customerNumber: 9, ...contact}]);
  const args = {session: f.session, importId: initial.importId, recordNumber: 1};
  const equivalent = success(
    await f.service.handlers['imports.resolve']({
      ...args,
      field: 'email',
      value: ' SHARED@EXAMPLE.TEST ',
    })
  );
  expect(equivalent.rows[0]?.matches).toHaveLength(2);
  expect(equivalent.choicesResolved).toBe(false);
  const emailChanged = success(
    await f.service.handlers['imports.resolve']({
      ...args,
      field: 'email',
      value: 'new@example.test',
    })
  );
  expect(emailChanged.matchGroups.map(group => group.reason)).toEqual(['phone']);
  expect(emailChanged.rows[0]?.choice).toBe('unresolved');
  const resolved = success(
    await f.service.handlers['imports.resolve']({
      ...args,
      field: 'phone',
      value: '9025550199',
    })
  );
  expect(resolved).toMatchObject({
    choicesResolved: false,
    unresolvedCount: 1,
    includedCount: 0,
  });
});

it('fails closed for unresolved reviews before opening backup', async () => {
  const f = await setup();
  const backup = vi.spyOn(f.options.dialogs, 'backupDatabase');
  const review = await f.prepare([
    {customerNumber: 9, ...values, email: 'shared@example.test'},
    {customerNumber: 9, ...values, email: 'shared@example.test'},
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
  success(
    await f.service.handlers['customers.create']({
      session: f.session,
      values: {...values, email: 'shared@example.test'},
    })
  );
  const initial = await f.prepare([
    {customerNumber: 9, ...values, email: 'shared@example.test'},
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
  const review = await f.prepare([
    {customerNumber: 9, ...values, email: 'shared@example.test'},
    {customerNumber: 10, ...values, firstName: 'Second'},
  ]);
  success(
    await f.service.handlers['customers.create']({
      session: f.session,
      values: {...values, firstName: 'First', email: 'shared@example.test'},
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
    success(
      await f.service.handlers['customers.create']({
        session: f.session,
        values: {...values, email: 'shared@example.test'},
      })
    );
    success(
      await f.service.handlers['customers.create']({
        session: f.session,
        values: {...values, firstName: 'Other', email: 'other@example.test'},
      })
    );
    const initial = await f.prepare([
      {customerNumber: 9, ...values, email: 'shared@example.test'},
      {customerNumber: 10, ...values, firstName: 'Other', email: 'other@example.test'},
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
        "INSERT INTO customers (customerNumber,firstName,lastName,email) VALUES (9,'Anne','Smith','shared@example.test')"
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
  success(
    await f.service.handlers['customers.create']({
      session: f.session,
      values: {...values, email: 'shared@example.test'},
    })
  );
  const initial = await f.prepare([
    {customerNumber: 9, ...values, email: 'shared@example.test'},
  ]);
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
  success(
    await f.service.handlers['customers.create']({
      session: f.session,
      values: {...values, email: 'shared@example.test'},
    })
  );
  const initial = await f.prepare([
    {customerNumber: 9, ...values, email: 'shared@example.test'},
  ]);
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
