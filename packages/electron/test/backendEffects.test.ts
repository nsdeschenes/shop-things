import type {DraftRequest, DraftResolution} from '@shop-things/contract';
import {Effect, Fiber} from 'effect';
import {expect, test} from 'vitest';

import {databaseOperations} from '../src/actionService.js';
import {Backend} from '../src/backend.js';
import {DraftCoordinator} from '../src/draftCoordinator.js';
import {native, runBoundary} from '../src/effectBoundary.js';
import {fixture, success, values} from './backendFixture.js';

test('interruption drains a started native query before releasing admission or closing its database', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let closed = false;
  const backend = new Backend({
    ...f.options,
    database: {
      ...databaseOperations,
      createDatabase: async (...args) => {
        const handle = await databaseOperations.createDatabase(...args);
        return {
          ...handle,
          close() {
            closed = true;
            handle.close();
          },
        };
      },
      listCustomers: async (...args) => {
        entered.resolve();
        await release.promise;
        expect(closed).toBe(false);
        return databaseOperations.listCustomers(...args);
      },
    },
  });
  try {
    const state = success(await Effect.runPromise(backend.handlers['database.create']()));
    const read = Effect.runFork(
      backend.handlers['customers.list']({session: state.session!, query: ''})
    );
    await entered.promise;
    const interrupted = Effect.runPromise(Fiber.interrupt(read));
    const closing = Effect.runPromise(backend.closeUnprotectedWhenIdle());
    expect(closed).toBe(false);
    expect(
      await Effect.runPromise(
        backend.handlers['customers.create']({session: state.session!, values})
      )
    ).toMatchObject({status: 'error', error: {code: 'BUSY'}});
    release.resolve();
    await interrupted;
    await closing;
    expect(closed).toBe(true);
    expect(backend.status()).toMatchObject({available: false, session: null});
  } finally {
    release.resolve();
    backend.closeUnprotected();
    await f.cleanup();
  }
});

test('interruption waits for persisted candidate selection and publication before finalizing admission', async () => {
  const f = await fixture();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let closed = 0;
  const backend = new Backend({
    ...f.options,
    settings: {
      read: () => f.settings.read(),
      write: async path => {
        entered.resolve();
        await release.promise;
        await f.settings.write(path);
      },
    },
    database: {
      ...databaseOperations,
      createDatabase: async (...args) => {
        const handle = await databaseOperations.createDatabase(...args);
        return {
          ...handle,
          close() {
            closed++;
            handle.close();
          },
        };
      },
    },
  });
  try {
    const selecting = Effect.runFork(backend.handlers['database.create']());
    await entered.promise;
    const interrupted = Effect.runPromise(Fiber.interrupt(selecting));
    expect(backend.status().available).toBe(false);
    expect(closed).toBe(0);
    release.resolve();
    await interrupted;
    expect(backend.status()).toMatchObject({
      available: true,
      selectedPath: f.choices.create,
    });
    expect(await f.settings.read()).toBe(f.choices.create);
    expect(closed).toBe(0);
    backend.closeUnprotected();
    expect(closed).toBe(1);
  } finally {
    release.resolve();
    backend.closeUnprotected();
    await f.cleanup();
  }
});

test('interrupted draft preparation resolves the correlated document once and allows another lease', async () => {
  const drafts = new DraftCoordinator();
  const requests: DraftRequest[] = [];
  const resolutions: DraftResolution[] = [];
  const participant = {
    documentId: 'document',
    prepare(request: DraftRequest) {
      requests.push(request);
    },
    resolve(resolution: DraftResolution) {
      resolutions.push(resolution);
    },
  };
  drafts.register(participant);
  const preparation = Effect.runFork(drafts.prepareEffect());
  await Effect.runPromise(Fiber.interrupt(preparation));
  expect(resolutions).toEqual([{...requests[0], outcome: 'aborted'}]);
  expect(drafts.reply(participant, {...requests[0], hasUnsavedDraft: true})).toBe(false);
  participant.prepare = request => {
    requests.push(request);
    drafts.reply(participant, {...request, hasUnsavedDraft: true});
  };

  const lease = await Effect.runPromise(drafts.prepareEffect());
  expect(lease.hasUnsavedDraft).toBe(true);
  drafts.register({...participant, documentId: 'replacement'});
  expect(() => lease.assertCurrent()).toThrow('The prepared editor document changed');
  lease.finish('committed');
  expect(resolutions).toEqual([
    {...requests[0], outcome: 'aborted'},
    {...requests[1], outcome: 'aborted'},
  ]);
});

test('the Promise boundary preserves the immediate native rejection object', async () => {
  const original = new Error('native diagnostic');
  await expect(runBoundary(native(() => Promise.reject(original)))).rejects.toBe(
    original
  );
});

test('candidate cleanup failure keeps its precedence and immediate diagnostic identity', async () => {
  const f = await fixture();
  const persistError = new Error('settings write failed');
  const closeError = new Error('candidate close failed');
  const errors: unknown[] = [];
  let closed = 0;
  const backend = new Backend({
    ...f.options,
    settings: {
      read: async () => null,
      write: async () => {
        throw persistError;
      },
    },
    logError: error => {
      errors.push(error);
    },
    database: {
      ...databaseOperations,
      createDatabase: async (...args) => {
        const handle = await databaseOperations.createDatabase(...args);
        return {
          ...handle,
          close() {
            closed++;
            handle.close();
            throw closeError;
          },
        };
      },
    },
  });
  try {
    expect(await Effect.runPromise(backend.handlers['database.create']())).toMatchObject({
      status: 'error',
      error: {code: 'INTERNAL'},
    });
    expect(closed).toBe(1);
    expect(backend.status()).toMatchObject({available: false, session: null});
    expect(errors).toEqual([closeError, closeError]);
    expect(
      await Effect.runPromise(
        backend.handlers['customers.list']({session: 'obsolete', query: ''})
      )
    ).toMatchObject({status: 'error', error: {code: 'DATABASE_UNAVAILABLE'}});
  } finally {
    backend.closeUnprotected();
    await f.cleanup();
  }
});

test('an immediately failing action retains admission through the same turn', async () => {
  const f = await fixture();
  try {
    const first = f.service.handlers['customers.list']({session: 'obsolete', query: ''});
    const concurrent = f.service.handlers['customers.list']({
      session: 'obsolete',
      query: '',
    });
    expect(await concurrent).toMatchObject({status: 'error', error: {code: 'BUSY'}});
    expect(await first).toMatchObject({
      status: 'error',
      error: {code: 'DATABASE_UNAVAILABLE'},
    });
    expect(
      await f.service.handlers['customers.list']({session: 'obsolete', query: ''})
    ).toMatchObject({status: 'error', error: {code: 'DATABASE_UNAVAILABLE'}});
  } finally {
    await f.cleanup();
  }
});

test.each(['close', 'reload', 'unprotected'] as const)(
  'idle %s retains lifecycle admission through the same turn',
  async kind => {
    const f = await fixture();
    f.choices.create = null;
    try {
      const closing = {
        close: () => f.service.requestClose(),
        reload: () => f.service.requestReload(() => {}),
        unprotected: () => f.service.closeUnprotectedWhenIdle(),
      }[kind]();
      expect(await f.service.handlers['database.create']()).toMatchObject({
        status: 'error',
        error: {code: 'BUSY'},
      });
      await closing;
      expect(await f.service.handlers['database.create']()).toEqual({
        status: 'cancelled',
      });
    } finally {
      await f.cleanup();
    }
  }
);
