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

test('database settings navigation protects unsaved edits and preview file actions stay disabled', async () => {
  const {user, client, application, router} = await fixture();
  await act(async () => {
    await router.navigate({to: '/customers/$customerId', params: {customerId: '1'}});
  });
  const name = await screen.findByRole('textbox', {name: 'First name'});
  await user.clear(name);
  await user.type(name, 'Draft');
  await user.click(screen.getByRole('link', {name: 'Database settings'}));
  await waitFor(() => expect(application.protection.getState().frozen).toBe(false));
  expect(name).toHaveValue('Draft');
  expect(router.state.location.pathname).toBe('/customers/1');
  client.drafts.confirmDiscard = async () => ({
    status: 'success',
    value: {approved: true},
  });
  await user.click(screen.getByRole('link', {name: 'Database settings'}));
  expect(await screen.findByRole('heading', {name: 'Database Settings'})).toBeVisible();
  expect(router.state.location.pathname).toBe('/settings/database');
  for (const action of [
    'Open database',
    'Create database',
    'Back up database',
    'Restore backup',
    'Import customers',
    'Export all customers',
  ]) {
    expect(screen.getByRole('button', {name: action})).toBeDisabled();
  }

  expect(application.protection.isDirty()).toBe(false);
});

test('update control checks on open, shows availability and capability reasons, and dismisses without downloading', async () => {
  const {user, client, application} = await fixture();
  let finish!: (value: Awaited<ReturnType<typeof client.update.check>>) => void;
  const check = vi.spyOn(client.update, 'check').mockImplementation(
    () =>
      new Promise(resolve => {
        finish = resolve;
      })
  );
  const start = vi.spyOn(client.update, 'start');
  await user.click(screen.getByRole('button', {name: 'Check for updates'}));
  expect(screen.getByRole('status')).toHaveTextContent('Checking…');
  await act(async () =>
    finish({
      status: 'success',
      value: {
        revision: 1,
        phase: 'available',
        candidateId: 'candidate',
        targetVersion: '0.4.0',
        capabilityReasons: ['Installation is not available yet.'],
        nextActions: ['check'],
      },
    })
  );
  expect(screen.getByRole('status')).toHaveTextContent('Version 0.4.0 is available');
  expect(screen.getByRole('button', {name: 'Update'})).toBeDisabled();
  expect(screen.getByText('Installation is not available yet.')).toBeVisible();
  expect(screen.getByLabelText('Update available')).toBeVisible();
  await user.click(screen.getByRole('button', {name: 'Close'}));
  expect(screen.queryByRole('button', {name: 'Update'})).not.toBeInTheDocument();
  expect(screen.getByRole('button', {name: 'Check for updates'})).toBeVisible();
  expect(check).toHaveBeenCalledTimes(1);
  expect(start).not.toHaveBeenCalled();
  application.dispose();
});

test('update check failure offers an explicit retry and then reports current', async () => {
  const {user, client, application} = await fixture();
  vi.spyOn(client.update, 'check')
    .mockResolvedValueOnce({
      status: 'success',
      value: {
        revision: 1,
        phase: 'check-failed',
        errorCode: 'NETWORK',
        capabilityReasons: [],
        nextActions: ['check'],
      },
    })
    .mockResolvedValueOnce({
      status: 'success',
      value: {
        revision: 2,
        phase: 'current',
        capabilityReasons: [],
        nextActions: ['check'],
      },
    });
  await user.click(screen.getByRole('button', {name: 'Check for updates'}));
  await user.click(await screen.findByRole('button', {name: 'Retry'}));
  expect(await screen.findByRole('status')).toHaveTextContent("You're up to date");
  application.dispose();
});

test('explicit Update shows progress while customer work stays available and dismissal preserves the attempt', async () => {
  const {user, client, application} = await fixture();
  const checking = vi
    .spyOn(client.update, 'check')
    .mockResolvedValueOnce({
      status: 'success',
      value: {
        revision: 1,
        phase: 'available',
        candidateId: 'candidate',
        targetVersion: '0.4.0',
        capabilityReasons: ['Installation is not available yet.'],
        nextActions: ['check', 'update'],
      },
    })
    .mockResolvedValue({
      status: 'success',
      value: {
        revision: 3,
        phase: 'downloading',
        candidateId: 'candidate',
        attemptId: 'attempt',
        targetVersion: '0.4.0',
        progress: 0.5,
        capabilityReasons: ['Installation is not available yet.'],
        nextActions: [],
      },
    });
  const start = vi.spyOn(client.update, 'start').mockResolvedValue({
    status: 'success',
    value: {
      revision: 2,
      phase: 'downloading',
      candidateId: 'candidate',
      attemptId: 'attempt',
      targetVersion: '0.4.0',
      progress: 0.5,
      capabilityReasons: ['Installation is not available yet.'],
      nextActions: [],
    },
  });
  await user.click(screen.getByRole('button', {name: 'Check for updates'}));
  await user.click(await screen.findByRole('button', {name: 'Update'}));
  expect(start).toHaveBeenCalledWith({candidateId: 'candidate'});
  expect(
    await screen.findByRole('progressbar', {name: 'Update download progress'})
  ).toHaveValue(0.5);
  expect(screen.getByRole('button', {name: 'Refresh customers'})).toBeEnabled();
  await user.click(screen.getByRole('button', {name: 'Close'}));
  await user.click(screen.getByRole('button', {name: 'Check for updates'}));
  expect(
    await screen.findByRole('progressbar', {name: 'Update download progress'})
  ).toHaveValue(0.5);
  expect(start).toHaveBeenCalledTimes(1);
  expect(checking).toHaveBeenCalledTimes(2);
  application.dispose();
});

test('a download failure retries only its current opaque attempt and stops at verified staging', async () => {
  const {user, client, application} = await fixture();
  vi.spyOn(client.update, 'check').mockResolvedValue({
    status: 'success',
    value: {
      revision: 1,
      phase: 'available',
      candidateId: 'candidate',
      targetVersion: '0.4.0',
      capabilityReasons: [],
      nextActions: ['check', 'update'],
    },
  });
  vi.spyOn(client.update, 'start').mockResolvedValue({
    status: 'success',
    value: {
      revision: 2,
      phase: 'retryable-failure',
      candidateId: 'candidate',
      attemptId: 'failed-attempt',
      targetVersion: '0.4.0',
      errorCode: 'VERIFICATION',
      capabilityReasons: [],
      nextActions: ['retry'],
    },
  });
  const retry = vi.spyOn(client.update, 'retry').mockResolvedValue({
    status: 'success',
    value: {
      revision: 3,
      phase: 'staged',
      candidateId: 'candidate',
      attemptId: 'new-attempt',
      targetVersion: '0.4.0',
      progress: 1,
      capabilityReasons: [],
      nextActions: [],
    },
  });
  await user.click(screen.getByRole('button', {name: 'Check for updates'}));
  await user.click(await screen.findByRole('button', {name: 'Update'}));
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Update verification failed. Retry to download a fresh copy.'
  );
  await user.click(screen.getByRole('button', {name: 'Retry'}));
  expect(retry).toHaveBeenCalledWith({attemptId: 'failed-attempt'});
  expect(await screen.findByRole('status')).toHaveTextContent(
    'Download verified. Installation is not available yet.'
  );
  expect(screen.queryByRole('button', {name: 'Update'})).not.toBeInTheDocument();
  application.dispose();
});
