import {act, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test, vi} from 'vitest';

import renderRoute from '../../../test/renderRoute';
import {createApplication} from '../../application/controller';
import {customerKeys, customerListOptions} from '../../application/customers';
import createPreviewClient from '../../application/preview';

async function fixture() {
  const user = userEvent.setup();
  const client = createPreviewClient();
  const application = createApplication('http://localhost/?preview=true', false, {
    client,
  });
  const {router} = renderRoute('/customers', application);
  await screen.findByRole('heading', {name: 'Customers'});
  const session = application.getState().database!.session!;
  const created = await client.customers.create({
    session,
    values: {
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
    },
  });
  if (created.status !== 'success') {
    throw new Error('Could not create fixture customer');
  }

  return {user, client, application, router, session, record: created.value};
}

test('header refresh retains search and rows on failure, toasts, retries, and invalidates inactive caches', async () => {
  const {user, client, application, router, session, record} = await fixture();
  await act(async () => {
    await application.queryClient.fetchQuery(
      customerListOptions(application, session, 'unused')
    );
    await router.navigate({to: '/customers', search: {q: 'Original'}});
  });
  await screen.findByRole('link', {name: 'Original'});
  const notify = vi.spyOn(application.toasts, 'error');
  const list = client.customers.list;
  client.customers.list = async () => ({
    status: 'error',
    error: {code: 'INTERNAL', message: 'Refresh failed'},
  });
  await user.click(screen.getByRole('button', {name: 'Refresh customers'}));
  expect(await screen.findByRole('button', {name: 'Retry refresh'})).toBeEnabled();
  expect(screen.getByRole('link', {name: 'Original'})).toBeVisible();
  expect(router.state.location.search).toEqual({q: 'Original'});
  expect(screen.getByRole('textbox', {name: 'Search customers'})).toHaveValue('Original');
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'Could not refresh customers',
      description: 'Refresh failed',
    })
  );
  expect(
    application.queryClient.getQueryState(customerKeys.list(session, 'unused'))
      ?.isInvalidated
  ).toBe(true);
  expect(
    screen.queryByRole('status', {name: 'Refreshing customers'})
  ).not.toBeInTheDocument();
  client.customers.list = list;
  await client.customers.update({
    reference: record.reference,
    changes: {phone: 'Updated'},
  });
  await user.click(screen.getByRole('button', {name: 'Retry refresh'}));
  expect(await screen.findByText('Updated')).toBeVisible();
  expect(router.state.location.pathname).toBe('/customers');
  expect(screen.queryByRole('button', {name: 'Retry refresh'})).not.toBeInTheDocument();
});

test('refresh disables dirty edits, shows the global spinner, adopts clean values and revision without navigation', async () => {
  const {user, client, application, router, record} = await fixture();
  await act(async () => {
    await router.navigate({to: '/customers/$customerId', params: {customerId: '1'}});
  });
  const name = await screen.findByRole('textbox', {name: 'First name'});
  expect(screen.queryByRole('button', {name: 'Reload customer'})).not.toBeInTheDocument();
  const refresh = screen.getByRole('button', {name: 'Refresh customers'});
  await user.clear(name);
  await user.type(name, 'Draft');
  expect(refresh).toBeDisabled();
  await act(async () => {
    await application.refreshCustomers();
  });
  expect(name).toHaveValue('Draft');
  await user.clear(name);
  await user.type(name, 'Original');
  await client.customers.update({
    reference: record.reference,
    changes: {firstName: 'External'},
  });
  const get = client.customers.get;
  let release!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  client.customers.get = async args => {
    await held;
    return get(args);
  };

  await user.click(refresh);
  expect(await screen.findByRole('status', {name: 'Refreshing customers'})).toBeVisible();
  expect(name).toBeDisabled();
  expect(refresh).toBeDisabled();
  await act(async () => {
    release();
  });
  await waitFor(() => expect(name).toHaveValue('External'));
  expect(router.state.location.pathname).toBe('/customers/1');
  expect(application.protection.isDirty()).toBe(false);
  expect(
    screen.queryByRole('status', {name: 'Refreshing customers'})
  ).not.toBeInTheDocument();
  await user.clear(name);
  await user.type(name, 'Saved with fresh revision');
  await user.click(screen.getByRole('button', {name: 'Save'}));
  expect(
    await screen.findByRole('link', {name: 'Saved with fresh revision'})
  ).toBeVisible();
});

test('detail refresh failure retains clean form and retries; deleted customer remains copyable', async () => {
  const {user, client, application, router, record} = await fixture();
  await act(async () => {
    await router.navigate({to: '/customers/$customerId', params: {customerId: '1'}});
  });
  const name = await screen.findByRole('textbox', {name: 'First name'});
  const notify = vi.spyOn(application.toasts, 'error');
  const get = client.customers.get;
  client.customers.get = async () => ({
    status: 'error',
    error: {code: 'INTERNAL', message: 'Read failed'},
  });
  await user.click(screen.getByRole('button', {name: 'Refresh customers'}));
  await screen.findByRole('button', {name: 'Retry refresh'});
  expect(name).toHaveValue('Original');
  expect(notify).toHaveBeenCalledWith(
    expect.objectContaining({description: 'Read failed'})
  );
  expect(router.state.location.pathname).toBe('/customers/1');
  client.customers.get = get;
  await user.click(screen.getByRole('button', {name: 'Retry refresh'}));
  await waitFor(() =>
    expect(screen.queryByRole('button', {name: 'Retry refresh'})).not.toBeInTheDocument()
  );
  await client.customers.delete({reference: record.reference});
  await user.click(screen.getByRole('button', {name: 'Refresh customers'}));
  expect(await screen.findByRole('heading', {name: 'Customer Not Found'})).toBeVisible();
  expect(name).toHaveValue('Original');
  expect(name).toHaveAttribute('readonly');
  expect(screen.getByRole('button', {name: 'Save'})).toBeDisabled();
});
