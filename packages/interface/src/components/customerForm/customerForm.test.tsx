import {screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import renderRoute from '../../../test/renderRoute';
import {createApplication} from '../../application/controller';
import createPreviewClient from '../../application/preview';

test('empty defaults validate on Save and preserve arbitrary contacts and exact balances', async () => {
  const user = userEvent.setup();
  const {application} = renderRoute('/customers/new');
  const name = await screen.findByRole('textbox', {name: 'First name'});
  expect(screen.getByRole('textbox', {name: 'Province'})).toHaveValue('');
  expect(
    screen.queryByRole('textbox', {name: 'Customer number'})
  ).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', {name: 'Save'}));
  expect(
    await screen.findByText('Enter a first name, a last name, or both.')
  ).toBeVisible();
  await waitFor(() => expect(name).toHaveFocus());
  await user.type(name, 'Ada');
  await user.type(screen.getByRole('textbox', {name: 'Province'}), 'somewhere');
  await user.type(screen.getByRole('textbox', {name: 'Postal code'}), 'ab cd');
  await user.type(screen.getByRole('textbox', {name: 'Home phone'}), '+1 (902) 555-1234');
  await user.type(screen.getByRole('textbox', {name: 'Email address'}), 'contact text');
  const balance = screen.getByRole('textbox', {name: 'Balance ($)'});
  await user.clear(balance);
  await user.type(balance, '-1.23');
  await user.click(screen.getByRole('button', {name: 'Save'}));
  expect(await screen.findByRole('heading', {name: 'Ada'})).toBeVisible();
  const session = application.getState().database!.session!;
  const record = await application.request(session, client =>
    client.customers.get({session, id: 1})
  );
  expect(record).toMatchObject({
    status: 'success',
    value: {
      customer: {
        customerNumber: 1,
        province: 'somewhere',
        postalCode: 'ab cd',
        homePhone: '+1 (902) 555-1234',
        email: 'contact text',
        balance: '-1.23',
      },
    },
  });
});

test('invalid decimal drafts and failed Save retain entered values and route guards', async () => {
  const user = userEvent.setup();
  const {application, router} = renderRoute('/customers/new');
  await user.type(await screen.findByRole('textbox', {name: 'First name'}), 'Ada');
  const stock = screen.getByRole('textbox', {name: 'Items in stock'});
  await user.clear(stock);
  await user.type(stock, '-');
  await user.click(screen.getByRole('button', {name: 'Save'}));
  expect(stock).toHaveValue('-');
  expect(stock).toBeInvalid();
  await user.clear(stock);
  await user.type(stock, '0');
  const balance = screen.getByRole('textbox', {name: 'Balance ($)'});
  for (const value of ['-', '1.', '.5', '1.234']) {
    await user.clear(balance);
    await user.type(balance, value);
    await user.click(screen.getByRole('button', {name: 'Save'}));
    expect(screen.getByRole('heading', {name: 'New Customer'})).toBeVisible();
    expect(balance).toHaveValue(value);
    expect(application.protection.isDirty()).toBe(true);
  }

  await user.click(screen.getByRole('link', {name: 'Cancel'}));
  const stay = await screen.findByRole('button', {name: 'Stay'});
  await waitFor(() => expect(stay).toHaveFocus());
  await user.keyboard('{Enter}');
  expect(balance).toHaveValue('1.234');
  expect(router.state.location.pathname).toBe('/customers/new');
  expect(application.protection.getState().frozen).toBe(false);
  await user.click(screen.getByRole('link', {name: 'Customer records Shop Things'}));
  await user.click(await screen.findByRole('button', {name: 'Discard'}));
  await screen.findByRole('heading', {name: 'Customers'});
  expect(router.state.location.pathname).toBe('/customers');
  expect(application.protection.isDirty()).toBe(false);
});

test('Edit retains exact loaded strings and original revision across cache replacement', async () => {
  const user = userEvent.setup();
  const {application, router} = renderRoute('/customers');
  await screen.findByRole('link', {name: 'Add customer'});
  const session = application.getState().database!.session!;
  const values = {
    firstName: 'Loaded',
    lastName: '',
    address: '',
    city: '',
    province: 'custom province',
    postalCode: 'aB cd',
    homePhone: '+1 (902) 555',
    email: 'contact text',
    stock: 0,
    balance: '-1.23',
    previousBalance: '0.00',
    donate: false,
    comments: '',
  };
  const created = await application.request(session, client =>
    client.customers.create({session, values})
  );
  if (created.status !== 'success') {
    throw new Error('Preview create failed');
  }

  await router.navigate({
    to: '/customers/$customerId',
    params: {customerId: String(created.value.customer.id)},
  });
  await user.click(await screen.findByRole('button', {name: 'Edit customer'}));
  const number = screen.getByRole('textbox', {name: 'Customer number'});
  expect(screen.getByRole('textbox', {name: 'Province'})).toHaveValue('custom province');
  expect(screen.getByRole('textbox', {name: 'Postal code'})).toHaveValue('aB cd');
  await user.clear(number);
  await user.type(number, '-');
  await user.click(screen.getByRole('button', {name: 'Save'}));
  expect(number).toHaveValue('-');
  await waitFor(() => expect(number).toHaveFocus());
  await user.clear(number);
  await user.type(number, '11');
  const name = screen.getByRole('textbox', {name: 'First name'});
  await user.clear(name);
  await user.type(name, 'Retained draft');
  const changed = await application.request(session, client =>
    client.customers.update({
      reference: created.value.reference,
      changes: {firstName: 'External'},
    })
  );
  if (changed.status !== 'success') {
    throw new Error('Preview external update failed');
  }

  application.queryClient.setQueryData(
    ['customers', session, 'detail', created.value.customer.id],
    changed.value
  );
  expect(name).toHaveValue('Retained draft');
  await user.click(screen.getByRole('button', {name: 'Save'}));
  expect(
    await screen.findByText('This customer changed. Reload before saving.')
  ).toBeVisible();
  expect(name).toHaveValue('Retained draft');
  expect(number).toHaveValue('11');
  expect(screen.getByRole('button', {name: 'Save'})).toBeDisabled();
});

test('changing immutable route ID remounts the editing capture and history returns to detail', async () => {
  const user = userEvent.setup();
  const {application, router} = renderRoute('/customers');
  await screen.findByRole('link', {name: 'Add customer'});
  const session = application.getState().database!.session!;
  const values = {
    firstName: 'First',
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
  await application.request(session, client =>
    client.customers.create({session, values})
  );
  await application.request(session, client =>
    client.customers.create({session, values: {...values, firstName: 'Second'}})
  );
  await router.navigate({to: '/customers/$customerId', params: {customerId: '1'}});
  await user.click(await screen.findByRole('button', {name: 'Edit customer'}));
  expect(screen.getByRole('textbox', {name: 'First name'})).toHaveValue('First');
  await router.navigate({to: '/customers/$customerId', params: {customerId: '2'}});
  await user.click(await screen.findByRole('button', {name: 'Edit customer'}));
  expect(screen.getByRole('textbox', {name: 'First name'})).toHaveValue('Second');
  router.history.back();
  expect(await screen.findByRole('heading', {name: 'First'})).toBeVisible();
  expect(screen.queryByRole('textbox', {name: 'First name'})).not.toBeInTheDocument();
});

test('a queued file transition suppresses clean Save navigation even before native preparation', async () => {
  const user = userEvent.setup();
  const client = createPreviewClient();
  const originalCreate = client.customers.create;
  let releaseSave!: () => void;
  let releaseOpen!: () => void;
  let startedSave!: () => void;
  const pendingSave = new Promise<void>(resolve => {
    releaseSave = resolve;
  });
  const pendingOpen = new Promise<void>(resolve => {
    releaseOpen = resolve;
  });
  const started = new Promise<void>(resolve => {
    startedSave = resolve;
  });
  client.customers.create = async args => {
    const result = await originalCreate(args);
    startedSave();
    await pendingSave;
    return result;
  };

  client.database.open = async () => {
    await pendingOpen;
    return {status: 'cancelled'};
  };

  const application = createApplication('http://localhost', true, {client});
  const {router} = renderRoute('/customers/new', application);
  await user.type(await screen.findByRole('textbox', {name: 'First name'}), 'Saved');
  await user.click(screen.getByRole('button', {name: 'Save'}));
  await started;
  const opening = application.transition('open');
  expect(application.getState().pendingTransition).toBe(true);
  expect(application.protection.getState().frozen).toBe(false);
  releaseSave();
  await waitFor(() => expect(application.protection.getState().saving).toBe(false));
  expect(router.state.location.pathname).toBe('/customers/new');
  releaseOpen();
  await opening;
  expect(router.state.location.pathname).toBe('/customers/new');
  expect(screen.getByRole('textbox', {name: 'First name'})).toHaveValue('Saved');
});
