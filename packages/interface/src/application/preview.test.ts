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

  const saved = await client.customers.update({
    reference: created.value.reference,
    changes: {firstName: 'Updated'},
  });
  if (saved.status !== 'success') {
    throw new Error('Preview update failed');
  }

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
