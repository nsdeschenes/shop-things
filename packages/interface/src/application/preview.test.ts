import {expect, test} from 'vitest';

import createPreviewClient from './preview';

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
    phone: '',
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
        phone: '',
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
