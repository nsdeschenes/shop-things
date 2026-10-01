import type {DatabaseState, ImportReview} from '@shop-things/contract';
import {act, screen, waitFor} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {expect, test, vi} from 'vitest';

import renderRoute from '../../test/renderRoute';
import {createApplication} from '../application/controller';
import {customerKeys} from '../application/customers';
import createPreviewClient from '../application/preview';

const numberingExplanation = /Unused source customer numbers are reserved first/;

const review: ImportReview = {
  importId: 'chosen',
  session: 'preview',
  fileName: 'customers.csv',
  status: 'ready',
  rows: [
    {
      recordNumber: 1,
      matches: [],
      choice: 'include',
      sourceCustomerNumber: 42,
      assignedCustomerNumber: 42,
      values: {
        firstName: 'Anne',
        lastName: 'Smith',
        address: '',
        city: '',
        province: '',
        postalCode: '',
        phone: '',
        email: '',
        stock: 0,
        balance: '12.34',
        previousBalance: '0.00',
        donate: false,
        comments: 'Notes',
      },
    },
  ],
  matchGroups: [],
  diagnostics: [],
  sourceRecordCount: 1,
  includedCount: 1,
  skippedCount: 0,
  unresolvedCount: 0,
  choicesResolved: true,
  invalidRecordCount: 0,
  omittedDiagnosticCount: 0,
  numberChangeCount: 0,
};
function fixture(selected = review) {
  const client = createPreviewClient();
  client.imports.prepare = vi.fn<typeof client.imports.prepare>(async args => ({
    status: 'success',
    value: {...selected, session: args.session},
  }));
  client.imports.review = vi.fn<typeof client.imports.review>(async args => ({
    status: 'success',
    value: {...selected, session: args.session},
  }));
  client.drafts.confirmDiscard = vi.fn<typeof client.drafts.confirmDiscard>(async () => ({
    status: 'success',
    value: {approved: true},
  }));
  return {
    client,
    application: createApplication('http://localhost/?preview=true', false, {client}),
  };
}

test('shows a selected file and inspectable rows; cancel returns without a discard prompt', async () => {
  const f = fixture();
  renderRoute('/customers/import?importId=chosen', f.application);
  expect(await screen.findByText('Selected file: customers.csv')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('1 source records');
  await userEvent.click(screen.getByText('Record 1: Anne Smith'));
  expect(screen.getByText('Source customer number: 42')).toBeVisible();
  expect(screen.getByText('Assigned customer number: 42')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('0 customer numbers will change');
  expect(screen.getByText(numberingExplanation)).toBeVisible();
  await userEvent.click(screen.getByRole('button', {name: 'Cancel'}));
  expect(await screen.findByRole('heading', {name: 'Customers'})).toBeVisible();
  expect(f.client.drafts.confirmDiscard).not.toHaveBeenCalled();
});

test('shows rejected record diagnostics, omitted details and file replacement', async () => {
  const f = fixture({
    ...review,
    status: 'rejected',
    rows: [],
    invalidRecordCount: 25,
    omittedDiagnosticCount: 3,
    diagnostics: [{recordNumber: 2, column: 'stock', reason: 'Enter a whole number.'}],
  });
  renderRoute('/customers/import?importId=chosen', f.application);
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '25 invalid customer records'
  );
  expect(screen.getByText('Record 2, stock: Enter a whole number.')).toBeVisible();
  expect(
    screen.getByText('3 additional details omitted. Showing the first 100 errors.')
  ).toBeVisible();
  await userEvent.click(screen.getByRole('button', {name: 'Choose another file'}));
  expect(f.client.imports.prepare).toHaveBeenCalledTimes(1);
});

test('keeps an editor draft on picker cancellation, guard cancellation and failed review loading', async () => {
  const f = fixture();
  const {router} = renderRoute('/customers/new', f.application);
  const firstName = await screen.findByRole('textbox', {name: 'First name'});
  await userEvent.type(firstName, 'Draft');
  f.client.imports.prepare = async () => ({status: 'cancelled'});
  await act(async () => {
    expect(await f.application.prepareImport()).toEqual({status: 'cancelled'});
  });
  expect(firstName).toHaveValue('Draft');
  f.client.drafts.confirmDiscard = async () => ({status: 'cancelled'});
  await act(async () => {
    void router.navigate({to: '/customers/import', search: {importId: 'chosen'}});
  });
  expect(firstName).toHaveValue('Draft');
  f.client.drafts.confirmDiscard = async () => ({
    status: 'success',
    value: {approved: true},
  });
  f.client.imports.review = async () => ({
    status: 'error',
    error: {code: 'INTERNAL', message: 'Review failed'},
  });
  await act(async () => {
    void router.navigate({to: '/customers/import', search: {importId: 'chosen'}});
  });
  await waitFor(() => expect(router.state.location.pathname).toBe('/customers/new'));
  expect(firstName).toHaveValue('Draft');
});

test('discards only after review loads successfully', async () => {
  const f = fixture();
  const {router} = renderRoute('/customers/new', f.application);
  await userEvent.type(await screen.findByRole('textbox', {name: 'First name'}), 'Draft');
  await act(async () => {
    void router.navigate({to: '/customers/import', search: {importId: 'chosen'}});
  });
  expect(await screen.findByText('Selected file: customers.csv')).toBeVisible();
  expect(f.application.protection.isDirty()).toBe(false);
});

test('shows blank and conflicting source numbers beside their planned replacements', async () => {
  const f = fixture({
    ...review,
    numberChangeCount: 2,
    sourceRecordCount: 3,
    includedCount: 3,
    rows: [
      {...review.rows[0]!, sourceCustomerNumber: null, assignedCustomerNumber: 2},
      {
        ...review.rows[0]!,
        recordNumber: 2,
        sourceCustomerNumber: 1,
        assignedCustomerNumber: 1,
      },
      {
        ...review.rows[0]!,
        recordNumber: 3,
        sourceCustomerNumber: 1,
        assignedCustomerNumber: 3,
      },
    ],
  });
  renderRoute('/customers/import?importId=chosen', f.application);
  await screen.findByText('Selected file: customers.csv');
  expect(screen.getByRole('status')).toHaveTextContent('2 customer numbers will change');
  await userEvent.click(screen.getByText('Record 1: Anne Smith'));
  expect(screen.getByText('Source customer number: Blank')).toBeVisible();
  expect(screen.getByText('Assigned customer number: 2')).toBeVisible();
  await userEvent.click(screen.getByText('Record 3: Anne Smith'));
  expect(screen.getByText('Assigned customer number: 3')).toBeVisible();
});

test('shows all match reasons and targets with fresh explicit choices and backend counts', async () => {
  const flagged: ImportReview = {
    ...review,
    includedCount: 0,
    unresolvedCount: 1,
    choicesResolved: false,
    rows: [
      {...review.rows[0]!, choice: 'unresolved', matches: ['name', 'email', 'phone']},
    ],
    matchGroups: [
      {
        id: 'name',
        reason: 'name',
        targets: [
          {kind: 'csv', recordNumber: 1},
          {kind: 'csv', recordNumber: 2},
        ],
      },
      {
        id: 'email',
        reason: 'email',
        targets: [
          {kind: 'csv', recordNumber: 1},
          {
            kind: 'customer',
            id: 7,
            customerNumber: 99,
            firstName: 'Saved',
            lastName: 'Customer',
          },
        ],
      },
      {
        id: 'phone',
        reason: 'phone',
        targets: [
          {kind: 'csv', recordNumber: 1},
          {kind: 'csv', recordNumber: 3},
        ],
      },
    ],
  };
  const f = fixture(flagged);
  f.client.imports.resolve = vi.fn<typeof f.client.imports.resolve>(async args => ({
    status: 'success',
    value: {
      ...flagged,
      session: args.session,
      rows: [{...flagged.rows[0]!, choice: args.choice}],
      includedCount: args.choice === 'add' ? 1 : 0,
      skippedCount: args.choice === 'skip' ? 1 : 0,
      unresolvedCount: 0,
      choicesResolved: true,
    },
  }));
  renderRoute('/customers/import?importId=chosen', f.application);
  await screen.findByText('Selected file: customers.csv');
  expect(screen.getByRole('status')).toHaveTextContent('1 unresolved possible matches');
  expect(screen.queryByRole('radio')).not.toBeInTheDocument();
  await userEvent.click(screen.getByText('Record 1: Anne Smith'));
  expect(await screen.findByText('CSV record 2')).toBeVisible();
  expect(screen.getByText('Saved customer 99: Saved Customer (ID 7)')).toBeVisible();
  expect(screen.getByText('Matching name:')).toBeVisible();
  expect(screen.getByText('Matching email:')).toBeVisible();
  expect(screen.getByText('Matching phone:')).toBeVisible();
  const add = screen.getByRole('radio', {name: 'Add anyway'});
  const skip = screen.getByRole('radio', {name: 'Skip'});
  expect(add).not.toBeChecked();
  expect(skip).not.toBeChecked();
  await userEvent.click(skip);
  await waitFor(() => expect(skip).toBeChecked());
  expect(screen.getByRole('status')).toHaveTextContent('1 skipped. 0 unresolved');
  expect(f.client.imports.resolve).toHaveBeenCalledWith({
    session: f.application.getState().database?.session,
    importId: 'chosen',
    recordNumber: 1,
    choice: 'skip',
  });
  await userEvent.click(add);
  await waitFor(() => expect(add).toBeChecked());
  expect(screen.getByRole('status')).toHaveTextContent('1 customers to add');
});

test('gates Add on choices and included totals; prevents duplicate clicks and cancellation during commit', async () => {
  const f = fixture();
  let finish!: () => void;
  const held = new Promise<void>(resolve => {
    finish = resolve;
  });
  f.client.imports.commit = vi.fn<typeof f.client.imports.commit>(async args => {
    await held;
    return {
      status: 'success',
      value: {kind: 'committed', session: args.session, addedCount: 1, skippedCount: 0},
    };
  });
  renderRoute('/customers/import?importId=chosen', f.application);
  const add = await screen.findByRole('button', {name: 'Add 1 customers'});
  await userEvent.dblClick(add);
  expect(f.client.imports.commit).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', {name: 'Cancel'})).toBeDisabled();
  expect(screen.getByRole('button', {name: 'Choose another file'})).toBeDisabled();
  expect(add).toBeDisabled();
  await act(async () => {
    finish();
  });
  expect(await screen.findByRole('heading', {name: 'Customers'})).toBeVisible();
});

test.each([
  {includedCount: 0, unresolvedCount: 1, choicesResolved: false},
  {includedCount: 0, unresolvedCount: 0, choicesResolved: true},
])('disables Add without a resolved nonempty batch: %j', async counts => {
  const f = fixture({...review, ...counts});
  renderRoute('/customers/import?importId=chosen', f.application);
  expect(await screen.findByRole('button', {name: 'Add 0 customers'})).toBeDisabled();
});

test('retries only saved-view refresh after repeated failures, blocks duplicates and uses actual totals', async () => {
  const f = fixture();
  const successToast = vi.spyOn(f.application.toasts, 'success');
  f.client.imports.commit = vi.fn<typeof f.client.imports.commit>(async args => ({
    status: 'success',
    value: {kind: 'committed', session: args.session, addedCount: 1, skippedCount: 2},
  }));
  const failedRead = {
    status: 'error' as const,
    error: {code: 'INTERNAL' as const, message: 'Read failed'},
  };
  let finish!: () => void;
  const held = new Promise<void>(resolve => {
    finish = resolve;
  });
  f.client.customers.list = vi
    .fn<typeof f.client.customers.list>()
    .mockResolvedValueOnce(failedRead)
    .mockResolvedValueOnce(failedRead)
    .mockImplementationOnce(async () => {
      await held;
      return {status: 'success', value: []};
    });
  renderRoute('/customers/import?importId=chosen', f.application);
  await userEvent.click(await screen.findByRole('button', {name: 'Add 1 customers'}));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Customers were added, but the customer list could not be refreshed.'
  );
  expect(screen.getByRole('status')).toHaveTextContent('1 customers added. 2 skipped.');
  expect(screen.queryByRole('button', {name: 'Add 1 customers'})).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', {name: 'Retry refresh'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('could not be refreshed');
  expect(screen.getByRole('status')).toHaveTextContent('1 customers added. 2 skipped.');
  await userEvent.dblClick(screen.getByRole('button', {name: 'Retry refresh'}));
  expect(f.client.customers.list).toHaveBeenCalledTimes(3);
  expect(screen.getByText('Refreshing saved customers...')).toBeVisible();
  expect(screen.getByRole('button', {name: 'Cancel'})).toBeDisabled();
  await act(async () => {
    finish();
  });
  expect(await screen.findByRole('heading', {name: 'Customers'})).toBeVisible();
  await waitFor(() =>
    expect(successToast).toHaveBeenCalledWith({title: '1 customers added. 2 skipped.'})
  );
  expect(f.client.imports.commit).toHaveBeenCalledTimes(1);
  expect(f.client.imports.prepare).not.toHaveBeenCalled();
});

test('ignores a successful refresh response from a replaced session', async () => {
  const f = fixture();
  const successToast = vi.spyOn(f.application.toasts, 'success');
  const database = await f.client.database.status();
  if (database.status !== 'success') {
    throw new Error('Preview database failed');
  }

  const initial = await f.client.customers.create({
    session: database.value.session!,
    values: review.rows[0]!.values,
  });
  if (initial.status !== 'success') {
    throw new Error('Preview create failed');
  }

  let notify!: (state: DatabaseState) => void;
  f.client.database.onStateChanged = listener => {
    notify = listener;
    return () => {};
  };

  f.client.imports.commit = vi.fn<typeof f.client.imports.commit>(async args => ({
    status: 'success',
    value: {kind: 'committed', session: args.session, addedCount: 1, skippedCount: 0},
  }));
  let finish!: () => void;
  const held = new Promise<void>(resolve => {
    finish = resolve;
  });
  f.client.customers.list = vi
    .fn<typeof f.client.customers.list>(async () => ({status: 'success', value: []}))
    .mockResolvedValueOnce({
      status: 'error',
      error: {code: 'INTERNAL', message: 'Read failed'},
    })
    .mockImplementationOnce(async () => {
      await held;
      return {status: 'success', value: [initial.value]};
    });
  const {router} = renderRoute('/customers/import?importId=chosen', f.application);
  await userEvent.click(await screen.findByRole('button', {name: 'Add 1 customers'}));
  await userEvent.click(await screen.findByRole('button', {name: 'Retry refresh'}));
  const oldSession = f.application.getState().database!.session!;
  await act(async () => {
    notify({available: true, selectedPath: null, session: 'replacement', version: 2});
    finish();
  });
  await waitFor(() =>
    expect(screen.queryByText('Refreshing saved customers...')).not.toBeInTheDocument()
  );
  expect(await screen.findByRole('heading', {name: 'Customers'})).toBeVisible();
  expect(router.state.location.pathname).toBe('/customers');
  expect(
    f.application.queryClient.getQueryData(customerKeys.list('replacement', ''))
  ).toEqual([]);
  expect(successToast).not.toHaveBeenCalled();
  expect(screen.queryByRole('link', {name: 'Anne Smith'})).not.toBeInTheDocument();
  expect(
    f.application.queryClient.getQueryData(customerKeys.list(oldSession, ''))
  ).toBeUndefined();
  expect(f.client.imports.commit).toHaveBeenCalledTimes(1);
});

test('retains review after backup cancellation and reports revised plans before another Add', async () => {
  const f = fixture();
  f.client.imports.commit = vi
    .fn<typeof f.client.imports.commit>()
    .mockResolvedValueOnce({status: 'cancelled'})
    .mockImplementationOnce(async args => ({
      status: 'success',
      value: {
        kind: 'changed',
        review: {
          ...review,
          session: args.session,
          numberChangeCount: 1,
          rows: [{...review.rows[0]!, assignedCustomerNumber: 2}],
        },
      },
    }));
  renderRoute('/customers/import?importId=chosen', f.application);
  await userEvent.click(await screen.findByRole('button', {name: 'Add 1 customers'}));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Backup cancelled. No customers were added.'
  );
  await userEvent.click(screen.getByRole('button', {name: 'Add 1 customers'}));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Saved customers changed. Review the updated plan'
  );
  expect(screen.getByRole('status')).toHaveTextContent('1 customer numbers will change');
});

test('retains refresh retry after an interrupted read and same-session recovery', async () => {
  const f = fixture();
  let notify!: (state: DatabaseState) => void;
  f.client.database.onStateChanged = listener => {
    notify = listener;
    return () => {};
  };

  f.client.imports.commit = vi.fn<typeof f.client.imports.commit>(async args => ({
    status: 'success',
    value: {kind: 'committed', session: args.session, addedCount: 1, skippedCount: 0},
  }));
  let finish!: () => void;
  const held = new Promise<void>(resolve => {
    finish = resolve;
  });
  f.client.customers.list = vi
    .fn<typeof f.client.customers.list>(async () => ({status: 'success', value: []}))
    .mockImplementationOnce(async () => {
      await held;
      return {status: 'success', value: []};
    });
  renderRoute('/customers/import?importId=chosen', f.application);
  await userEvent.click(await screen.findByRole('button', {name: 'Add 1 customers'}));
  await screen.findByText('Refreshing saved customers...');
  const database = f.application.getState().database!;
  await act(async () => {
    notify({...database, available: false, version: database.version + 1});
    finish();
  });
  expect(await screen.findByRole('button', {name: 'Retry refresh'})).toBeDisabled();
  await act(async () => {
    notify({...database, version: database.version + 2});
  });
  await userEvent.click(screen.getByRole('button', {name: 'Retry refresh'}));
  expect(await screen.findByRole('heading', {name: 'Customers'})).toBeVisible();
  expect(f.client.imports.commit).toHaveBeenCalledTimes(1);
  expect(f.client.customers.list).toHaveBeenCalledTimes(2);
});

test('shows revised numbering and counts, retains unaffected choices, and gates Add on fresh matches', async () => {
  const group = {
    id: 'name',
    reason: 'name' as const,
    targets: [
      {kind: 'csv' as const, recordNumber: 1},
      {
        kind: 'customer' as const,
        id: 7,
        customerNumber: 42,
        firstName: 'Anne',
        lastName: 'Smith',
      },
    ],
  };
  const initial: ImportReview = {
    ...review,
    sourceRecordCount: 2,
    includedCount: 1,
    skippedCount: 1,
    rows: [
      {...review.rows[0]!, matches: ['name'], choice: 'add'},
      {
        ...review.rows[0]!,
        recordNumber: 2,
        matches: ['other'],
        choice: 'skip',
        assignedCustomerNumber: null,
      },
    ],
    matchGroups: [
      group,
      {
        ...group,
        id: 'other',
        targets: [
          {kind: 'csv', recordNumber: 2},
          {
            kind: 'customer',
            id: 8,
            customerNumber: 43,
            firstName: 'Other',
            lastName: 'Smith',
          },
        ],
      },
    ],
  };
  const revised: ImportReview = {
    ...initial,
    includedCount: 0,
    unresolvedCount: 1,
    choicesResolved: false,
    rows: [
      {...initial.rows[0]!, choice: 'unresolved', assignedCustomerNumber: null},
      initial.rows[1]!,
    ],
    matchGroups: [
      {
        ...group,
        targets: [
          ...group.targets,
          {
            kind: 'customer',
            id: 9,
            customerNumber: 44,
            firstName: 'Anne',
            lastName: 'Smith',
          },
        ],
      },
      initial.matchGroups[1]!,
    ],
  };
  const f = fixture(initial);
  f.client.imports.commit = vi.fn<typeof f.client.imports.commit>(async args => ({
    status: 'success',
    value: {kind: 'changed', review: {...revised, session: args.session}},
  }));
  f.client.imports.resolve = vi.fn<typeof f.client.imports.resolve>(async args => ({
    status: 'success',
    value: {
      ...revised,
      session: args.session,
      includedCount: 1,
      unresolvedCount: 0,
      choicesResolved: true,
      numberChangeCount: 1,
      rows: [
        {...revised.rows[0]!, choice: args.choice, assignedCustomerNumber: 1},
        revised.rows[1]!,
      ],
    },
  }));
  renderRoute('/customers/import?importId=chosen', f.application);
  await userEvent.click(await screen.findByRole('button', {name: 'Add 1 customers'}));
  await screen.findByText(
    'Saved customers changed. Review the updated plan before adding customers.'
  );
  expect(
    screen.getAllByText('Source to assigned number: 42 → Not included')
  ).toHaveLength(2);
  await userEvent.click(screen.getByText('Record 1: Anne Smith'));
  await userEvent.click(screen.getByText('Record 2: Anne Smith'));
  expect(screen.getByText('Saved customer 44: Anne Smith (ID 9)')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent(
    '0 customers to add. 1 skipped. 1 unresolved'
  );
  expect(screen.getByRole('button', {name: 'Add 0 customers'})).toBeDisabled();
  expect(screen.getAllByRole('radio', {name: 'Add anyway'})[0]).not.toBeChecked();
  expect(screen.getAllByRole('radio', {name: 'Skip'})[1]).toBeChecked();
  await userEvent.click(screen.getAllByRole('radio', {name: 'Add anyway'})[0]!);
  expect(await screen.findByText('Assigned customer number: 1')).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('1 customer numbers will change');
  expect(screen.getByRole('button', {name: 'Add 1 customers'})).toBeEnabled();
  expect(f.client.imports.commit).toHaveBeenCalledOnce();
});

test('ignores a late revised-plan response after destination session replacement', async () => {
  const f = fixture();
  let release!: () => void;
  const held = new Promise<void>(resolve => {
    release = resolve;
  });
  f.client.imports.commit = async args => {
    await held;
    return {
      status: 'success',
      value: {
        kind: 'changed',
        review: {
          ...review,
          session: args.session,
          numberChangeCount: 1,
          rows: [{...review.rows[0]!, assignedCustomerNumber: 2}],
        },
      },
    };
  };

  renderRoute('/customers/import?importId=chosen', f.application);
  await userEvent.click(await screen.findByRole('button', {name: 'Add 1 customers'}));
  const prior = f.application.getState().database!;
  await act(async () => {
    f.client.database.status = async () => ({
      status: 'success',
      value: {...prior, session: 'replacement', version: prior.version + 1},
    });
    await f.application.reconcile();
    release();
  });
  await waitFor(() => expect(f.application.getState().pendingFile).toBeNull());
  expect(
    screen.queryByText(
      'Saved customers changed. Review the updated plan before adding customers.'
    )
  ).not.toBeInTheDocument();
  expect(
    f.application.queryClient.getQueryData<ImportReview>([
      'imports',
      prior.session,
      'chosen',
    ])?.rows[0]?.assignedCustomerNumber
  ).not.toBe(2);
});

test('retains review choices through BUSY and an outage, then allows same-session checked retry', async () => {
  const selected: ImportReview = {
    ...review,
    rows: [{...review.rows[0]!, choice: 'add', matches: ['name']}],
    matchGroups: [
      {
        id: 'name',
        reason: 'name',
        targets: [
          {kind: 'csv', recordNumber: 1},
          {
            kind: 'customer',
            id: 7,
            customerNumber: 8,
            firstName: 'Anne',
            lastName: 'Smith',
          },
        ],
      },
    ],
  };
  const f = fixture(selected);
  f.client.imports.commit = vi
    .fn<typeof f.client.imports.commit>()
    .mockResolvedValueOnce({
      status: 'error',
      error: {code: 'BUSY', message: 'Another operation is running.'},
    })
    .mockResolvedValueOnce({
      status: 'error',
      error: {code: 'DATABASE_UNAVAILABLE', message: 'Destination unavailable.'},
    })
    .mockResolvedValueOnce({status: 'cancelled'});
  renderRoute('/customers/import?importId=chosen', f.application);
  await userEvent.click(await screen.findByText('Record 1: Anne Smith'));
  const choice = screen.getByRole('radio', {name: 'Add anyway'});
  const prior = f.application.getState().database!;
  await userEvent.click(screen.getByRole('button', {name: 'Add 1 customers'}));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'Another operation is running.'
  );
  expect(choice).toBeChecked();
  f.client.database.status = async () => ({
    status: 'success',
    value: {...prior, available: false, version: prior.version + 1},
  });
  await userEvent.click(screen.getByRole('button', {name: 'Add 1 customers'}));
  expect(
    await screen.findByText('The database is unavailable. Your review is retained.')
  ).toBeVisible();
  expect(choice).toBeChecked();
  expect(screen.getByRole('button', {name: 'Add 1 customers'})).toBeDisabled();
  await act(async () => {
    f.client.database.status = async () => ({
      status: 'success',
      value: {...prior, version: prior.version + 2},
    });
    await f.application.reconcile();
  });
  expect(choice).toBeChecked();
  await userEvent.click(screen.getByRole('button', {name: 'Add 1 customers'}));
  expect(
    await screen.findByText('Backup cancelled. No customers were added.')
  ).toBeVisible();
  expect(f.client.imports.commit).toHaveBeenCalledTimes(3);
});
