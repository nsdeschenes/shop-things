import type {DatabaseState} from '@shop-things/contract';
import {CancelledError, MutationObserver} from '@tanstack/react-query';
import {act, screen} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test} from 'vitest';

import renderRoute from '../../test/renderRoute';
import {createApplication} from './controller';
import {
  createCustomerOptions,
  deleteCustomerOptions,
  updateCustomerOptions,
} from './customers';
import createPreviewClient from './preview';

const values = {
  firstName: 'Original',
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
};

test.each(['create', 'update', 'delete'] as const)(
  'a delayed %s refreshes the visible list when its response settles',
  async operation => {
    const client = createPreviewClient();
    const application = createApplication('http://localhost/?preview=true', false, {
      client,
    });
    await application.start();
    const session = application.getState().database!.session!;
    const initial = await client.customers.create({session, values});
    if (initial.status !== 'success') {
      throw new Error('Preview create failed');
    }

    renderRoute('/customers', application);
    await screen.findByRole('link', {name: 'Original'});
    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const create = client.customers.create;
    const update = client.customers.update;
    const remove = client.customers.delete;
    client.customers.create = async args => {
      const result = await create(args);
      await held;
      return result;
    };

    client.customers.update = async args => {
      const result = await update(args);
      await held;
      return result;
    };

    client.customers.delete = async args => {
      const result = await remove(args);
      await held;
      return result;
    };

    // Save's draft guard blocks navigation while pending. Exercise the same mutation
    // options with an already mounted list to verify shared completion ownership.
    const pending =
      operation === 'create'
        ? new MutationObserver(
            application.queryClient,
            createCustomerOptions(application, session)
          ).mutate({...values, firstName: 'Saved'})
        : operation === 'delete'
          ? new MutationObserver(
              application.queryClient,
              deleteCustomerOptions(application)
            ).mutate(initial.value.reference)
          : new MutationObserver(
              application.queryClient,
              updateCustomerOptions(application)
            ).mutate({reference: initial.value.reference, changes: {firstName: 'Saved'}});
    expect(screen.getByRole('link', {name: 'Original'})).toBeVisible();
    expect(screen.queryByRole('link', {name: 'Saved'})).not.toBeInTheDocument();
    await act(async () => {
      release();
      await pending;
    });
    const expectedResult =
      operation === 'delete'
        ? await screen.findByRole('heading', {name: 'No Customers Yet'})
        : await screen.findByRole('link', {name: 'Saved'});
    expect(expectedResult).toBeVisible();
    const resultCount = {create: '2 results', update: '1 result', delete: '0 results'};
    expect(screen.getByText(resultCount[operation])).toBeVisible();
  }
);

test('a failed edit preserves the draft and existing list after discarding', async () => {
  const user = userEvent.setup();
  const client = createPreviewClient(() =>
    application.protection.confirmPreviewDiscard()
  );
  const application = createApplication('http://localhost/?preview=true', false, {
    client,
  });
  await application.start();
  const session = application.getState().database!.session!;
  await client.customers.create({session, values});
  let writes = 0;
  client.customers.update = async () => {
    writes++;
    return {status: 'error', error: {code: 'INTERNAL', message: 'Save failed'}};
  };

  const {router} = renderRoute('/customers', application);
  await user.click(await screen.findByRole('link', {name: 'Original'}));
  await screen.findByRole('textbox', {name: 'First name'});
  const name = screen.getByRole('textbox', {name: 'First name'});
  await user.clear(name);
  await user.type(name, 'Unsaved');
  await user.click(screen.getByRole('button', {name: 'Save'}));
  expect(await screen.findByText('Save failed')).toBeVisible();
  expect(name).toHaveValue('Unsaved');
  expect(router.state.location.pathname).toBe('/customers/1');
  await user.click(screen.getByRole('link', {name: 'Back to customers'}));
  await user.click(await screen.findByRole('button', {name: 'Discard'}));
  expect(await screen.findByRole('link', {name: 'Original'})).toBeVisible();
  expect(screen.queryByRole('link', {name: 'Unsaved'})).not.toBeInTheDocument();
  expect(writes).toBe(1);
});

test.each(['create', 'update', 'delete'] as const)(
  'an obsolete %s cannot repaint or navigate the replacement session',
  async operation => {
    const user = userEvent.setup();
    const client = createPreviewClient();
    let notify!: (state: DatabaseState) => void;
    client.database.onStateChanged = listener => {
      notify = listener;
      return () => {};
    };

    const application = createApplication('http://localhost/?preview=true', false, {
      client,
    });
    await application.start();
    const database = application.getState().database!;
    const initial = await client.customers.create({session: database.session!, values});
    if (initial.status !== 'success') {
      throw new Error('Preview create failed');
    }

    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const dispatched = new Promise<void>(resolve => {
      started = resolve;
    });
    const create = client.customers.create;
    const update = client.customers.update;
    const remove = client.customers.delete;
    client.customers.create = async args => {
      const result = await create(args);
      started();
      await held;
      return result;
    };

    client.customers.update = async args => {
      const result = await update(args);
      started();
      await held;
      return result;
    };

    client.customers.delete = async args => {
      const result = await remove(args);
      started();
      await held;
      return result;
    };

    const {router} = renderRoute('/customers', application);
    await screen.findByRole('link', {name: 'Original'});
    const pending =
      operation === 'create'
        ? new MutationObserver(
            application.queryClient,
            createCustomerOptions(application, database.session!)
          ).mutate({...values, firstName: 'Old session save'})
        : operation === 'delete'
          ? new MutationObserver(
              application.queryClient,
              deleteCustomerOptions(application)
            ).mutate(initial.value.reference)
          : new MutationObserver(
              application.queryClient,
              updateCustomerOptions(application)
            ).mutate({
              reference: initial.value.reference,
              changes: {firstName: 'Old session save'},
            });
    const settled = pending.catch(failure => failure);
    await dispatched;
    const replacement = createPreviewClient();
    const status = await replacement.database.status();
    if (status.status !== 'success') {
      throw new Error('Replacement preview failed');
    }

    await replacement.customers.create({
      session: status.value.session!,
      values: {...values, firstName: 'Replacement'},
    });
    client.customers = replacement.customers;
    await act(async () => {
      notify({...status.value, version: database.version + 1});
      release();
      expect(await settled).toBeInstanceOf(CancelledError);
    });
    expect(await screen.findByRole('link', {name: 'Replacement'})).toBeVisible();
    expect(router.state.location.pathname).toBe('/customers');
    expect(screen.queryByText('Customer saved.')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('link', {name: 'Old session save'})
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('link', {name: 'Replacement'}));
    expect(await screen.findByRole('heading', {name: 'Replacement'})).toBeVisible();
  }
);
