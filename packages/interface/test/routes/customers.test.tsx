import {act, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test, vi} from 'vitest';

import {createApplication} from '../../src/application/controller';
import {customerKeys} from '../../src/application/customers';
import createPreviewClient from '../../src/application/preview';
import renderRoute from '../renderRoute';

function fixture() {
  const client = createPreviewClient();
  return {
    client,
    application: createApplication('http://localhost/?preview=true', false, {client}),
  };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return {promise, resolve};
}

test('offers temporary customer workflows without database file controls', async () => {
  renderRoute('/customers');
  expect(
    await screen.findByText('Browser preview — temporary data', {exact: false})
  ).toBeVisible();
  expect(screen.queryByRole('button', {name: 'Database'})).not.toBeInTheDocument();
  expect(await screen.findByRole('link', {name: 'Add customer'})).toHaveAttribute(
    'href',
    '/customers/new'
  );
  expect(screen.queryByRole('textbox', {name: 'First name'})).not.toBeInTheDocument();
  expect(await screen.findByText('0 results')).toBeInTheDocument();
  expect(screen.getByRole('heading', {name: 'No Customers Yet'})).toBeInTheDocument();
});

test('validates list search with Zod and clears it when opening a new customer', async () => {
  const user = userEvent.setup();
  const {router} = renderRoute('/customers?q=123');
  const search = await screen.findByRole('textbox', {name: 'Search customers'});
  expect(search).toHaveValue('');
  await user.type(search, 'Ada');
  await user.keyboard('{Enter}');
  await waitFor(() => expect(router.state.location.search).toEqual({q: 'Ada'}));
  await user.click(screen.getByRole('link', {name: 'Add customer'}));
  await screen.findByRole('textbox', {name: 'First name'});
  expect(router.state.location.search).toEqual({});
  await user.click(screen.getByRole('link', {name: 'Cancel'}));
  expect(await screen.findByRole('textbox', {name: 'Search customers'})).toHaveValue('');
});

test('Clear suppresses a pending debounced search', async () => {
  const user = userEvent.setup();
  const {client, application} = fixture();
  const read = vi.spyOn(client.customers, 'list');
  const {router} = renderRoute('/customers', application);
  const input = await screen.findByRole('textbox', {name: 'Search customers'});
  await user.type(input, 'Ada');
  await user.click(screen.getByRole('button', {name: 'Clear'}));
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
  });
  expect(input).toHaveValue('');
  expect(router.state.location.search).toEqual({});
  expect(read).toHaveBeenCalledTimes(1);
});

test('Back updates the input without replaying a pending search', async () => {
  const user = userEvent.setup();
  const {router} = renderRoute('/customers?q=Ada');
  const input = await screen.findByRole('textbox', {name: 'Search customers'});
  await act(async () => {
    await router.navigate({to: '/customers', search: {q: 'Grace'}});
  });
  expect(input).toHaveValue('Grace');
  await user.type(input, ' Hopper');
  act(() => {
    router.history.back();
  });
  await waitFor(() => expect(input).toHaveValue('Ada'));
  await act(async () => {
    await new Promise(resolve => setTimeout(resolve, 300));
  });
  expect(router.state.location.search).toEqual({q: 'Ada'});
});

test('keeps search controls mounted and usable during a slow loader', async () => {
  const user = userEvent.setup();
  const {client, application} = fixture();
  const list = client.customers.list;
  const {promise: held, resolve: release} = deferred();
  client.customers.list = async args => {
    if (args.query) {
      await held;
    }

    return list(args);
  };

  renderRoute('/customers', application);
  const input = await screen.findByRole('textbox', {name: 'Search customers'});
  try {
    await user.type(input, 'Ada');
    expect(await screen.findByText('Loading customers…')).toBeVisible();
    // Exceed Router's default pending delay to detect a replacement of the controls.
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 1100));
    });
    expect(screen.getByRole('textbox', {name: 'Search customers'})).toBe(input);
    expect(input).toBeEnabled();
    await user.type(input, ' Lovelace');
    expect(input).toHaveValue('Ada Lovelace');
  } finally {
    await act(async () => {
      release();
    });
  }

  expect(
    await screen.findByRole('heading', {name: 'No Matching Customers'})
  ).toBeVisible();
  expect(input).toHaveValue('Ada Lovelace');
});

test('shows initial pending feedback before awaiting the first customer list', async () => {
  const {client, application} = fixture();
  const list = client.customers.list;
  const {promise: held, resolve: release} = deferred();
  client.customers.list = async args => {
    await held;
    return list(args);
  };

  renderRoute('/customers', application);
  try {
    expect(await screen.findByRole('status', {name: 'Loading customers…'})).toBeVisible();
    expect(screen.getByRole('banner')).toBeVisible();
    expect(screen.getByText('Shop Things')).toBeVisible();
    expect(
      screen.queryByRole('textbox', {name: 'Search customers'})
    ).not.toBeInTheDocument();
  } finally {
    await act(async () => {
      release();
    });
  }

  expect(await screen.findByRole('textbox', {name: 'Search customers'})).toBeVisible();
});

test('Router intent preloading fills Query cache and is reused by navigation', async () => {
  const user = userEvent.setup();
  const {client, application} = fixture();
  const read = vi.spyOn(client.customers, 'list');
  const {router} = renderRoute('/customers/new', application);
  await screen.findByRole('textbox', {name: 'First name'});
  const session = application.getState().database!.session!;
  await user.hover(screen.getByRole('link', {name: 'Cancel'}));
  await waitFor(() =>
    expect(application.queryClient.getQueryData(customerKeys.list(session, ''))).toEqual(
      []
    )
  );
  await user.click(screen.getByRole('link', {name: 'Cancel'}));
  expect(await screen.findByRole('heading', {name: 'No Customers Yet'})).toBeVisible();
  expect(router.state.location.pathname).toBe('/customers');
  expect(read).toHaveBeenCalledTimes(1);
});

test('a speculative list preload cannot supersede an active search', async () => {
  const {client, application} = fixture();
  const list = client.customers.list;
  const {promise: held, resolve: release} = deferred();
  client.customers.list = async args => {
    if (args.query === 'Ada') {
      await held;
    }

    return list(args);
  };

  const {router} = renderRoute('/customers', application);
  await screen.findByRole('textbox', {name: 'Search customers'});
  let navigating!: Promise<void>;
  act(() => {
    navigating = router.navigate({to: '/customers', search: {q: 'Ada'}});
  });
  await screen.findByText('Loading customers…');
  const preloading = router.preloadRoute({to: '/customers', search: {q: 'Grace'}});
  await act(async () => {
    release();
    await Promise.all([navigating, preloading]);
  });
  const session = application.getState().database!.session!;
  expect(application.queryClient.getQueryData(customerKeys.list(session, 'Ada'))).toEqual(
    []
  );
  expect(
    application.queryClient.getQueryData(customerKeys.list(session, 'Grace'))
  ).toEqual([]);
  expect(router.state.location.search).toEqual({q: 'Ada'});
});

test('initial loader failures show a route error component with a working retry', async () => {
  const user = userEvent.setup();
  const {client, application} = fixture();
  const list = client.customers.list;
  client.customers.list = async () => ({
    status: 'error',
    error: {code: 'INTERNAL', message: 'Read failed.'},
  });
  renderRoute('/customers', application);
  expect(
    await screen.findByRole('heading', {name: 'Could Not Load Customers'})
  ).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('Read failed.');
  client.customers.list = list;
  await user.click(screen.getByRole('button', {name: 'Retry'}));
  expect(await screen.findByRole('heading', {name: 'No Customers Yet'})).toBeVisible();
});

test('failed loading after discard approval retains the draft until a successful retry', async () => {
  const user = userEvent.setup();
  const {client, application} = fixture();
  const list = client.customers.list;
  client.drafts.confirmDiscard = async () => ({
    status: 'success',
    value: {approved: true},
  });
  client.customers.list = async () => ({
    status: 'error',
    error: {code: 'DATABASE_UNAVAILABLE', message: 'Read failed.'},
  });
  const {router} = renderRoute('/customers/new', application);
  const name = await screen.findByRole('textbox', {name: 'First name'});
  await user.type(name, 'Retained draft');
  await user.click(screen.getByRole('link', {name: 'Cancel'}));
  expect(
    await screen.findByText(
      'Navigation did not finish. Your edits are retained. Try again.'
    )
  ).toBeVisible();
  expect(name).toHaveValue('Retained draft');
  expect(router.state.location.pathname).toBe('/customers/new');
  expect(application.protection.getState().frozen).toBe(false);
  client.customers.list = list;
  await user.click(screen.getByRole('link', {name: 'Cancel'}));
  expect(await screen.findByRole('heading', {name: 'No Customers Yet'})).toBeVisible();
  expect(application.protection.isDirty()).toBe(false);
});

test('an outage retains an admitted draft and its route', async () => {
  const user = userEvent.setup();
  const {client, application} = fixture();
  let emit!: Parameters<typeof client.database.onStateChanged>[0];
  client.database.onStateChanged = listener => {
    emit = listener;
    return () => {};
  };

  const {router} = renderRoute('/customers/new', application);
  const name = await screen.findByRole('textbox', {name: 'First name'});
  await user.type(name, 'Retained through outage');
  const database = application.getState().database!;
  await act(async () => {
    emit({...database, available: false, version: database.version + 1});
  });
  expect(router.state.location.pathname).toBe('/customers/new');
  expect(screen.getByRole('textbox', {name: 'First name'})).toBe(name);
  expect(name).toHaveValue('Retained through outage');
  expect(name).toBeDisabled();
  expect(application.protection.isDirty()).toBe(true);
});

test('discarding an unavailable draft completes the redirect to the index', async () => {
  const user = userEvent.setup();
  const {client, application} = fixture();
  client.drafts.confirmDiscard = async () => ({
    status: 'success',
    value: {approved: true},
  });
  let emit!: Parameters<typeof client.database.onStateChanged>[0];
  client.database.onStateChanged = listener => {
    emit = listener;
    return () => {};
  };

  const {router} = renderRoute('/customers/new', application);
  await user.type(await screen.findByRole('textbox', {name: 'First name'}), 'Draft');
  const database = application.getState().database!;
  await act(async () => {
    emit({...database, available: false, version: database.version + 1});
  });
  await user.click(screen.getByRole('link', {name: 'Cancel'}));
  expect(
    await screen.findByText('Open or create a database to view customers.')
  ).toBeVisible();
  expect(router.state.location.pathname).toBe('/');
  expect(application.protection.getState().frozen).toBe(false);
  expect(application.protection.isDirty()).toBe(false);
});
