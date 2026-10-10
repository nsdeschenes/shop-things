import {Toast} from '@base-ui/react/toast';
import type {DatabaseState} from '@shop-things/contract';
import {act, render, screen, waitFor, within} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test, vi} from 'vitest';

import renderRoute from '../../../test/renderRoute';
import {createApplication} from '../../application/controller';
import {customerListOptions} from '../../application/customers';
import createPreviewClient from '../../application/preview';
import Toasts from '../toasts/toasts';

async function fixture() {
  const user = userEvent.setup();
  const client = createPreviewClient();
  let emit!: (state: DatabaseState) => void;
  client.database.onStateChanged = listener => {
    emit = listener;
    return () => {};
  };

  const toastManager = Toast.createToastManager();
  const application = createApplication('http://localhost/?preview=true', false, {
    client,
    toastManager,
  });
  render(
    <Toast.Provider toastManager={toastManager}>
      <Toasts />
    </Toast.Provider>
  );
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

  const input = screen.getByRole('textbox', {name: 'Go to customer number'});
  const viewport = screen.getByRole('region', {name: 'Notifications'});
  const notifications = within(viewport);
  async function expectNotification(description: string) {
    act(() => viewport.focus());
    const notification = await notifications.findByRole('alertdialog', {
      name: 'Could not open customer',
    });
    expect(notification).toHaveAccessibleDescription(description);
    expect(within(notification).getByText(description)).toBeVisible();
    const currentInput = screen.getByRole('textbox', {name: 'Go to customer number'});
    for (const header of screen.getAllByRole('banner')) {
      expect(within(header).queryByText(description)).not.toBeInTheDocument();
    }

    expect(currentInput).not.toHaveAttribute('aria-describedby');
    expect(currentInput).not.toHaveAttribute('aria-invalid');
  }

  return {
    user,
    client,
    application,
    router,
    emit: (state: DatabaseState) => emit(state),
    record: updated.value,
    input,
    notifications,
    expectNotification,
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
  const {user, input, router, client, notifications, expectNotification} =
    await fixture();
  const go = screen.getByRole('button', {name: 'Go'});
  for (const value of ['', '0', '-1', '1.5', '1e2', 'abc', '9007199254740992']) {
    await user.clear(input);
    if (value) {
      await user.type(input, value);
    }

    await user.click(go);
    await expectNotification('Enter a positive whole customer number.');
    expect(input).toHaveValue(value);
    expect(router.state.location.pathname).toBe('/customers');
    await user.click(notifications.getByRole('button', {name: 'Dismiss error'}));
    expect(notifications.queryByText('Could not open customer')).not.toBeInTheDocument();
  }

  await user.clear(input);
  await user.type(input, '999{Enter}');
  await expectNotification('Customer number 999 was not found.');
  expect(router.state.location.pathname).toBe('/customers');
  await user.click(notifications.getByRole('button', {name: 'Dismiss error'}));
  const list = client.customers.list;
  client.customers.list = async () => ({
    status: 'error',
    error: {code: 'INTERNAL', message: 'Read failed'},
  });
  await user.clear(input);
  await user.type(input, '42{Enter}');
  await expectNotification('Could not open the customer. Try again.');
  expect(router.state.location.pathname).toBe('/customers');
  expect(input).toHaveValue('42');
  expect(input).toBeEnabled();
  await user.click(notifications.getByRole('button', {name: 'Dismiss error'}));
  client.customers.list = list;
  await user.click(go);
  expect(await screen.findByRole('textbox', {name: 'First name'})).toHaveValue('Target');
  expect(notifications.queryByText('Could not open customer')).not.toBeInTheDocument();
});

test('header reports navigation failures in a dismissible toast and allows retry', async () => {
  const {user, input, router, notifications, expectNotification} = await fixture();
  const navigate = vi
    .spyOn(router, 'navigate')
    .mockRejectedValueOnce(new Error('Navigation failed'));
  await user.type(input, '42{Enter}');
  await expectNotification('Could not open the customer. Try again.');
  expect(router.state.location.pathname).toBe('/customers');
  expect(input).toHaveValue('42');
  expect(input).toBeEnabled();
  await user.click(notifications.getByRole('button', {name: 'Dismiss error'}));
  expect(notifications.queryByText('Could not open customer')).not.toBeInTheDocument();
  navigate.mockRestore();
  await user.click(screen.getByRole('button', {name: 'Go'}));
  expect(await screen.findByRole('textbox', {name: 'First name'})).toHaveValue('Target');
  expect(router.state.location.pathname).toBe('/customers/2');
});

test.each(['missing', 'error'])(
  'a held %s lookup retains keyboard focus and allows editing and retry',
  async outcome => {
    const {user, input, router, client, notifications, expectNotification} =
      await fixture();
    const list = client.customers.list;
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    client.customers.list = async args => {
      await held;
      return outcome === 'missing'
        ? list(args)
        : {status: 'error', error: {code: 'INTERNAL', message: 'Read failed'}};
    };

    await user.type(input, '999{Enter}');
    expect(input).toBeEnabled();
    expect(input).toHaveAttribute('readonly');
    expect(input).toHaveFocus();
    expect(screen.getByRole('button', {name: 'Go'})).toBeDisabled();
    await user.type(input, '1{Enter}');
    expect(input).toHaveValue('999');
    await act(async () => release());
    await waitFor(() => expect(input).not.toHaveAttribute('readonly'));
    expect(input).toBeEnabled();
    expect(input).toHaveFocus();
    expect(router.state.location.pathname).toBe('/customers');
    await user.keyboard('{F6}');
    await expectNotification(
      outcome === 'missing'
        ? 'Customer number 999 was not found.'
        : 'Could not open the customer. Try again.'
    );
    await user.click(notifications.getByRole('button', {name: 'Dismiss error'}));
    expect(input).toHaveFocus();
    client.customers.list = list;
    await user.clear(input);
    await user.type(input, '42{Enter}');
    expect(await screen.findByRole('textbox', {name: 'First name'})).toHaveValue(
      'Target'
    );
    expect(router.state.location.pathname).toBe('/customers/2');
  }
);

test('repeated lookup reads fresh saved numbers and does not open a matching name', async () => {
  const {user, input, router, client, record, notifications, expectNotification} =
    await fixture();
  await user.type(input, '42{Enter}');
  expect(await screen.findByRole('textbox', {name: 'First name'})).toHaveValue('Target');
  const updated = await client.customers.update({
    reference: record.reference,
    changes: {customerNumber: 77},
  });
  expect(updated.status).toBe('success');
  await user.click(screen.getByRole('button', {name: 'Go'}));
  await expectNotification('Customer number 42 was not found.');
  expect(router.state.location.pathname).toBe('/customers/2');
  await user.click(notifications.getByRole('button', {name: 'Dismiss error'}));
  await user.clear(input);
  await user.type(input, '77{Enter}');
  await waitFor(() => expect(input).not.toHaveAttribute('readonly'));
  expect(notifications.queryByText('Could not open customer')).not.toBeInTheDocument();
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
  await waitFor(() => expect(input).not.toHaveAttribute('readonly'));
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
  const {
    user,
    input,
    router,
    client,
    application,
    emit,
    notifications,
    expectNotification,
  } = await fixture();
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
  expect(input).toBeEnabled();
  expect(input).toHaveAttribute('readonly');
  expect(input).toHaveFocus();
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
  expect(notifications.queryByText('Could not open customer')).not.toBeInTheDocument();
  expect(application.getState().database?.session).toBe(database.value.session);
  await user.type(currentInput, '42{Enter}');
  await expectNotification('Customer number 42 was not found.');
});
