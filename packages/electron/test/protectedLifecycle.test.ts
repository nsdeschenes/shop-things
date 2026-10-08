import type {DraftRequest, DraftResolution} from '@shop-things/contract';
import {getCustomer, openExistingDatabase, createDatabase} from '@shop-things/db';
import {expect, test} from 'vitest';

import {ActionService, databaseOperations} from '../src/actionService.js';
import {DraftCoordinator} from '../src/draftCoordinator.js';
import {fixture, migrationsFolder, success, values} from './backendFixture.js';

function simulatedEditor(coordinator: DraftCoordinator) {
  const editor = {
    frozen: false,
    draft: '',
    selection: 1 as number | null,
    requests: [] as DraftRequest[],
    resolutions: [] as DraftResolution[],
    respond: true,
    dirty: false,
  };
  const participant = {
    documentId: 'document-1',
    prepare(request: DraftRequest) {
      editor.frozen = true;
      editor.requests.push(request);
      if (editor.respond) {
        coordinator.reply(participant, {...request, hasUnsavedDraft: editor.dirty});
      }
    },
    resolve(resolution: DraftResolution) {
      editor.resolutions.push(resolution);
      editor.frozen = false;
      if (resolution.outcome === 'committed') {
        editor.draft = '';
        editor.selection = null;
      }
    },
  };
  const unregister = coordinator.register(participant);
  return {
    editor,
    participant,
    unregister,
    edit() {
      editor.dirty = true;
      editor.draft = 'unsaved';
      editor.selection = 1;
      editor.requests = [];
      editor.resolutions = [];
    },
  };
}

test('protected switch/reopen rotates sessions while failure after discard preserves selection and draft', async () => {
  const drafts = new DraftCoordinator();
  const participant = simulatedEditor(drafts);
  const f = await fixture({drafts});
  try {
    const original = success(await f.service.handlers['database.create']());
    participant.edit();
    const record = success(
      await f.service.handlers['customers.create']({session: original.session!, values})
    );
    f.choices.open = f.choices.create;
    f.choices.discard = false;
    expect(await f.service.handlers['database.open']()).toEqual({status: 'cancelled'});
    expect(f.service.status()).toEqual(original);
    expect(participant.editor).toMatchObject({
      frozen: false,
      draft: 'unsaved',
      selection: 1,
    });
    f.choices.discard = true;
    f.choices.open = '/missing/candidate.db';
    expect(await f.service.handlers['database.open']()).toMatchObject({status: 'error'});
    expect(f.service.status()).toEqual(original);
    expect(
      success(
        await f.service.handlers['customers.get']({session: original.session!, id: 1})
      )
    ).toEqual(record);
    expect(participant.editor.resolutions.every(r => r.outcome === 'aborted')).toBe(true);
    expect(participant.editor.draft).toBe('unsaved');
    f.choices.open = f.choices.create;
    const reopened = success(await f.service.handlers['database.retry']());
    expect(reopened.session).not.toBe(original.session);
    expect(participant.editor).toMatchObject({frozen: false, draft: '', selection: null});
    const otherPath = f.directory + '/other.db';
    const other = await createDatabase(otherPath, {migrationsFolder});
    await databaseOperations.createCustomer(other.db, {firstName: 'Other'});
    other.close();
    f.choices.open = otherPath;
    const switched = success(await f.service.handlers['database.open']());
    expect(switched.selectedPath).toBe(otherPath);
    expect(await f.settings.read()).toBe(otherPath);
    for (const invoke of [
      () => f.service.handlers['customers.list']({session: original.session!, query: ''}),
      () => f.service.handlers['customers.get']({session: original.session!, id: 1}),
      () => f.service.handlers['customers.create']({session: original.session!, values}),
      () =>
        f.service.handlers['customers.update']({
          reference: record.reference,
          changes: {firstName: 'Wrong'},
        }),
      () => f.service.handlers['customers.delete']({reference: record.reference}),
    ]) {
      expect(await invoke()).toMatchObject({
        status: 'error',
        error: {code: 'STALE_SESSION'},
      });
    }

    expect(
      success(
        await f.service.handlers['customers.get']({session: switched.session!, id: 1})
      ).customer.firstName
    ).toBe('Other');
  } finally {
    participant.unregister();
    await f.cleanup();
  }
});

test('timeout, malformed, missing and failing preparation safely abort and correlation rejects late replies', async () => {
  const drafts = new DraftCoordinator(15);
  const participant = simulatedEditor(drafts);
  const f = await fixture({drafts});
  try {
    const original = success(await f.service.handlers['database.create']());
    participant.edit();
    f.choices.open = f.choices.create;
    participant.editor.respond = false;
    expect(await f.service.handlers['database.open']()).toMatchObject({status: 'error'});
    expect(participant.editor.frozen).toBe(false);
    expect(f.service.status()).toEqual(original);
    const late = participant.editor.requests[0]!;
    const call = f.service.handlers['database.open']();
    await Promise.resolve();
    const current = participant.editor.requests[1]!;
    expect(drafts.reply(participant.participant, {...late, hasUnsavedDraft: false})).toBe(
      false
    );
    expect(
      drafts.reply({...participant.participant}, {...current, hasUnsavedDraft: false})
    ).toBe(false);
    expect(
      drafts.reply(participant.participant, {
        ...current,
        documentId: 'wrong',
        hasUnsavedDraft: false,
      })
    ).toBe(false);
    expect(
      drafts.reply(participant.participant, {...current, hasUnsavedDraft: false})
    ).toBe(true);
    expect(
      drafts.reply(participant.participant, {...current, hasUnsavedDraft: false})
    ).toBe(false);
    success(await call);
    const invalid = f.service.handlers['database.open']();
    await Promise.resolve();
    expect(
      drafts.reply(participant.participant, {
        ...participant.editor.requests[2],
        hasUnsavedDraft: 'not boolean',
      })
    ).toBe(false);
    expect(await invalid).toMatchObject({status: 'error'});
    participant.unregister();
    expect(await f.service.handlers['database.open']()).toMatchObject({status: 'error'});
    drafts.register({
      documentId: 'bad',
      prepare() {
        throw new Error('renderer failed');
      },
      resolve() {},
    });
    expect(await f.service.handlers['database.open']()).toMatchObject({status: 'error'});
  } finally {
    await f.cleanup();
  }
});

test('pending close blocks admissions, waits active work, then aborts or closes after draft confirmation', async () => {
  const drafts = new DraftCoordinator();
  const participant = simulatedEditor(drafts);
  const f = await fixture({drafts});
  let release!: () => void;
  let reached!: () => void;
  const wait = new Promise<void>(done => {
    release = done;
  });
  const started = new Promise<void>(done => {
    reached = done;
  });
  const service = new ActionService({
    ...f.options,
    database: {
      ...databaseOperations,
      listCustomers: async (...args) => {
        reached();
        await wait;
        return databaseOperations.listCustomers(...args);
      },
    },
  });
  try {
    const state = success(await service.handlers['database.create']());
    participant.edit();
    const operation = service.handlers['customers.list']({
      session: state.session!,
      query: '',
    });
    await started;
    f.choices.discard = false;
    const close = service.requestClose();
    expect(service.requestClose()).toBe(close);
    expect(
      await service.handlers['customers.create']({session: state.session!, values})
    ).toMatchObject({status: 'error', error: {code: 'BUSY'}});
    expect(participant.editor.requests).toHaveLength(0);
    expect(success(await service.handlers['database.status']())).toEqual(state);
    release();
    await operation;
    expect(await close).toEqual({status: 'cancelled'});
    expect(service.status()).toEqual(state);
    expect(participant.editor.draft).toBe('unsaved');
    success(
      await service.handlers['customers.create']({session: state.session!, values})
    );
    f.choices.discard = true;
    expect(success(await service.requestClose())).toEqual({closed: true});
    expect(service.status().available).toBe(false);
    const reopened = await openExistingDatabase(state.selectedPath!, {migrationsFolder});
    try {
      expect((await getCustomer(reopened.db, 1))?.firstName).toBe('Anne');
    } finally {
      reopened.close();
    }
  } finally {
    release();
    service.closeUnprotected();
    participant.unregister();
    await f.cleanup();
  }
});

test('document replacement during candidate migration closes candidate and preserves the active session', async () => {
  const drafts = new DraftCoordinator();
  const participant = simulatedEditor(drafts);
  const f = await fixture({drafts});
  let candidateClosed = false;
  const service = new ActionService({
    ...f.options,
    database: {
      ...databaseOperations,
      openExistingDatabase: async (...args) => {
        const candidate = await databaseOperations.openExistingDatabase(...args);
        participant.unregister();
        return {
          ...candidate,
          close() {
            candidateClosed = true;
            candidate.close();
          },
        };
      },
    },
  });
  try {
    const state = success(await service.handlers['database.create']());
    participant.edit();
    f.choices.open = f.choices.create;
    expect(await service.handlers['database.open']()).toMatchObject({status: 'error'});
    expect(candidateClosed).toBe(true);
    expect(service.status()).toEqual(state);
    expect(await f.settings.read()).toBe(state.selectedPath);
    expect(participant.editor).toMatchObject({
      frozen: false,
      draft: 'unsaved',
      selection: 1,
    });
  } finally {
    service.closeUnprotected();
    await f.cleanup();
  }
});

test('close preparation timeout and discard dialog failure keep the connection and draft open', async () => {
  const drafts = new DraftCoordinator(10);
  const participant = simulatedEditor(drafts);
  const f = await fixture({drafts});
  try {
    const state = success(await f.service.handlers['database.create']());
    participant.edit();
    participant.editor.respond = false;
    expect(await f.service.requestClose()).toMatchObject({status: 'error'});
    expect(f.service.status()).toEqual(state);
    expect(participant.editor).toMatchObject({
      draft: 'unsaved',
      frozen: false,
      selection: 1,
    });
    participant.editor.respond = true;
    f.options.dialogs.confirmDiscard = async () => {
      throw new Error('Native confirmation failed');
    };

    expect(await f.service.requestClose()).toMatchObject({status: 'error'});
    expect(f.service.status()).toEqual(state);
    success(
      await f.service.handlers['customers.create']({session: state.session!, values})
    );
    expect(participant.editor.draft).toBe('unsaved');
    expect(await f.service.handlers['drafts.confirmDiscard']()).toMatchObject({
      status: 'error',
    });
  } finally {
    participant.unregister();
    await f.cleanup();
  }
});

test('editor discard approval permits navigation without clearing draft before navigation commits', async () => {
  const drafts = new DraftCoordinator();
  const participant = simulatedEditor(drafts);
  participant.edit();
  const f = await fixture({drafts});
  try {
    f.choices.discard = false;
    expect(await f.service.handlers['drafts.confirmDiscard']()).toEqual({
      status: 'cancelled',
    });
    f.choices.discard = true;
    expect(success(await f.service.handlers['drafts.confirmDiscard']())).toEqual({
      approved: true,
    });
    expect(participant.editor).toMatchObject({
      draft: 'unsaved',
      selection: 1,
      frozen: false,
    });
    expect(participant.editor.requests).toEqual([]);
  } finally {
    participant.unregister();
    await f.cleanup();
  }
});

test('guarded reload preserves database/session and aborted scheduling retains draft', async () => {
  const drafts = new DraftCoordinator();
  const participant = simulatedEditor(drafts);
  const f = await fixture({drafts});
  try {
    const state = success(await f.service.handlers['database.create']());
    participant.edit();
    let reloads = 0;
    f.choices.discard = false;
    expect(
      await f.service.requestReload(() => {
        reloads++;
      })
    ).toEqual({status: 'cancelled'});
    expect(reloads).toBe(0);
    expect(f.service.status()).toEqual(state);
    expect(participant.editor.draft).toBe('unsaved');
    f.choices.discard = true;
    expect(
      await f.service.requestReload(() => {
        throw new Error('Could not schedule reload');
      })
    ).toMatchObject({status: 'error'});
    expect(participant.editor.draft).toBe('unsaved');
    expect(participant.editor.resolutions.at(-1)?.outcome).toBe('aborted');
    expect(
      success(
        await f.service.requestReload(() => {
          reloads++;
        })
      )
    ).toEqual({reloaded: true});
    expect(reloads).toBe(1);
    expect(f.service.status()).toEqual(state);
    expect(participant.editor.resolutions.at(-1)?.outcome).toBe('committed');
  } finally {
    participant.unregister();
    await f.cleanup();
  }
});

test('recovery with no active database still requires explicit participant and protects retained draft', async () => {
  const drafts = new DraftCoordinator();
  const f = await fixture({drafts});
  try {
    expect(await f.service.handlers['database.create']()).toMatchObject({
      status: 'error',
    });
    expect(f.service.status().available).toBe(false);
    const participant = simulatedEditor(drafts);
    participant.edit();
    f.choices.discard = false;
    expect(await f.service.handlers['database.create']()).toEqual({status: 'cancelled'});
    expect(participant.editor.draft).toBe('unsaved');
    expect(f.service.status().available).toBe(false);
    f.choices.discard = true;
    success(await f.service.handlers['database.create']());
    expect(participant.editor.resolutions.at(-1)?.outcome).toBe('committed');
    participant.unregister();
  } finally {
    await f.cleanup();
  }
});

test('held lifecycle defers discard, rejects admissions and restores the same session on abort', async () => {
  const drafts = new DraftCoordinator();
  const participant = simulatedEditor(drafts);
  const f = await fixture({drafts});
  try {
    const state = success(await f.service.handlers['database.create']());
    success(
      await f.service.handlers['customers.create']({session: state.session!, values})
    );
    participant.edit();
    const lease = success(await f.service.holdLifecycle());
    expect(participant.editor).toMatchObject({frozen: true, draft: 'unsaved'});
    expect(participant.editor.resolutions).toEqual([]);
    expect(await f.service.holdLifecycle()).toMatchObject({
      status: 'error',
      error: {code: 'BUSY'},
    });
    expect(await f.service.requestClose()).toMatchObject({
      status: 'error',
      error: {code: 'BUSY'},
    });
    expect(
      await f.service.handlers['customers.create']({session: state.session!, values})
    ).toMatchObject({status: 'error', error: {code: 'BUSY'}});
    expect(success(await lease.abort()).session).toBe(state.session);
    expect(participant.editor).toMatchObject({frozen: false, draft: 'unsaved'});
    expect(
      success(await f.service.handlers['customers.get']({session: state.session!, id: 1}))
        .customer.firstName
    ).toBe('Anne');
    const next = success(await f.service.holdLifecycle());
    expect(await lease.abort()).toMatchObject({status: 'error'});
    expect(participant.editor.frozen).toBe(true);
    expect(success(await next.commit())).toEqual({closed: true});
    expect(participant.editor).toMatchObject({frozen: false, draft: ''});
    expect(f.service.status().available).toBe(false);
  } finally {
    participant.unregister();
    await f.cleanup();
  }
});

test('stale document cannot release a held lease and failed reopen exposes retained-draft recovery', async () => {
  const drafts = new DraftCoordinator();
  const participant = simulatedEditor(drafts);
  const f = await fixture({drafts});
  try {
    const state = success(await f.service.handlers['database.create']());
    participant.edit();
    const lease = success(await f.service.holdLifecycle());
    participant.unregister();
    expect(() => lease.assertCurrent()).toThrow('document changed');
    expect(await lease.commit()).toMatchObject({status: 'error'});
    expect(
      await f.service.handlers['customers.list']({session: state.session!, query: ''})
    ).toMatchObject({status: 'error', error: {code: 'BUSY'}});
    success(await lease.abort());
    expect(
      await f.service.handlers['customers.list']({session: state.session!, query: ''})
    ).toMatchObject({status: 'success'});
    expect(participant.editor.draft).toBe('unsaved');
    drafts.register(participant.participant);
    const next = success(await f.service.holdLifecycle());
    // Remove the selected file after closing its only connection.
    const {rename} = await import('node:fs/promises');
    await rename(state.selectedPath!, state.selectedPath! + '.saved');
    expect(await next.abort()).toMatchObject({
      status: 'error',
      error: {code: 'DATABASE_UNAVAILABLE'},
    });
    expect(f.service.status()).toMatchObject({
      available: false,
      session: null,
      recoveryError: {code: 'DATABASE_UNAVAILABLE'},
    });
    expect(participant.editor).toMatchObject({frozen: false, draft: 'unsaved'});
    await rename(state.selectedPath! + '.saved', state.selectedPath!);
    success(await f.service.handlers['database.retry']());
  } finally {
    participant.unregister();
    await f.cleanup();
  }
});
