import {expect, test} from 'vitest';

import createPreviewClient, {setPreviewOutcome} from './preview';
import {getPreviewBackup, getPreviewExport} from './previewFiles';

test('backup clones every saved record without preparing drafts and failed simulations retain the snapshot', async () => {
  const client = createPreviewClient();
  const status = await client.database.status();
  if (status.status !== 'success' || !status.value.session) {
    throw new Error('Missing preview session');
  }

  const session = status.value.session;
  const values = {
    firstName: 'Saved',
    lastName: '',
    address: '',
    city: '',
    province: '',
    postalCode: '',
    homePhone: '',
    email: '',
    stock: 0,
    balance: '12.30',
    previousBalance: '0.00',
    donate: false,
    comments: '',
  };
  const first = await client.customers.create({session, values});
  await client.customers.create({session, values: {...values, firstName: 'Other'}});
  if (first.status !== 'success') {
    throw new Error('Preview create failed');
  }

  client.drafts.registerProtection({
    prepare: async () => {
      throw new Error('Backup must not prepare');
    },
    resolve: () => {
      throw new Error('Backup must not resolve');
    },
  });
  expect(await client.database.backup({session})).toMatchObject({status: 'success'});
  const snapshot = getPreviewBackup(client);
  expect(snapshot?.customers).toHaveLength(2);
  expect(snapshot?.nextId).toBe(3);
  await client.customers.update({
    reference: first.value.reference,
    changes: {balance: '99.00'},
  });
  expect(getPreviewBackup(client)?.customers[0]?.customer.balance).toBe('12.30');
  snapshot!.customers.length = 0;
  expect(getPreviewBackup(client)?.customers).toHaveLength(2);
  expect(await client.exports.csv({session})).toMatchObject({status: 'success'});
  expect(getPreviewExport(client)).toHaveLength(2);
  expect(getPreviewExport(client)?.[0]?.customer.balance).toBe('99.00');
  setPreviewOutcome(client, 'cancelled');
  expect(await client.database.backup({session})).toEqual({status: 'cancelled'});
  setPreviewOutcome(client, 'error');
  expect(await client.exports.csv({session})).toMatchObject({status: 'error'});
  expect(getPreviewBackup(client)?.customers).toHaveLength(2);
  expect(await client.database.status()).toEqual(status);
  expect(getPreviewBackup(createPreviewClient())).toBeNull();
});
