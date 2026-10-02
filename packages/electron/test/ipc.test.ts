import {createClient, applyNewerDatabaseState} from '@shop-things/contract/client';
import {actions} from '@shop-things/contract/schemas';
import {expect, test} from 'vitest';

import {ActionService} from '../src/actionService.js';
import {DraftCoordinator} from '../src/draftCoordinator.js';
import {registerIpc} from '../src/ipc.js';
import type {ApprovedDocument, IpcSender, MainIpc} from '../src/ipc.js';
import {controls} from '../src/ipcWire.js';
import {createPreloadBridge} from '../src/preloadBridge.js';
const editorFailure = /editor/;
import type {DraftRequest, DatabaseState} from '@shop-things/contract';

function fixture() {
  const handlers = new Map<
    string,
    (event: IpcSender, ...payloads: unknown[]) => unknown
  >();
  const mainListeners = new Map<
    string,
    (event: IpcSender, ...payloads: unknown[]) => void
  >();
  const rendererListeners = new Map<
    string,
    Set<(event: unknown, payload: unknown) => void>
  >();
  const changes = new Set<() => void>();
  const frame = {url: 'http://127.0.0.1:5173/'};
  const sent: {channel: string; payload: unknown}[] = [];
  const rawEvent = {sender: 'private Electron event'};
  const sender = {
    mainFrame: frame,
    isDestroyed: () => false,
    send(channel: string, payload: unknown) {
      sent.push({channel, payload});
      for (const listener of rendererListeners.get(channel) ?? []) {
        listener(rawEvent, payload);
      }
    },
  };
  let document: ApprovedDocument | null = {
    documentId: 'document-1',
    frame,
    url: frame.url,
    webContents: sender,
  };
  const event: IpcSender = {sender, senderFrame: frame};
  const ipc: MainIpc = {
    handle: (channel, listener) => {
      handlers.set(channel, listener);
    },
    removeHandler: channel => {
      handlers.delete(channel);
    },
    on: (channel, listener) => {
      mainListeners.set(channel, listener);
    },
    removeListener: channel => {
      mainListeners.delete(channel);
    },
  };
  const drafts = new DraftCoordinator(100);
  const service = new ActionService({
    migrationsFolder: 'unused',
    settings: {read: async () => null, write: async () => {}},
    dialogs: {
      createDatabase: async () => null,
      openDatabase: async () => null,
      importCsv: async () => null,
      exportCsv: async () => null,
      backupDatabase: async () => null,
      restoreSource: async () => null,
      restoreDestination: async () => null,
      confirmDiscard: async () => true,
    },
    drafts,
  });
  const stop = registerIpc({
    ipc,
    service,
    drafts,
    currentDocument: () => document,
    onDocumentChanged(callback) {
      changes.add(callback);
      return () => {
        changes.delete(callback);
      };
    },
  });
  async function invoke(channel: string, ...payloads: unknown[]) {
    const handler = handlers.get(channel);
    if (!handler) {
      throw new Error('Missing test handler');
    }

    return handler(event, ...payloads);
  }

  function send(channel: string, payload: unknown) {
    mainListeners.get(channel)?.(event, payload);
  }

  const renderer = {
    invoke,
    send,
    on(channel: string, callback: (event: unknown, payload: unknown) => void) {
      const listeners = rendererListeners.get(channel) ?? new Set();
      listeners.add(callback);
      rendererListeners.set(channel, listeners);
    },
    removeListener(
      channel: string,
      callback: (event: unknown, payload: unknown) => void
    ) {
      rendererListeners.get(channel)?.delete(callback);
    },
  };
  return {
    handlers,
    mainListeners,
    rendererListeners,
    changes,
    frame,
    sender,
    sent,
    event,
    service,
    drafts,
    stop,
    invoke,
    send,
    renderer,
    invalidate() {
      document = null;
      for (const callback of changes) {
        callback();
      }
    },
    replaceDocument() {
      document = {documentId: 'document-2', frame, url: frame.url, webContents: sender};
      for (const callback of changes) {
        callback();
      }
    },
  };
}

async function settle() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
}

test('complete named action surface denies wrong sender/frame/document and malformed input before service', async () => {
  const f = fixture();
  let calls = 0;
  const original = f.service.handlers['customers.list'];
  f.service.handlers['customers.list'] = async args => {
    calls++;
    return original(args);
  };

  expect(f.handlers.size).toBe(Object.keys(actions).length + 3);
  const payload = {documentId: 'document-1', arguments: {session: 's', query: ''}};
  for (const event of [
    {sender: {}, senderFrame: f.frame},
    {sender: f.sender, senderFrame: {}},
    {sender: f.sender, senderFrame: null},
  ]) {
    expect(
      await f.handlers.get('shop-things:customers.list')?.(event, payload)
    ).toMatchObject({
      status: 'error',
      error: {code: 'UNAUTHORIZED'},
    });
  }

  f.frame.url = 'http://evil.invalid/';
  expect(await f.invoke('shop-things:customers.list', payload)).toMatchObject({
    error: {code: 'UNAUTHORIZED'},
  });
  f.frame.url = 'http://127.0.0.1:5173/';
  expect(
    await f.invoke('shop-things:customers.list', {...payload, documentId: 'old'})
  ).toMatchObject({error: {code: 'UNAUTHORIZED'}});
  expect(
    await f.invoke('shop-things:customers.list', {
      ...payload,
      arguments: {session: 's', query: '', sql: 'drop'},
    })
  ).toMatchObject({error: {code: 'VALIDATION'}});
  expect(await f.invoke('shop-things:customers.list', payload, 'extra')).toMatchObject({
    error: {code: 'VALIDATION'},
  });
  expect(calls).toBe(0);
  expect(await f.invoke('shop-things:customers.list', payload)).toMatchObject({
    error: {code: 'DATABASE_UNAVAILABLE'},
  });
  expect(calls).toBe(1);
  f.replaceDocument();
  expect(await f.invoke('shop-things:customers.list', payload)).toMatchObject({
    error: {code: 'UNAUTHORIZED'},
  });
  expect(calls).toBe(1);
  f.stop();
  expect(f.handlers.size).toBe(0);
  expect(f.mainListeners.size).toBe(0);
  expect(f.changes.size).toBe(0);
});
test('malformed serialized results and thrown native errors become safe outcomes', async () => {
  const f = fixture();
  Reflect.set(f.service.handlers, 'customers.list', async () => ({
    status: 'success',
    value: [{privateRow: true}],
  }));
  const result = await f.invoke('shop-things:customers.list', {
    documentId: 'document-1',
    arguments: {session: 's', query: ''},
  });
  expect(result).toEqual({
    status: 'error',
    error: {code: 'INTERNAL', message: 'The application could not complete the request.'},
  });
  Reflect.set(f.service.handlers, 'customers.list', async () => {
    throw new Error('native stack/database path');
  });
  expect(
    await f.invoke('shop-things:customers.list', {
      documentId: 'document-1',
      arguments: {session: 's', query: ''},
    })
  ).toEqual(result);
  f.stop();
});
test('injected named bridge validates payload-only versioned state and removes subscriptions', async () => {
  const f = fixture();
  const client = createClient(createPreloadBridge(f.renderer, () => 'subscription'));
  let state: DatabaseState | null = null;
  const stop = client.database.onStateChanged(incoming => {
    state = applyNewerDatabaseState(state, incoming);
  });
  await settle();
  const initial = await client.database.status();
  f.service.closeUnprotected();
  expect(state).toMatchObject({version: 1});
  if (initial.status === 'success') {
    state = applyNewerDatabaseState(state, initial.value);
  }

  expect(state).toMatchObject({version: 1});
  f.sender.send(controls.stateChanged, {
    subscriptionId: 'subscription',
    state: {available: 'invalid'},
  });
  expect(state).toMatchObject({version: 1});
  stop();
  await settle();
  expect(f.rendererListeners.get(controls.stateChanged)?.size).toBe(0);
  const count = f.sent.length;
  f.service.closeUnprotected();
  expect(f.sent.length).toBe(count);
  f.stop();
});
test('draft controls bypass admission and enforce document/registration/request correlation', async () => {
  const f = fixture();
  f.send(controls.draftRegister, {
    documentId: 'document-1',
    registrationId: 'registration',
  });
  const preparation = f.drafts.prepare();
  const requestValue = f.sent.find(
    entry => entry.channel === controls.draftPrepare
  )?.payload;
  if (
    typeof requestValue !== 'object' ||
    requestValue === null ||
    !('request' in requestValue)
  ) {
    throw new Error('No preparation request');
  }

  const request = requestValue.request;
  // Test malformed/unauthorized boundary payloads against a real pending coordinator.
  const {draftRequestSchema} = await import('@shop-things/contract/schemas');
  const parsed: DraftRequest = draftRequestSchema.parse(request);
  const reply = {...parsed, hasUnsavedDraft: true};
  f.mainListeners.get(controls.draftReply)?.(
    {sender: {}, senderFrame: f.frame},
    {documentId: 'document-1', registrationId: 'registration', reply}
  );
  f.send(controls.draftReply, {documentId: 'document-1', registrationId: 'other', reply});
  f.send(controls.draftReply, {
    documentId: 'document-1',
    registrationId: 'registration',
    reply: {...reply, requestId: 'late'},
  });
  f.send(controls.draftReply, {
    documentId: 'document-1',
    registrationId: 'registration',
    reply,
  });
  const lease = await preparation;
  expect(lease.hasUnsavedDraft).toBe(true);
  f.send(controls.draftReply, {
    documentId: 'document-1',
    registrationId: 'registration',
    reply,
  });
  lease.finish('aborted');
  const next = f.drafts.prepare();
  const rejection = next.then(
    () => null,
    (error: unknown) => error
  );
  f.invalidate();
  expect(await rejection).toBeInstanceOf(Error);
  expect(() => lease.assertCurrent()).toThrow();
  f.stop();
});
test('preload draft callbacks receive validated payloads and rejected preparation aborts safely', async () => {
  const f = fixture();
  const client = createClient(createPreloadBridge(f.renderer, () => 'registration'));
  const resolutions: unknown[] = [];
  let prepares = 0;
  const stop = client.drafts.registerProtection({
    prepare: async request => {
      prepares++;
      return {...request, hasUnsavedDraft: false};
    },
    resolve: value => {
      resolutions.push(value);
    },
  });
  await settle();
  f.sender.send(controls.draftPrepare, {
    registrationId: 'registration',
    request: {documentId: 'document-1'},
  });
  expect(prepares).toBe(0);
  const lease = await f.drafts.prepare();
  expect(prepares).toBe(1);
  lease.finish('committed');
  expect(resolutions).toHaveLength(1);
  expect(resolutions[0]).toMatchObject({outcome: 'committed', documentId: 'document-1'});
  stop();
  await settle();
  expect(f.rendererListeners.get(controls.draftPrepare)?.size).toBe(0);
  expect(f.rendererListeners.get(controls.draftResolve)?.size).toBe(0);
  await expect(f.drafts.prepare()).rejects.toThrow(editorFailure);
  client.drafts.registerProtection({
    prepare: async () => {
      throw new Error('private error');
    },
    resolve: () => {},
  });
  await settle();
  await expect(f.drafts.prepare()).rejects.toThrow(editorFailure);
  f.stop();
});
