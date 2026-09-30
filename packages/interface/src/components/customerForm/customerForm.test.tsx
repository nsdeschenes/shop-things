import {QueryObserver} from '@tanstack/react-query';
import {act, fireEvent, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test, vi} from 'vitest';

import renderRoute from '../../../test/renderRoute';
import {createApplication} from '../../application/controller';
import {customerKeys} from '../../application/customers';
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

test('Edit retains exact loaded strings and original revision across background refresh', async () => {
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

  await act(async () => {
    await application.queryClient.invalidateQueries({
      queryKey: customerKeys.detail(session, created.value.customer.id),
    });
  });
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
  const client = createPreviewClient(async () => true);
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
  expect(screen.getByRole('button', {name: 'Reload customer'})).toBeEnabled();
  expect(screen.getByText('Customer number: 1')).toBeVisible();
  const session = application.getState().database!.session!;
  const saved = await client.customers.get({session, id: 1});
  if (saved.status !== 'success') {
    throw new Error('Saved customer missing after cancelled transition');
  }

  await client.customers.update({
    reference: saved.value.reference,
    changes: {firstName: 'External'},
  });
  await user.type(screen.getByRole('textbox', {name: 'First name'}), ' draft');
  await user.click(screen.getByRole('button', {name: 'Save'}));
  expect(
    await screen.findByText('This customer changed. Reload before saving.')
  ).toBeVisible();
  await user.click(screen.getByRole('button', {name: 'Reload customer'}));
  await waitFor(() =>
    expect(screen.getByRole('textbox', {name: 'First name'})).toHaveValue('External')
  );
  await user.clear(screen.getByRole('textbox', {name: 'First name'}));
  await user.type(screen.getByRole('textbox', {name: 'First name'}), 'Saved again');
  await user.click(screen.getByRole('button', {name: 'Save'}));
  expect(await screen.findByRole('heading', {name: 'Saved again'})).toBeVisible();
  expect(router.state.location.pathname).toBe('/customers/1');
});

test.each(['create', 'update'] as const)(
  '%s freezes every control and prevents duplicate keyboard and button submissions until detail opens',
  async operation => {
    const user = userEvent.setup();
    const client = createPreviewClient();
    const application = createApplication('http://localhost', true, {client});
    renderRoute('/customers/new', application);
    await user.type(await screen.findByRole('textbox', {name: 'First name'}), 'Saved');
    if (operation === 'update') {
      await user.click(screen.getByRole('button', {name: 'Save'}));
      await user.click(await screen.findByRole('button', {name: 'Edit customer'}));
      await user.type(screen.getByRole('textbox', {name: 'First name'}), ' edit');
    }

    let release!: () => void;
    const held = new Promise<void>(resolve => {
      release = resolve;
    });
    const originalCreate = client.customers.create;
    const originalUpdate = client.customers.update;
    const write =
      operation === 'create'
        ? vi.spyOn(client.customers, 'create').mockImplementation(async args => {
            await held;
            return originalCreate(args);
          })
        : vi.spyOn(client.customers, 'update').mockImplementation(async args => {
            await held;
            return originalUpdate(args);
          });
    const name = screen.getByRole('textbox', {name: 'First name'});
    const comments = screen.getByRole('textbox', {name: 'Comments'});
    await user.type(comments, 'Retained comments');
    screen.getByRole('button', {name: 'Save'}).focus();
    await user.keyboard('{Enter}');
    await screen.findByText('Saving customer…');
    for (const input of screen.getAllByRole('textbox')) {
      expect(input).toBeDisabled();
    }

    const donate = screen.getByRole('checkbox', {name: 'Donate'});
    expect(donate).toHaveAttribute('aria-disabled', 'true');
    await user.click(donate);
    await user.type(name, ' ignored');
    await user.type(comments, ' ignored');
    await user.click(screen.getByRole('button', {name: 'Save'}));
    fireEvent.submit(screen.getByRole('form', {name: 'Customer details'}));
    await user.keyboard('{Enter}');
    expect(name).toHaveValue(operation === 'create' ? 'Saved' : 'Saved edit');
    expect(comments).toHaveValue('Retained comments');
    expect(donate).not.toBeChecked();
    expect(write).toHaveBeenCalledTimes(1);
    release();
    expect(
      await screen.findByRole('heading', {
        name: operation === 'create' ? 'Saved' : 'Saved edit',
      })
    ).toBeVisible();
    expect(screen.getByText('Customer saved.')).toBeVisible();
    expect(application.protection.getState().saving).toBe(false);
    expect(application.protection.isDirty()).toBe(false);
  }
);

test('a recoverable Save failure retains the draft and allows correction and retry', async () => {
  const user = userEvent.setup();
  const client = createPreviewClient();
  let release!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  vi.spyOn(client.customers, 'create').mockImplementationOnce(async () => {
    await held;
    return {
      status: 'error',
      error: {
        code: 'VALIDATION',
        message: 'Correct the name.',
        fieldErrors: {firstName: 'Choose another name.'},
      },
    };
  });
  const application = createApplication('http://localhost', true, {client});
  renderRoute('/customers/new', application);
  const name = await screen.findByRole('textbox', {name: 'First name'});
  await user.type(name, 'Retained');
  await user.type(screen.getByRole('textbox', {name: 'Comments'}), 'My comments');
  await user.click(screen.getByRole('checkbox', {name: 'Donate'}));
  await user.click(screen.getByRole('button', {name: 'Save'}));
  await screen.findByText('Saving customer…');
  release();
  expect(await screen.findByText('Correct the name.')).toBeVisible();
  expect(name).toBeEnabled();
  expect(name).toHaveValue('Retained');
  expect(screen.getByRole('textbox', {name: 'Comments'})).toHaveValue('My comments');
  expect(screen.getByRole('checkbox', {name: 'Donate'})).toBeChecked();
  expect(application.protection.isDirty()).toBe(true);
  await user.type(name, ' correction');
  await user.click(screen.getByRole('button', {name: 'Save'}));
  expect(await screen.findByRole('heading', {name: 'Retained correction'})).toBeVisible();
});

test('inputs remain frozen after the write while protected list refresh finishes', async () => {
  const user = userEvent.setup();
  const {application} = renderRoute('/customers/new');
  const name = await screen.findByRole('textbox', {name: 'First name'});
  await user.type(name, 'Protected refresh');
  const session = application.getState().database!.session!;
  const key = [...customerKeys.session(session), 'list', 'held-refresh'];
  application.queryClient.setQueryData(key, []);
  let release!: () => void;
  const held = new Promise<[]>(resolve => {
    release = () => resolve([]);
  });
  const refresh = vi.fn(() => held);
  const observer = new QueryObserver(application.queryClient, {
    queryKey: key,
    queryFn: refresh,
    staleTime: Infinity,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await user.click(screen.getByRole('button', {name: 'Save'}));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(
      application.queryClient.getQueryData(customerKeys.detail(session, 1))
    ).toBeDefined();
    expect(name).toBeDisabled();
    expect(screen.getByRole('textbox', {name: 'Comments'})).toBeDisabled();
    expect(screen.getByText('Saving customer…')).toBeVisible();
    release();
    expect(await screen.findByRole('heading', {name: 'Protected refresh'})).toBeVisible();
  } finally {
    release();
    unsubscribe();
  }
});

test('obsolete Save completion cannot navigate into a replacement database session', async () => {
  const user = userEvent.setup();
  const client = createPreviewClient();
  const subscribe = client.database.onStateChanged;
  let emit!: Parameters<typeof subscribe>[0];
  client.database.onStateChanged = listener => {
    emit = listener;
    return subscribe(listener);
  };

  const create = client.customers.create;
  let release!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  client.customers.create = async args => {
    const result = await create(args);
    await held;
    return result;
  };

  const application = createApplication('http://localhost', true, {client});
  const {router} = renderRoute('/customers/new', application);
  await user.type(await screen.findByRole('textbox', {name: 'First name'}), 'Obsolete');
  await user.click(screen.getByRole('button', {name: 'Save'}));
  await screen.findByText('Saving customer…');
  const previous = application.getState().database!;
  await act(async () => {
    emit({...previous, session: 'replacement', version: previous.version + 1});
    // Replace the route before the old response arrives, as a lifecycle owner may do.
    await router.navigate({to: '/customers', ignoreBlocker: true});
  });
  expect(application.getState().database?.session).toBe('replacement');
  release();
  await waitFor(() => expect(application.protection.getState().saving).toBe(false));
  await waitFor(() => expect(router.state.location.pathname).toBe('/customers'));
  expect(application.getState().database?.session).toBe('replacement');
  expect(router.state.location.pathname).toBe('/customers');
  expect(screen.queryByText('Customer saved.')).not.toBeInTheDocument();
  expect(
    application.queryClient.getQueryData(customerKeys.detail('replacement', 1))
  ).toBeUndefined();
});

test('create and edit refresh previously visited lists and searches through history', async () => {
  const user = userEvent.setup();
  const {router} = renderRoute('/customers');
  await screen.findByRole('heading', {name: 'No Customers Yet'});
  await user.type(screen.getByRole('textbox', {name: 'Search customers'}), 'Ada');
  await screen.findByRole('heading', {name: 'No Matching Customers'});
  await user.click(screen.getByRole('link', {name: 'Add customer'}));
  await user.type(await screen.findByRole('textbox', {name: 'First name'}), 'Ada');
  await user.click(screen.getByRole('button', {name: 'Save'}));
  await screen.findByRole('heading', {name: 'Ada'});
  await user.click(screen.getByRole('link', {name: 'Back to customers'}));
  expect(await screen.findByRole('link', {name: 'Ada'})).toBeVisible();
  expect(screen.getByRole('textbox', {name: 'Search customers'})).toHaveValue('Ada');
  await user.click(screen.getByRole('button', {name: 'Clear'}));
  expect(await screen.findByRole('link', {name: 'Ada'})).toBeVisible();
  await user.click(screen.getByRole('link', {name: 'Ada'}));
  await user.click(await screen.findByRole('button', {name: 'Edit customer'}));
  const name = screen.getByRole('textbox', {name: 'First name'});
  await user.clear(name);
  await user.type(name, 'Grace');
  await user.click(screen.getByRole('button', {name: 'Save'}));
  await screen.findByRole('heading', {name: 'Grace'});
  router.history.go(-2);
  expect(await screen.findByRole('link', {name: 'Grace'})).toBeVisible();
  expect(screen.queryByRole('link', {name: 'Ada'})).not.toBeInTheDocument();
  await user.type(screen.getByRole('textbox', {name: 'Search customers'}), 'Ada');
  expect(
    await screen.findByRole('heading', {name: 'No Matching Customers'})
  ).toBeVisible();
});
