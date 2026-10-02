import {Toast} from '@base-ui/react/toast';
import type {DatabaseState, DraftProtection} from '@shop-things/contract';
import {isCancelledError} from '@tanstack/react-query';
import {expect, test, vi} from 'vitest';

import {createApplication} from './controller';
import {customerKeys, customerListOptions, deleteCustomerOptions} from './customers';
import createPreviewClient from './preview';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => {
    resolve = done;
  });
  return {promise, resolve};
}

function fixture() {
  const client = createPreviewClient();
  const first: DatabaseState = {
    available: true,
    selectedPath: '/customers.sqlite',
    session: 'one',
    version: 1,
  };
  let database = first;
  let notify: (state: DatabaseState) => void = ignoreState;

  function ignoreState() {}

  let protection: DraftProtection | null = null;
  let subscriptions = 0;
  client.database.status = async () => ({status: 'success', value: database});
  client.database.onStateChanged = listener => {
    subscriptions++;
    notify = listener;
    return () => {
      subscriptions--;
    };
  };

  client.drafts.registerProtection = participant => {
    protection = participant;
    return () => {
      protection = null;
    };
  };

  const toastManager = Toast.createToastManager();
  const application = createApplication('http://localhost', true, {client, toastManager});
  return {
    application,
    toastManager,
    client,
    first,
    getProtection: () => protection!,
    subscriptions: () => subscriptions,
    emit(next: DatabaseState) {
      database = next;
      notify(next);
    },
  };
}

test('approved navigation admits only reads and revokes admission when navigation fails', async () => {
  const f = fixture();
  await f.application.start();
  f.client.drafts.confirmDiscard = async () => ({
    status: 'success',
    value: {approved: true},
  });
  f.application.protection.registerEditor({
    values: () => ({name: 'Draft'}),
    baseline: () => ({name: ''}),
    reset() {},
  });
  const target = '/customers{}';
  expect(f.application.protection.navigationReadToken(target)).toBeUndefined();
  expect(await f.application.protection.blockNavigation(target)).toBe(false);
  const token = f.application.protection.navigationReadToken(target)!;
  expect(f.application.protection.navigationReadToken('/customers/1{}')).toBeUndefined();
  const scope = {navigationReadToken: token};
  let dispatched = 0;
  async function read() {
    dispatched++;
    return {status: 'success'} as const;
  }

  expect(await f.application.read('one', read)).toMatchObject({
    status: 'error',
    error: {code: 'BUSY'},
  });
  expect(await f.application.request('one', read, scope)).toMatchObject({
    status: 'error',
    error: {code: 'BUSY'},
  });
  expect(dispatched).toBe(0);
  expect(await f.application.read('one', read, scope)).toEqual({status: 'success'});
  expect(dispatched).toBe(1);
  const held = deferred<void>();
  const pending = f.application.read(
    'one',
    async () => {
      await held.promise;
      return {status: 'success'};
    },
    scope
  );
  await Promise.resolve();
  f.application.protection.navigationResolved(target, false);
  held.resolve();
  expect(await pending).toEqual({status: 'obsolete'});
  expect(f.application.protection.isNavigationReadCurrent(token)).toBe(false);
  expect(f.application.protection.isDirty()).toBe(true);
});

test('accepts notification before delayed status and cleans up stable ownership', async () => {
  const f = fixture();
  const status = deferred<Awaited<ReturnType<typeof f.client.database.status>>>();
  f.client.database.status = () => status.promise;
  const starting = f.application.start();
  expect(f.subscriptions()).toBe(1);
  f.emit({...f.first, session: 'two', version: 2});
  status.resolve({status: 'success', value: f.first});
  await starting;
  expect(f.application.getState().database?.session).toBe('two');
  const captured = f.application.captureSession('two');
  f.application.dispose();
  expect(captured.isCurrent()).toBe(false);
  expect(
    (await f.application.request('two', async () => ({status: 'success'}))).status
  ).toBe('error');
  expect(f.subscriptions()).toBe(0);
  f.emit({...f.first, session: 'three', version: 3});
  expect(f.application.getState().database?.session).toBe('two');
});

test('new same-path session clears old cache and emits once only after matching committed resolution', async () => {
  const f = fixture();
  const resets: string[] = [];
  f.application.onSessionChanged(database => {
    resets.push(database.session!);
  });
  await f.application.start();
  expect(resets).toEqual([]); // startup does not replace a nested route
  f.application.queryClient.setQueryData(customerKeys.list('one', ''), []);
  const request = {requestId: 'switch', documentId: 'document'};
  await f.getProtection().prepare(request);
  f.emit({...f.first, session: 'two', version: 2});
  expect(f.application.queryClient.getQueryData(customerKeys.list('one', ''))).toEqual(
    []
  );
  expect(resets).toEqual([]);
  f.getProtection().resolve({...request, requestId: 'obsolete', outcome: 'committed'});
  expect(resets).toEqual([]);
  f.getProtection().resolve({...request, outcome: 'committed'});
  f.emit({...f.first, session: 'two', version: 2});
  expect(resets).toEqual(['two']);
  expect(
    f.application.queryClient.getQueryData(customerKeys.list('one', ''))
  ).toBeUndefined();
  f.emit({
    available: false,
    selectedPath: f.first.selectedPath,
    session: null,
    version: 3,
  });
  expect(resets).toEqual(['two']);
});

test('session replacement waits for the file action to settle before admitting route reads', async () => {
  const f = fixture();
  await f.application.start();
  const admitted = deferred<void>();
  const release = deferred<void>();
  const next = {...f.first, session: 'two', version: 2};
  f.client.database.open = async () => {
    const request = {requestId: 'open', documentId: 'document'};
    await f.getProtection().prepare(request);
    f.emit(next);
    f.getProtection().resolve({...request, outcome: 'committed'});
    admitted.resolve();
    await release.promise;
    return {status: 'success', value: next};
  };

  const reads: Promise<unknown>[] = [];
  f.application.onSessionChanged(database => {
    reads.push(f.application.read(database.session!, async () => ({status: 'success'})));
  });
  const opening = f.application.fileAction('open');
  await admitted.promise;
  try {
    expect(reads).toHaveLength(0);
  } finally {
    release.resolve();
  }

  await opening;
  expect(reads).toHaveLength(1);
  expect(await reads[0]).toEqual({status: 'success'});
});

test('coalesces queued searches, serializes dispatch and drops prior-session success or failure', async () => {
  const f = fixture();
  await f.application.start();
  const pending = deferred<{status: 'success'; value: number}>();
  const dispatched = deferred<void>();
  const first = f.application.request('one', async () => {
    dispatched.resolve();
    return pending.promise;
  });
  await dispatched.promise;
  const calls: string[] = [];
  const oldSearch = f.application.request(
    'one',
    async () => {
      calls.push('old');
      return {status: 'success', value: []};
    },
    {coalesceKey: 'list'}
  );
  const newSearch = f.application.request(
    'one',
    async () => {
      calls.push('new');
      return {status: 'success', value: []};
    },
    {coalesceKey: 'list'}
  );
  expect(calls).toEqual([]);
  pending.resolve({status: 'success', value: 1});
  expect((await first).status).toBe('success');
  expect((await oldSearch).status).toBe('obsolete');
  expect((await newSearch).status).toBe('success');
  expect(calls).toEqual(['new']);
  for (const outcome of [
    {status: 'success', value: 2},
    {status: 'error', error: {code: 'BUSY', message: 'Busy'}},
  ]) {
    const late = deferred<typeof outcome>();
    const started = deferred<void>();
    const result = f.application.request(
      f.application.getState().database!.session!,
      async () => {
        started.resolve();
        return late.promise;
      }
    );
    await started.promise;
    const current = f.application.getState().database!;
    f.emit({
      ...current,
      session: `${current.session}-next`,
      version: current.version + 1,
    });
    late.resolve(outcome);
    expect((await result).status).toBe('obsolete');
  }
});

test('superseded in-flight query cannot cache and rejected BUSY is not retried', async () => {
  const f = fixture();
  await f.application.start();
  const late = deferred<Awaited<ReturnType<typeof f.client.customers.list>>>();
  const started = deferred<void>();
  let relevant = true;
  let calls = 0;
  f.client.customers.list = () => {
    calls++;
    started.resolve();
    return late.promise;
  };

  const result = f.application.queryClient
    .fetchQuery(
      customerListOptions(f.application, 'one', 'old', {isRelevant: () => relevant})
    )
    .catch(error => error);
  await started.promise;
  relevant = false;
  late.resolve({status: 'success', value: []});
  await result;
  expect(
    f.application.queryClient.getQueryData(customerKeys.list('one', 'old'))
  ).toBeUndefined();
  f.client.customers.list = async () => {
    calls++;
    return {status: 'error', error: {code: 'BUSY', message: 'Wait and retry.'}};
  };

  await expect(
    f.application.queryClient.fetchQuery(
      customerListOptions(f.application, 'one', 'busy')
    )
  ).rejects.toThrow('Wait and retry.');
  expect(calls).toBe(2);
});

test('gates transition immediately while admitted save settles and preserves failed or cancelled switches', async () => {
  const f = fixture();
  await f.application.start();
  const save = deferred<{status: 'success'; value: string}>();
  const admitted = deferred<void>();
  const saving = f.application.request('one', async () => {
    admitted.resolve();
    return save.promise;
  });
  await admitted.promise;
  let opened = false;
  f.client.database.open = async () => {
    opened = true;
    return {status: 'cancelled'};
  };

  const opening = f.application.transition('open');
  expect(f.application.getState().pendingTransition).toBe(true);
  expect(
    (await f.application.request('one', async () => ({status: 'success'}))).status
  ).toBe('error');
  expect(opened).toBe(false);
  save.resolve({status: 'success', value: 'saved'});
  expect((await saving).status).toBe('success');
  expect((await opening).status).toBe('cancelled');
  expect(f.application.getState().pendingTransition).toBe(false);
  expect(f.application.getState().database?.session).toBe('one');
  f.client.database.open = async () => ({
    status: 'error',
    error: {code: 'INTERNAL', message: 'Failed'},
  });
  expect((await f.application.transition('open')).status).toBe('error');
  expect(f.application.getState().database?.session).toBe('one');
});

test('reconciles unavailable errors without retrying writes or resetting retained editor state', async () => {
  const f = fixture();
  await f.application.start();
  let resets = 0;
  let calls = 0;
  f.application.onSessionChanged(() => {
    resets++;
  });
  f.client.database.status = async () => ({
    status: 'success',
    value: {
      available: false,
      selectedPath: f.first.selectedPath,
      session: null,
      version: 2,
    },
  });
  const result = await f.application.request('one', async () => {
    calls++;
    return {
      status: 'error',
      error: {code: 'DATABASE_UNAVAILABLE', message: 'Unavailable'},
    };
  });
  expect(result.status).toBe('obsolete');
  expect(f.application.getState().database?.available).toBe(false);
  expect(f.application.getState().reconciling).toBe(false);
  expect(calls).toBe(1);
  expect(resets).toBe(0);
});

test('QueryClient mutations retain backend failure state and cancel obsolete completion without success', async () => {
  const f = fixture();
  await f.application.start();
  const reference = {session: 'one', id: 1, revision: 'original'};
  let calls = 0;
  f.client.customers.delete = async () => {
    calls++;
    return {
      status: 'error',
      error: {code: 'STALE_REVISION', message: 'Saved customer changed'},
    };
  };

  const failed = f.application.queryClient
    .getMutationCache()
    .build(f.application.queryClient, deleteCustomerOptions(f.application));
  await expect(failed.execute(reference)).rejects.toThrow('Saved customer changed');
  expect(failed.state.status).toBe('error');
  expect(calls).toBe(1);
  const late = deferred<Awaited<ReturnType<typeof f.client.customers.delete>>>();
  const started = deferred<void>();
  f.client.customers.delete = () => {
    started.resolve();
    return late.promise;
  };

  let success = false;
  const mutation = f.application.queryClient
    .getMutationCache()
    .build(f.application.queryClient, {
      ...deleteCustomerOptions(f.application),
      onSuccess: () => {
        success = true;
      },
    });
  const result = mutation.execute(reference).catch(error => error);
  await started.promise;
  f.emit({...f.first, session: 'two', version: 2});
  late.resolve({status: 'success', value: {deleted: true}});
  expect(isCancelledError(await result)).toBe(true);
  expect(success).toBe(false);
});

test('failed status reconciliation keeps customer requests gated until explicit successful recovery', async () => {
  const f = fixture();
  await f.application.start();
  f.client.database.status = async () => ({
    status: 'error',
    error: {code: 'INTERNAL', message: 'Status failed'},
  });
  const stale = deferred<{
    status: 'error';
    error: {code: 'STALE_SESSION'; message: string};
  }>();
  const started = deferred<void>();
  const firstRequest = f.application.request('one', async () => {
    started.resolve();
    return stale.promise;
  });
  await started.promise;
  let queuedDispatched = false;
  const queued = f.application.request('one', async () => {
    queuedDispatched = true;
    return {status: 'success'};
  });
  stale.resolve({
    status: 'error',
    error: {code: 'STALE_SESSION', message: 'Session changed'},
  });
  await firstRequest;
  expect((await queued).status).toBe('error');
  expect(queuedDispatched).toBe(false);
  expect(f.application.getState().reconciling).toBe(false);
  expect(f.application.getState().recoveryRequired).toBe(true);
  let dispatched = false;
  const blocked = await f.application.request('one', async () => {
    dispatched = true;
    return {status: 'success'};
  });
  expect(blocked.status).toBe('error');
  expect(dispatched).toBe(false);
  f.client.database.status = async () => ({status: 'success', value: f.first});
  await f.application.reconcile();
  expect(f.application.getState().recoveryRequired).toBe(false);
  expect(
    (await f.application.request('one', async () => ({status: 'success'}))).status
  ).toBe('success');
});

test('protected customer replacement permits only its coordinated get and suppresses old-session adoption', async () => {
  const f = fixture();
  await f.application.start();
  const preview = createPreviewClient();
  const previewState = await preview.database.status();
  if (previewState.status !== 'success') {
    throw new Error('Fixture state failed');
  }

  const created = await preview.customers.create({
    session: previewState.value.session!,
    values: {
      firstName: 'Saved',
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
    throw new Error('Fixture create failed');
  }

  const read = deferred<Awaited<ReturnType<typeof f.client.customers.get>>>();
  f.client.customers.get = () => read.promise;
  let draft = 'Draft';
  f.application.protection.registerEditor({
    values: () => ({name: draft}),
    baseline: () => ({name: 'Saved'}),
    reset: () => {
      draft = 'Reset';
    },
  });
  f.client.drafts.confirmDiscard = async () => ({
    status: 'success',
    value: {approved: true},
  });
  let adopted = false;
  const replacement = f.application.reloadCustomer(
    {session: 'one', id: created.value.customer.id},
    () => {
      adopted = true;
    }
  );
  await Promise.resolve();
  expect(f.application.protection.getState().frozen).toBe(true);
  expect(
    (
      await f.application.request('one', client =>
        client.customers.delete({reference: created.value.reference})
      )
    ).status
  ).toBe('error');
  f.emit({...f.first, version: 2, session: 'two'});
  read.resolve({status: 'success', value: created.value});
  await expect(replacement).rejects.toSatisfy(isCancelledError);
  expect(adopted).toBe(false);
  expect(draft).toBe('Draft');
  expect(f.application.protection.getState().frozen).toBe(false);
  f.application.dispose();
});

test('saved file operations gate customer dispatch and retain session while their held result settles', async () => {
  const client = createPreviewClient();
  const held = deferred<{status: 'success'; value: {path: string}}>();
  const toastManager = Toast.createToastManager();
  const notify = vi.spyOn(toastManager, 'add');
  client.database.backup = () => held.promise;
  const application = createApplication('http://localhost/?preview=true', false, {
    client,
    toastManager,
  });
  await application.start();
  const before = application.getState().database;
  if (!before?.session) {
    throw new Error('Missing session');
  }

  const saving = application.fileAction('backup');
  expect(application.getState().pendingFile).toBe('backup');
  const read = await application.request(before.session, client =>
    client.customers.list({session: before.session!, query: ''})
  );
  expect(read).toMatchObject({status: 'error', error: {code: 'BUSY'}});
  held.resolve({status: 'success', value: {path: 'Preview: backup.sqlite'}});
  await saving;
  expect(application.getState().database).toEqual(before);
  expect(application.getState().pendingFile).toBeNull();
  expect(notify).toHaveBeenCalledExactlyOnceWith({
    id: 'database-feedback',
    type: 'success',
    priority: 'low',
    timeout: 5000,
    title: 'Backup saved. Preview: backup.sqlite',
  });
  application.dispose();
});

test('saved-file failures cannot paint a replacement session accepted during reconciliation', async () => {
  const f = fixture();
  const notify = vi.spyOn(f.toastManager, 'add');
  await f.application.start();
  const status = deferred<Awaited<ReturnType<typeof f.client.database.status>>>();
  const reconciling = deferred<void>();
  f.client.database.status = () => {
    reconciling.resolve();
    return status.promise;
  };

  f.client.database.backup = async () => ({
    status: 'error',
    error: {code: 'STALE_SESSION', message: 'Old backup failure'},
  });
  const backup = f.application.fileAction('backup');
  await reconciling.promise;
  f.emit({...f.first, session: 'two', version: 2});
  status.resolve({status: 'success', value: {...f.first, session: 'two', version: 2}});
  await backup;
  expect(f.application.getState().database?.session).toBe('two');
  expect(notify).not.toHaveBeenCalled();
  expect(f.application.getState().pendingFile).toBeNull();
  f.application.dispose();
});
