import type {DatabaseState} from '@shop-things/contract';
import {act, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import renderRoute from '../../../test/renderRoute';
import {createApplication} from '../../application/controller';
import {customerListOptions} from '../../application/customers';
import createPreviewClient from '../../application/preview';

async function fixture() {
  const user = userEvent.setup();
  const client = createPreviewClient();
  let emit!: (state: DatabaseState) => void;
  client.database.onStateChanged = listener => {
    emit = listener;
    return () => {};
  };

  const application = createApplication('http://localhost/?preview=true', false, {
    client,
  });
  const {router} = renderRoute('/customers', application);
  await screen.findByRole('heading', {name: 'Customers'});
  const session = application.getState().database!.session!;

  async function create(firstName: string) {
    const result = await client.customers.create({
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
    if (result.status !== 'success') {
      throw new Error('Could not create fixture customer');
    }

    return result.value;
  }

  await create('Customer 42');
  const second = await create('Target');
  const updated = await client.customers.update({
    reference: second.reference,
    changes: {customerNumber: 42},
  });
  if (updated.status !== 'success') {
    throw new Error('Could not set fixture customer number');
  }

  return {
    user,
    client,
    application,
    router,
    emit: (state: DatabaseState) => emit(state),
    record: updated.value,
    input: screen.getByRole('textbox', {name: 'Go to customer number'}),
  };
}

test('header opens the exact customer number by button and Enter, independently of IDs and names', async () => {
  const {user, input, router} = await fixture();
  await user.type(input, ' 0042 ');
  await user.click(screen.getByRole('button', {name: 'Go'}));
  expect(await screen.findByRole('textbox', {name: 'First name'})).toHaveValue('Target');
  expect(router.state.location.pathname).toBe('/customers/2');
  expect(input).toHaveValue(' 0042 ');
  await user.clear(input);
  await user.type(input, '1{Enter}');
  await waitFor(() => expect(router.state.location.pathname).toBe('/customers/1'));
  expect(await screen.findByRole('textbox', {name: 'First name'})).toHaveValue(
    'Customer 42'
  );
});

test('header reports validation, missing numbers, and request failures without leaving the route', async () => {
  const {user, input, router, client} = await fixture();
  const go = screen.getByRole('button', {name: 'Go'});
  for (const value of ['', '0', '-1', '1.5', '1e2', 'abc', '9007199254740992']) {
    await user.clear(input);
    if (value) {
      await user.type(input, value);
    }

    await user.click(go);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Enter a positive whole customer number.'
    );
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(router.state.location.pathname).toBe('/customers');
  }

  await user.clear(input);
  await user.type(input, '999{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Customer number 999 was not found.'
  );
  expect(router.state.location.pathname).toBe('/customers');
  const list = client.customers.list;
  client.customers.list = async () => ({
    status: 'error',
    error: {code: 'INTERNAL', message: 'Read failed'},
  });
  await user.clear(input);
  await user.type(input, '42{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Could not open the customer. Try again.'
  );
  expect(router.state.location.pathname).toBe('/customers');
  client.customers.list = list;
  await user.click(go);
  expect(await screen.findByRole('textbox', {name: 'First name'})).toHaveValue('Target');
});

test('repeated lookup reads fresh saved numbers and does not open a matching name', async () => {
  const {user, input, router, client, record} = await fixture();
  await user.type(input, '42{Enter}');
  expect(await screen.findByRole('textbox', {name: 'First name'})).toHaveValue('Target');
  const updated = await client.customers.update({
    reference: record.reference,
    changes: {customerNumber: 77},
  });
  expect(updated.status).toBe('success');
  await user.click(screen.getByRole('button', {name: 'Go'}));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Customer number 42 was not found.'
  );
  expect(router.state.location.pathname).toBe('/customers/2');
  await user.clear(input);
  await user.type(input, '77{Enter}');
  await waitFor(() => expect(input).toBeEnabled());
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/customers/2');
});

test('customer lookup protects unsaved edits until discard is approved', async () => {
  const {user, input, router, client, application} = await fixture();
  await act(async () => {
    await router.navigate({to: '/customers/$customerId', params: {customerId: '1'}});
  });
  const name = await screen.findByRole('textbox', {name: 'First name'});
  await user.clear(name);
  await user.type(name, 'Unsaved');
  await user.type(input, '42{Enter}');
  await waitFor(() => expect(input).toBeEnabled());
  expect(router.state.location.pathname).toBe('/customers/1');
  expect(name).toHaveValue('Unsaved');
  expect(application.protection.isDirty()).toBe(true);
  client.drafts.confirmDiscard = async () => ({
    status: 'success',
    value: {approved: true},
  });
  await user.click(screen.getByRole('button', {name: 'Go'}));
  await waitFor(() => expect(router.state.location.pathname).toBe('/customers/2'));
  expect(await screen.findByRole('textbox', {name: 'First name'})).toHaveValue('Target');
  expect(application.protection.isDirty()).toBe(false);
});

test('changing an identical in-flight list search does not cancel header lookup', async () => {
  const {user, input, router, client, application} = await fixture();
  const session = application.getState().database!.session!;
  const list = client.customers.list;
  let release!: () => void;
  let started!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  const reading = new Promise<void>(resolve => {
    started = resolve;
  });
  let firstRead = true;
  client.customers.list = async args => {
    if (args.query === '42' && firstRead) {
      firstRead = false;
      started();
      await held;
    }

    return list(args);
  };

  const originalSearch = application.queryClient
    .fetchQuery(customerListOptions(application, session, '42'))
    .catch(() => undefined);
  await reading;
  await user.type(input, '42{Enter}');
  const changedSearch = application.queryClient.fetchQuery(
    customerListOptions(application, session, '1')
  );
  await act(async () => {
    release();
    await Promise.all([originalSearch, changedSearch]);
  });
  await waitFor(() => expect(router.state.location.pathname).toBe('/customers/2'));
  expect(await screen.findByRole('textbox', {name: 'First name'})).toHaveValue('Target');
});

test('a pending lookup disables repeat submission and cannot navigate after database replacement', async () => {
  const {user, input, router, client, application, emit} = await fixture();
  const list = client.customers.list;
  let release!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  client.customers.list = async args => {
    const result = await list(args);
    await held;
    return result;
  };

  await user.type(input, '42{Enter}');
  const go = screen.getByRole('button', {name: 'Go'});
  expect(input).toBeDisabled();
  expect(go).toBeDisabled();
  await user.click(go);
  const replacement = createPreviewClient();
  const database = await replacement.database.status();
  if (database.status !== 'success') {
    throw new Error('Could not open replacement preview');
  }

  client.customers = replacement.customers;
  client.database.status = replacement.database.status;
  await act(async () => {
    emit({...database.value, version: 2});
    release();
  });
  await waitFor(() => expect(router.state.location.pathname).toBe('/customers'));
  const currentInput = screen.getByRole('textbox', {name: 'Go to customer number'});
  expect(currentInput).toHaveValue('');
  expect(currentInput).toBeEnabled();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(application.getState().database?.session).toBe(database.value.session);
  await user.type(currentInput, '42{Enter}');
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Customer number 42 was not found.'
  );
});
