import {expect, test} from 'vitest';

import createPreviewClient, {setPreviewOutcome} from './preview';
import {getPreviewBackup, recordPreviewBackup} from './previewFiles';

test('temporary canonical records normalize decimal strings and retain opaque revision checks', async () => {
  const client = createPreviewClient();
  const status = await client.database.status();
  if (status.status !== 'success' || !status.value.session) {
    throw new Error('Missing preview session');
  }

  const session = status.value.session;
  const values = {
    firstName: 'Temporary',
    lastName: '',
    address: '',
    city: '',
    province: '',
    postalCode: '',
    homePhone: '',
    email: '',
    stock: 0,
    balance: '-0001.2',
    previousBalance: '000.0',
    donate: false,
    comments: '',
  };
  const created = await client.customers.create({session, values});
  expect(created).toMatchObject({
    status: 'success',
    value: {
      customer: {id: 1, customerNumber: 1, balance: '-1.20', previousBalance: '0.00'},
    },
  });
  if (created.status !== 'success') {
    throw new Error('Preview create failed');
  }

  const loaded = await client.customers.get({session, id: 1});
  if (loaded.status !== 'success') {
    throw new Error('Preview get failed');
  }

  const originalRevision = loaded.value.reference.revision;
  const saved = await client.customers.update({
    reference: created.value.reference,
    changes: {firstName: 'Updated'},
  });
  if (saved.status !== 'success') {
    throw new Error('Preview update failed');
  }

  expect(loaded.value.reference.revision).toBe(originalRevision);
  expect(loaded.value.customer.firstName).toBe('Temporary');
  expect(
    await client.customers.update({
      reference: loaded.value.reference,
      changes: {firstName: 'Stale'},
    })
  ).toMatchObject({status: 'error', error: {code: 'STALE_REVISION'}});
  expect(await client.customers.list({session, query: '1'})).toMatchObject({
    status: 'success',
    value: [{customer: {id: 1}}],
  });
  expect(saved.value.reference.revision).not.toBe(created.value.reference.revision);
  expect(
    await client.customers.delete({reference: created.value.reference})
  ).toMatchObject({status: 'error', error: {code: 'STALE_REVISION'}});
  expect(await client.customers.delete({reference: saved.value.reference})).toEqual({
    status: 'success',
    value: {deleted: true},
  });
  expect(await client.customers.create({session, values})).toMatchObject({
    status: 'success',
    value: {customer: {customerNumber: 1}},
  });
  expect(await client.customers.get({session, id: 1})).toMatchObject({
    status: 'error',
    error: {code: 'CUSTOMER_DELETED'},
  });
});

test('preview transitions clone state, correlate abort/commit and preserve a cancelled snapshot', async () => {
  const client = createPreviewClient();
  const before = await client.database.status();
  if (before.status !== 'success') {
    throw new Error('No preview');
  }

  const resolutions: string[] = [];
  client.drafts.registerProtection({
    prepare: async request => ({...request, hasUnsavedDraft: false}),
    resolve: resolution => {
      resolutions.push(resolution.outcome);
    },
  });
  setPreviewOutcome(client, 'cancelled');
  expect(await client.database.open()).toEqual({status: 'cancelled'});
  expect(await client.database.status()).toEqual(before);
  setPreviewOutcome(client, 'success');
  const opened = await client.database.open();
  expect(opened.status).toBe('success');
  expect(before.value.version).toBe(1);
  expect(resolutions).toEqual(['aborted', 'committed']);
  if (opened.status !== 'success') {
    throw new Error('Transition failed');
  }

  expect(opened.value.session).not.toBe(before.value.session);
});

test('Restore clones a saved preview backup into a fresh session only after protected commit', async () => {
  const values = {
    firstName: 'Temporary',
    lastName: '',
    address: '',
    city: '',
    province: '',
    postalCode: '',
    homePhone: '',
    email: '',
    stock: 0,
    balance: '0.00',
    previousBalance: '0.00',
    donate: false,
    comments: '',
  };
  const client = createPreviewClient(async () => true);
  let dirty = false;
  const resolutions: string[] = [];
  client.drafts.registerProtection({
    prepare: async request => ({...request, hasUnsavedDraft: dirty}),
    resolve: resolution => {
      resolutions.push(resolution.outcome);
    },
  });
  const state = await client.database.status();
  if (state.status !== 'success' || !state.value.session) {
    throw new Error('Missing state');
  }

  const created = await client.customers.create({
    session: state.value.session,
    values: {...values, firstName: 'Backup saved'},
  });
  if (created.status !== 'success') {
    throw new Error('Create failed');
  }

  recordPreviewBackup(client, {customers: [created.value], nextId: 2});
  await client.customers.update({
    reference: created.value.reference,
    changes: {firstName: 'Changed after backup'},
  });
  dirty = true;
  setPreviewOutcome(client, 'cancelled');
  expect((await client.database.restore()).status).toBe('cancelled');
  expect(await client.database.status()).toEqual(state);
  setPreviewOutcome(client, 'error');
  expect((await client.database.restore()).status).toBe('error');
  expect(await client.database.status()).toEqual(state);
  setPreviewOutcome(client, 'success');
  const restored = await client.database.restore();
  if (restored.status !== 'success' || !restored.value.session) {
    throw new Error('Restore failed');
  }

  expect(restored.value.session).not.toBe(state.value.session);
  const record = await client.customers.get({session: restored.value.session, id: 1});
  if (record.status !== 'success') {
    throw new Error('Restored record missing');
  }

  expect(record.value.customer.firstName).toBe('Backup saved');
  expect(record.value.reference.revision).not.toBe(created.value.reference.revision);
  expect(
    (
      await client.customers.update({
        reference: created.value.reference,
        changes: {firstName: 'Old session'},
      })
    ).status
  ).toBe('error');
  expect(getPreviewBackup(client)?.customers[0]?.customer.firstName).toBe('Backup saved');
  const next = await client.customers.create({session: restored.value.session, values});
  expect(next.status === 'success' && next.value.customer.id).toBe(2);
  expect(resolutions).toEqual(['aborted', 'aborted', 'committed']);
});

async function previewNames(names: string[]) {
  const client = createPreviewClient();
  const state = await client.database.status();
  if (state.status !== 'success' || !state.value.session) {
    throw new Error('Missing session');
  }

  const session = state.value.session;
  for (const firstName of names) {
    await client.customers.create({
      session,
      values: {
        firstName,
        lastName: '',
        address: '',
        city: '',
        province: '',
        postalCode: '',
        homePhone: '',
        email: '',
        stock: 0,
        balance: '0.00',
        previousBalance: '0.00',
        donate: false,
        comments: '',
      },
    });
  }

  return async (query: string) => {
    const result = await client.customers.list({session, query});
    if (result.status !== 'success') {
      throw new Error('Preview list failed');
    }

    return result.value.map(record => record.customer.firstName);
  };
}

test('preview searches names case-insensitively, treats punctuation literally, and finds numbers', async () => {
  const list = await previewNames(['Zoe', 'alice', 'Alina', '[literal]', '.*']);
  expect(await list(' ALI ')).toEqual(['alice', 'Alina']);
  expect(await list('[')).toEqual(['[literal]']);
  expect(await list('.*')).toEqual(['.*']);
  expect(await list('1')).toEqual(['Zoe']);
  expect(await list('missing')).toEqual([]);
});

test('preview orders names case-insensitively with stable ties', async () => {
  const list = await previewNames(['Zoe', 'alice', 'Alice', 'Bob']);
  expect(await list('')).toEqual(['alice', 'Alice', 'Bob', 'Zoe']);
});
