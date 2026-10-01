import type {Client, CustomerRecord, DatabaseState} from '@shop-things/contract';
import {QueryClientProvider} from '@tanstack/react-query';
import {act, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import renderRoute from '../../../test/renderRoute';
import {createApplication} from '../../application/controller';
import {customerKeys} from '../../application/customers';
import createPreviewClient from '../../application/preview';
import DeleteCustomer from './deleteCustomer';

async function fixture(remove: Client['customers']['delete'], number: number | null = 5) {
  const client = createPreviewClient();
  client.customers.delete = remove;
  const status = await client.database.status();
  if (status.status !== 'success') {
    throw new Error('Preview startup failed');
  }

  function ignoreState() {}

  let notify: (database: DatabaseState) => void = ignoreState;
  client.database.onStateChanged = listener => {
    notify = listener;
    return () => {};
  };

  const application = createApplication('http://localhost/?preview=true', false, {
    client,
  });
  await application.start();
  const record: CustomerRecord = {
    customer: {
      id: 7,
      customerNumber: number,
      firstName: 'Alex',
      lastName: 'Smith',
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
    reference: {session: status.value.session!, id: 7, revision: 'loaded-revision'},
  };
  let deleted = 0;
  application.queryClient.setQueryData(
    customerKeys.detail(record.reference.session, 7),
    record
  );
  render(
    <QueryClientProvider client={application.queryClient}>
      <DeleteCustomer
        application={application}
        record={record}
        disabled={false}
        onDeleted={() => {
          deleted++;
        }}
      />
    </QueryClientProvider>
  );
  return {
    application,
    record,
    user: userEvent.setup(),
    deleted: () => deleted,
    notify,
    state: status.value,
  };
}

async function confirm(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', {name: 'Delete customer'}));
  await user.click(
    within(screen.getByRole('dialog')).getByRole('button', {name: 'Delete customer'})
  );
}

test('identifies unassigned customers, defaults to Cancel and submits the retained reference only after confirmation', async () => {
  const references: unknown[] = [];
  const f = await fixture(async ({reference}) => {
    references.push(reference);
    return {status: 'success', value: {deleted: true}};
  }, null);
  await f.user.click(screen.getByRole('button', {name: 'Delete customer'}));
  const dialog = screen.getByRole('dialog');
  expect(dialog).toHaveTextContent('Alex Smith (# Unassigned)');
  await waitFor(() =>
    expect(within(dialog).getByRole('button', {name: 'Cancel'})).toHaveFocus()
  );
  await f.user.click(within(dialog).getByRole('button', {name: 'Cancel'}));
  expect(references).toEqual([]);
  expect(f.deleted()).toBe(0);
  expect(
    f.application.queryClient.getQueryData(
      customerKeys.detail(f.record.reference.session, 7)
    )
  ).toEqual(f.record);
  await confirm(f.user);
  await waitFor(() => expect(f.deleted()).toBe(1));
  expect(references).toEqual([f.record.reference]);
  expect(
    f.application.queryClient.getQueryData(
      customerKeys.detail(f.record.reference.session, 7)
    )
  ).toBeUndefined();
});

test('stale deletion preserves detail and blocks repeat writes without refreshing its reference', async () => {
  let calls = 0;
  const f = await fixture(async () => {
    calls++;
    return {
      status: 'error',
      error: {
        code: 'STALE_REVISION',
        message: 'Customer changed. Reload before deleting.',
      },
    };
  });
  await confirm(f.user);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Customer changed. Reload before deleting.'
  );
  expect(screen.getByRole('button', {name: 'Delete customer'})).toBeDisabled();
  expect(f.deleted()).toBe(0);
  expect(calls).toBe(1);
  expect(
    f.application.queryClient.getQueryData(
      customerKeys.detail(f.record.reference.session, 7)
    )
  ).toEqual(f.record);
});

test('obsolete deletion completion cannot navigate or invalidate a new session cache', async () => {
  let finish!: (value: Awaited<ReturnType<Client['customers']['delete']>>) => void;
  const f = await fixture(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  await confirm(f.user);
  expect(screen.getByRole('button', {name: 'Deleting customer…'})).toBeDisabled();
  await act(async () => {
    f.notify({...f.state, session: 'replacement', version: f.state.version + 1});
  });
  const key = customerKeys.detail('replacement', 7);
  f.application.queryClient.setQueryData(key, {
    ...f.record,
    reference: {...f.record.reference, session: 'replacement'},
  });
  await act(async () => {
    finish({status: 'success', value: {deleted: true}});
  });
  await waitFor(() =>
    expect(screen.getByRole('button', {name: 'Delete customer'})).toBeEnabled()
  );
  expect(f.deleted()).toBe(0);
  expect(f.application.queryClient.getQueryData(key)).toBeDefined();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('deletion refreshes previously visited lists and searches through history', async () => {
  const user = userEvent.setup();
  const {router} = renderRoute('/customers');
  await user.click(await screen.findByRole('link', {name: 'Add customer'}));
  await user.type(await screen.findByRole('textbox', {name: 'First name'}), 'Temporary');
  await user.click(screen.getByRole('button', {name: 'Save'}));
  await screen.findByRole('heading', {name: 'Customers'});
  await screen.findByRole('link', {name: 'Temporary'});
  await user.type(screen.getByRole('textbox', {name: 'Search customers'}), 'Temp');
  await waitFor(() => expect(router.state.location.search).toMatchObject({q: 'Temp'}));
  await user.click(await screen.findByRole('link', {name: 'Temporary'}));
  await screen.findByRole('heading', {name: 'Temporary'});
  await confirm(user);
  expect(await screen.findByText('Customer deleted.')).toBeVisible();
  expect(await screen.findByRole('heading', {name: 'No Customers Yet'})).toBeVisible();
  expect(screen.getByRole('textbox', {name: 'Search customers'})).toHaveValue('');
  router.history.back();
  expect(await screen.findByRole('heading', {name: 'Customer Not Found'})).toBeVisible();
  await user.click(screen.getByRole('link', {name: 'Back to customers'}));
  expect(await screen.findByRole('heading', {name: 'No Customers Yet'})).toBeVisible();
  expect(screen.getByRole('button', {name: 'Clear'})).toBeDisabled();
  expect(screen.queryByRole('link', {name: 'Temporary'})).not.toBeInTheDocument();
});
