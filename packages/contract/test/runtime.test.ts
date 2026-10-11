import type {
  DatabaseState,
  DraftProtection,
  DraftResolution,
  ShopThingsBridge,
} from '@shop-things/contract';
import {afterEach, assert, expect, test, vi} from 'vitest';

afterEach(() => vi.unstubAllGlobals());
import {createClient, getClient} from '@shop-things/contract/client';
import {safeAttributes} from '@shop-things/contract/monitoring';
import {
  actions,
  databaseStateSchema,
  draftRequestSchema,
  draftReplySchema,
  draftResolutionSchema,
  customerRecordSchema,
  importMatchGroupSchema,
  importRowSchema,
} from '@shop-things/contract/schemas';

const unavailableBridge = /bridge is unavailable/;
const mismatchedReply = /does not match/;

const state = {available: false, selectedPath: null, session: null, version: 0};
const values = {
  firstName: 'A',
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
};
const reference = {session: 'session', id: 1, revision: 'revision'};
const record = {customer: {...values, id: 1, customerNumber: 1}, reference};
function makeBridge() {
  const listeners = new Set<(state: DatabaseState) => void>();
  let protection: DraftProtection | undefined;
  const bridge: ShopThingsBridge = {
    telemetry: {
      status: async () => ({
        status: 'success',
        value: {
          savedDsn: null,
          activeDsn: null,
          activeEnabled: false,
          restartRequired: false,
        },
      }),
      save: async () => ({status: 'cancelled'}),
    },
    customers: {
      list: async () => ({status: 'success', value: [record]}),
      get: async () => ({status: 'success', value: record}),
      create: async () => ({status: 'success', value: record}),
      update: async () => ({status: 'success', value: record}),
      delete: async () => ({status: 'success', value: {deleted: true}}),
    },
    database: {
      status: async () => ({status: 'success', value: state}),
      retry: async () => ({status: 'cancelled'}),
      create: async () => ({status: 'cancelled'}),
      open: async () => ({status: 'cancelled'}),
      backup: async () => ({status: 'success', value: {path: '/backup'}}),
      restore: async () => ({status: 'cancelled'}),
      onStateChanged(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
    imports: {
      commit: async () => ({status: 'cancelled'}),
      prepare: async () => ({status: 'cancelled'}),
      review: async () => ({status: 'cancelled'}),
      resolve: async () => ({status: 'cancelled'}),
    },
    exports: {csv: async () => ({status: 'success', value: {path: '/export'}})},
    drafts: {
      confirmDiscard: async () => ({status: 'success', value: {approved: true}}),
      registerProtection(value) {
        protection = value;
        return () => {
          protection = undefined;
        };
      },
    },
  };
  return {
    bridge,
    listeners,
    get protection() {
      return protection;
    },
  };
}

test('strict schemas reject malformed arguments, writes and envelopes', () => {
  for (const [name, definition] of Object.entries(actions)) {
    expect(definition.arguments.safeParse({arbitrary: 1}).success, `${name}`).toBe(false);
    for (const payload of [
      {status: 'success'},
      {status: 'cancelled', value: 1},
      {status: 'error', error: {code: 'OTHER', message: 'bad'}},
      {status: 'error', error: {code: 'INTERNAL', message: 'bad', stack: 'secret'}},
    ]) {
      expect(definition.result.safeParse(payload).success, `${name}`).toBe(false);
    }
  }

  for (const extra of [
    {id: 1},
    {customerNumber: 1},
    {balance: 1},
    {balance: '1.234'},
    {donate: 1},
  ]) {
    expect(
      actions['customers.create'].arguments.safeParse({
        session: 's',
        values: {...values, ...extra},
      }).success
    ).toBe(false);
  }

  expect(
    actions['customers.update'].arguments.safeParse({reference, changes: {id: 2}}).success
  ).toBe(false);
  expect(
    actions['customers.update'].arguments.safeParse({
      reference: {session: 's', id: 1},
      changes: {},
    }).success
  ).toBe(false);
  expect(
    customerRecordSchema.safeParse({...record, reference: {...reference, id: 2}}).success
  ).toBe(false);
  expect(databaseStateSchema.safeParse({...state, available: true}).success).toBe(false);
  expect(draftRequestSchema.safeParse({requestId: 'r'}).success).toBe(false);
  expect(
    draftReplySchema.safeParse({requestId: 'r', documentId: 'd', hasUnsavedDraft: 1})
      .success
  ).toBe(false);
  expect(
    draftResolutionSchema.safeParse({requestId: 'r', documentId: 'd', outcome: 'unknown'})
      .success
  ).toBe(false);
});
test('saved customer responses require a positive safe integer number', () => {
  for (const customerNumber of [
    null,
    undefined,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    '1',
  ]) {
    expect(
      customerRecordSchema.safeParse({
        ...record,
        customer: {...record.customer, customerNumber},
      }).success
    ).toBe(false);
  }

  expect(customerRecordSchema.safeParse(record).success).toBe(true);
  expect(
    actions['customers.update'].arguments.safeParse({
      reference,
      changes: {firstName: 'Partial'},
    }).success
  ).toBe(true);
  expect(
    actions['customers.update'].arguments.safeParse({
      reference,
      changes: {customerNumber: undefined},
    }).success
  ).toBe(false);
});

test('named calls preserve outcomes and contain rejected or malformed transport', async () => {
  const {bridge} = makeBridge();
  const client = createClient(bridge);
  expect(await client.customers.list({session: 's', query: ''})).toStrictEqual({
    status: 'success',
    value: [record],
  });
  expect(await client.database.open()).toStrictEqual({status: 'cancelled'});
  const expected = {
    status: 'error',
    error: {code: 'STALE_SESSION', message: 'Reload.'},
  } as const;
  bridge.customers.get = async () => expected;
  expect(await client.customers.get({session: 's', id: 1})).toStrictEqual(expected);
  bridge.customers.get = async () => {
    throw new Error('private stack/database detail');
  };

  expect(await client.customers.get({session: 's', id: 1})).toStrictEqual({
    status: 'error',
    error: {code: 'INTERNAL', message: 'The application could not complete the request.'},
  });
  // @ts-expect-error Simulate a malformed transport response.
  bridge.customers.get = async () => ({status: 'success', value: 'malformed'});
  const malformed = await client.customers.get({session: 's', id: 1});
  expect(malformed).toMatchObject({status: 'error', error: {code: 'INTERNAL'}});
  let calls = 0;
  bridge.customers.create = async () => {
    calls++;
    return {status: 'success', value: record};
  };

  // Structural typing permits extra properties on a non-literal value; the
  // runtime schema must still reject generated identity before calling transport.
  const valuesWithIdentity = {...values, id: 2};
  const invalid = await client.customers.create({
    session: 's',
    values: valuesWithIdentity,
  });
  expect(invalid).toMatchObject({status: 'error', error: {code: 'VALIDATION'}});
  expect(calls).toBe(0);
  expect(() => getClient()).toThrow(unavailableBridge);
  vi.stubGlobal('window', {shopThings: {}});
  expect(() => getClient()).toThrow(unavailableBridge);
  vi.stubGlobal('window', {shopThings: bridge});
  expect((await getClient().database.status()).status).toBe('success');
});
test('validated payload-only subscriptions unsubscribe and reject invalid drafts', async () => {
  const fixture = makeBridge();
  const client = createClient(fixture.bridge);
  const delivered: DatabaseState[] = [];
  const unsubscribe = client.database.onStateChanged(value => delivered.push(value));
  const listener = [...fixture.listeners][0];
  assert.isOk(listener);
  listener({...state, version: -1});
  listener(state);
  expect(delivered).toStrictEqual([state]);
  unsubscribe();
  unsubscribe();
  listener({...state, version: 1});
  expect(fixture.listeners.size).toBe(0);
  expect(delivered.length).toBe(1);
  let prepares = 0;
  const resolutions: DraftResolution[] = [];
  const stop = client.drafts.registerProtection({
    prepare: async request => {
      prepares++;
      return {...request, hasUnsavedDraft: true};
    },
    resolve: payload => resolutions.push(payload),
  });
  const handler = fixture.protection;
  assert.isOk(handler);
  // @ts-expect-error Simulate an incomplete draft request.
  await expect(handler.prepare({requestId: 'r'})).rejects.toThrow();
  expect(prepares).toBe(0);
  expect(await handler.prepare({requestId: 'r', documentId: 'd'})).toStrictEqual({
    requestId: 'r',
    documentId: 'd',
    hasUnsavedDraft: true,
  });
  // @ts-expect-error Simulate an invalid draft resolution.
  handler.resolve({requestId: 'r', documentId: 'd', outcome: 'invalid'});
  expect(resolutions.length).toBe(0);
  handler.resolve({requestId: 'wrong', documentId: 'd', outcome: 'aborted'});
  expect(resolutions.length).toBe(0);
  handler.resolve({requestId: 'r', documentId: 'd', outcome: 'aborted'});
  expect(resolutions.length).toBe(1);
  handler.resolve({requestId: 'r', documentId: 'd', outcome: 'committed'});
  expect(resolutions.length).toBe(1);
  stop();
  handler.resolve({requestId: 'r', documentId: 'd', outcome: 'committed'});
  expect(resolutions.length).toBe(1);
  await expect(handler.prepare({requestId: 'r', documentId: 'd'})).rejects.toThrow();
  expect(fixture.protection).toBeUndefined();
  client.drafts.registerProtection({
    prepare: async () => ({requestId: 'wrong', documentId: 'd', hasUnsavedDraft: false}),
    resolve() {},
  });
  assert.isOk(fixture.protection);
  await expect(
    fixture.protection.prepare({requestId: 'r', documentId: 'd'})
  ).rejects.toThrow(mismatchedReply);
});

test('import matches require saved numbers while source and unresolved numbers remain nullable', () => {
  const target = {
    kind: 'customer',
    id: 1,
    customerNumber: 99,
    firstName: 'Saved',
    lastName: '',
  };
  const group = {id: 'email', reason: 'email', targets: [target]};
  expect(importMatchGroupSchema.safeParse(group).success).toBe(true);
  for (const customerNumber of [
    null,
    undefined,
    0,
    -1,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
    '99',
  ]) {
    expect(
      importMatchGroupSchema.safeParse({...group, targets: [{...target, customerNumber}]})
        .success
    ).toBe(false);
  }

  for (const choice of ['skip', 'unresolved']) {
    expect(
      importRowSchema.safeParse({
        recordNumber: 1,
        sourceCustomerNumber: null,
        assignedCustomerNumber: null,
        values,
        matches: ['email'],
        choice,
      }).success
    ).toBe(true);
  }

  expect(
    importRowSchema.safeParse({
      recordNumber: 1,
      sourceCustomerNumber: null,
      assignedCustomerNumber: 1,
      values,
      matches: [],
      choice: 'include',
    }).success
  ).toBe(true);
});

test('settings DSNs reject credentials, query, fragment, invalid projects and oversized input', () => {
  const definition = actions['telemetry.save'];
  for (const dsn of [
    null,
    'https://public@host/1',
    'http://local@localhost:1234/prefix/123',
  ]) {
    expect(definition.arguments.safeParse({dsn}).success).toBe(true);
  }

  for (const dsn of [
    '',
    'http://host/1',
    'file://public@host/1',
    'https://public:secret@host/1',
    'https://public@host/project',
    'https://public@host/1?q=secret',
    'https://public@host/1#secret',
    'https://public@host/1/',
    'HTTPS://public@host/1',
    'https:public@host/1',
    'https://public-key@host/1',
    'a'.repeat(2049),
  ]) {
    expect(definition.arguments.safeParse({dsn}).success).toBe(false);
  }
});

test('log linkage retains only valid span IDs and excludes private attributes', () => {
  expect(
    safeAttributes({
      'sentry.trace.parent_span_id': '0123456789abcdef',
      customer: 'private-customer',
    })
  ).toEqual({'sentry.trace.parent_span_id': '0123456789abcdef'});
  for (const value of ['private-customer', 'a'.repeat(32), '0123456789abcdeG', 123]) {
    expect(safeAttributes({'sentry.trace.parent_span_id': value})).toEqual({});
  }
});

test('passive client observers see safe outcomes and actual caught faults once and cannot alter results', async () => {
  const {bridge} = makeBridge();
  const observations: import('@shop-things/contract/client').ClientObservation[] = [];
  const client = createClient(bridge, observation => {
    observations.push(observation);
    throw new Error('reporter failed');
  });
  expect(
    await client.customers.list({session: 'private-session', query: 'private-query'})
  ).toEqual({status: 'success', value: [record]});
  const nativeError = new TypeError('private-native-details');
  bridge.customers.list = async () => {
    throw nativeError;
  };

  expect(
    await client.customers.list({session: 'private-session', query: 'private-query'})
  ).toMatchObject({status: 'error', error: {code: 'INTERNAL'}});
  bridge.customers.list = async () => ({
    status: 'error',
    error: {code: 'INTERNAL', message: 'Already handled by main.'},
  });
  await client.customers.list({session: 'private-session', query: 'private-query'});
  expect(observations).toHaveLength(3);
  expect(observations[0]).toMatchObject({action: 'customers.list', outcome: 'success'});
  expect(observations[1]).toMatchObject({
    action: 'customers.list',
    outcome: 'error',
    errorCode: 'INTERNAL',
    fault: {kind: 'transport', error: nativeError},
  });
  expect(observations[2]).not.toHaveProperty('fault');
  expect(
    observations.every(value => !('arguments' in value) && !('result' in value))
  ).toBe(true);
});
