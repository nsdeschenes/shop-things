import type {DatabaseState, DraftProtection} from '@shop-things/contract';
import {isCancelledError} from '@tanstack/react-query';
import {expect, test} from 'vitest';

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

  const application = createApplication('http://localhost', true, {client});
  return {
    application,
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
