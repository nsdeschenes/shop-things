import type {
  DatabaseState,
  DraftProtection,
  DraftResolution,
  ShopThingsBridge,
} from '@shop-things/contract';
import {afterEach, assert, expect, test, vi} from 'vitest';

afterEach(() => vi.unstubAllGlobals());
import {createClient, getClient} from '@shop-things/contract/client';
import {
  safeAttributes,
  shouldSampleTelemetry,
  sanitizeLogMetricPayload,
  scrubCodeLocation,
} from '@shop-things/contract/monitoring';
import {
  actions,
  defaultTelemetrySampling,
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
          environment: 'development',
          savedDsn: null,
          activeDsn: null,
          savedSampling: {...defaultTelemetrySampling},
          activeSampling: {...defaultTelemetrySampling},
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
    expect(
      definition.arguments.safeParse({dsn, sampling: defaultTelemetrySampling}).success
    ).toBe(true);
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
    expect(
      definition.arguments.safeParse({dsn, sampling: defaultTelemetrySampling}).success
    ).toBe(false);
  }
});

test('telemetry client rejects production HTTP remote status before callers consume destination URLs', async () => {
  const {bridge} = makeBridge();
  const client = createClient(bridge);
  for (const field of ['savedDsn', 'activeDsn'] as const) {
    const state = {
      environment: 'production' as const,
      savedDsn: 'https://public@host/1',
      activeDsn: 'https://public@host/1',
      savedSampling: defaultTelemetrySampling,
      activeSampling: defaultTelemetrySampling,
      activeEnabled: true,
      restartRequired: true,
      [field]: 'http://public@remote.example/1',
    };
    bridge.telemetry.status = async () => ({status: 'success', value: state});
    bridge.telemetry.save = async () => ({status: 'success', value: state});
    expect(await client.telemetry.status()).toMatchObject({
      status: 'error',
      error: {code: 'INTERNAL'},
    });
    expect(
      await client.telemetry.save({dsn: null, sampling: defaultTelemetrySampling})
    ).toMatchObject({status: 'error', error: {code: 'INTERNAL'}});
  }
});

test('telemetry client contains rejected saves and status calls and rejects invalid active DSNs', async () => {
  const {bridge} = makeBridge();
  const client = createClient(bridge);
  bridge.telemetry.save = async () => {
    throw new Error('Private transport failure');
  };

  bridge.telemetry.status = async () => {
    throw new Error('Private transport failure');
  };

  expect(
    await client.telemetry.save({dsn: null, sampling: defaultTelemetrySampling})
  ).toMatchObject({status: 'error', error: {code: 'INTERNAL'}});
  expect(await client.telemetry.status()).toMatchObject({
    status: 'error',
    error: {code: 'INTERNAL'},
  });
  bridge.telemetry.status = async () => ({
    status: 'success',
    value: {
      environment: 'development',
      savedDsn: null,
      activeDsn: 'invalid-url',
      savedSampling: defaultTelemetrySampling,
      activeSampling: defaultTelemetrySampling,
      activeEnabled: true,
      restartRequired: true,
    },
  });
  expect(await client.telemetry.status()).toMatchObject({
    status: 'error',
    error: {code: 'INTERNAL'},
  });
});

test('code locations redact only home usernames and URL query data', () => {
  const cases = [
    [
      '/home/PRIVATE_USER/project/src/UnlistedFeature.ts',
      '/home/[Filtered]/project/src/UnlistedFeature.ts',
    ],
    [
      '/Users/PRIVATE_USER/project/renderer/assets/chunk-ABC123.js',
      '/Users/[Filtered]/project/renderer/assets/chunk-ABC123.js',
    ],
    [
      'C:\\Users\\PRIVATE_USER\\app\\dist\\preload.js',
      'C:/Users/[Filtered]/app/dist/preload.js',
    ],
    [
      'file:///home/PRIVATE_USER/project/src/CustomerEditor.tsx',
      'file:///home/[Filtered]/project/src/CustomerEditor.tsx',
    ],
    [
      'file:///C:/Users/PRIVATE_USER/app/dist/main.js?private=secret#fragment',
      'file:///C:/Users/[Filtered]/app/dist/main.js',
    ],
    [
      '/opt/app/resources/app.asar/dist/new-module.js',
      '/opt/app/resources/app.asar/dist/new-module.js',
    ],
    ['src/new-module.ts', 'src/new-module.ts'],
    ['node:internal/process/task_queues', 'node:internal/process/task_queues'],
    [
      'https://cdn.example.com/assets/chunk-ABC123.js',
      'https://cdn.example.com/assets/chunk-ABC123.js',
    ],
    [
      'https://cdn.example.com/telemetry-work.js?private=secret#fragment',
      'https://cdn.example.com/telemetry-work.js',
    ],
  ];
  for (const [input, expected] of cases) {
    expect(scrubCodeLocation(input!)).toBe(expected);
  }
});

test('sampling percentages are bounded numbers and each signal change requires a restart', () => {
  for (const field of ['errors', 'traces', 'logs', 'metrics'] as const) {
    for (const percentage of [0, 12.5, 100]) {
      expect(
        actions['telemetry.save'].arguments.safeParse({
          dsn: null,
          sampling: {...defaultTelemetrySampling, [field]: percentage},
        }).success
      ).toBe(true);
    }

    for (const percentage of [
      -0.1,
      100.1,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '50',
      null,
    ]) {
      expect(
        actions['telemetry.save'].arguments.safeParse({
          dsn: null,
          sampling: {...defaultTelemetrySampling, [field]: percentage},
        }).success
      ).toBe(false);
    }

    const state = {
      environment: 'development',
      savedDsn: 'https://public@host/1',
      activeDsn: 'https://public@host/1',
      activeEnabled: true,
      savedSampling: {...defaultTelemetrySampling, [field]: 25},
      activeSampling: defaultTelemetrySampling,
      restartRequired: true,
    };
    expect(
      actions['telemetry.status'].result.safeParse({status: 'success', value: state})
        .success
    ).toBe(true);
    expect(
      actions['telemetry.status'].result.safeParse({
        status: 'success',
        value: {...state, restartRequired: false},
      }).success
    ).toBe(false);
  }
});

test('log and metric sampling retains the requested fraction and handles zero and full sampling exactly', () => {
  const random = vi.fn(() => 0.5);
  expect(shouldSampleTelemetry(0, random)).toBe(false);
  expect(shouldSampleTelemetry(100, random)).toBe(true);
  expect(random).not.toHaveBeenCalled();
  expect(shouldSampleTelemetry(12.5, () => 0.124)).toBe(true);
  expect(shouldSampleTelemetry(12.5, () => 0.125)).toBe(false);
  expect(shouldSampleTelemetry(50, random)).toBe(false);
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

test('customer telemetry retains only the five permitted business fields and rejects malformed values', () => {
  const permitted = {
    customerNumber: 73021,
    stock: 9,
    previousBalance: '-100.00',
    balance: '134.25',
    donate: false,
  };
  const personal = {
    id: 99,
    firstName: 'PRIVATE_FIRST',
    lastName: 'PRIVATE_LAST',
    address: 'PRIVATE_ADDRESS',
    city: 'PRIVATE_CITY',
    province: 'PRIVATE_PROVINCE',
    postalCode: 'PRIVATE_POSTAL',
    phone: 'PRIVATE_PHONE',
    email: 'PRIVATE_EMAIL',
    comments: 'PRIVATE_COMMENTS',
    session: 'PRIVATE_SESSION',
    revision: 'PRIVATE_REVISION',
    customer: {...values, ...permitted},
    args: {email: 'PRIVATE_EMAIL'},
    result: {customer: values},
    dsn: 'https://private@host/1',
  };
  expect(safeAttributes({...personal, ...permitted})).toEqual(permitted);
  for (const field of [
    'customerNumber',
    'stock',
    'previousBalance',
    'balance',
    'donate',
  ] as const) {
    for (const value of [
      'PRIVATE_PERSONAL_INFO',
      {},
      [],
      null,
      Number.NaN,
      Number.POSITIVE_INFINITY,
    ]) {
      expect(safeAttributes({[field]: value})).toEqual({});
    }
  }

  for (const attributes of [
    {customerNumber: 0},
    {customerNumber: 1.5},
    {stock: -1},
    {stock: 1.5},
    {balance: '123 PRIVATE'},
    {donate: 'true'},
  ]) {
    expect(safeAttributes(attributes)).toEqual({});
  }

  expect(
    safeAttributes({
      customerNumber: 1,
      stock: 0,
      previousBalance: '0.00',
      balance: '0.00',
      donate: true,
    })
  ).toEqual({
    customerNumber: 1,
    stock: 0,
    previousBalance: '0.00',
    balance: '0.00',
    donate: true,
  });
});

test('client observations project validated customer arguments without exposing personal fields or results', async () => {
  const {bridge} = makeBridge();
  const observations: import('@shop-things/contract/client').ClientObservation[] = [];
  const permitted = {
    customerNumber: 73021,
    stock: 9,
    previousBalance: '-100.00',
    balance: '134.25',
    donate: false,
  };
  const privateValues = {
    ...values,
    ...permitted,
    firstName: 'PRIVATE_NAME',
    email: 'PRIVATE_EMAIL',
    comments: 'PRIVATE_COMMENTS',
  };
  const client = createClient(bridge, observation => {
    observations.push(observation);
    throw new Error('Reporter failed');
  });
  await client.customers.update({reference, changes: privateValues});
  expect(observations[0]?.attributes).toEqual(permitted);
  expect(Object.isFrozen(observations[0]?.attributes)).toBe(true);

  await client.customers.create({
    session: 'PRIVATE_SESSION',
    values: {...values, stock: 0, balance: '7', previousBalance: '-1.2', donate: true},
  });
  expect(observations[1]?.attributes).toEqual({
    stock: 0,
    balance: '7.00',
    previousBalance: '-1.20',
    donate: true,
  });
  await client.customers.update({reference, changes: {email: 'PRIVATE_EMAIL'}});
  expect(observations[2]?.attributes).toEqual({});

  await client.customers.update({reference, changes: {stock: -1, balance: '7.00'}});
  expect(observations[3]).toMatchObject({
    outcome: 'error',
    errorCode: 'VALIDATION',
    attributes: {},
  });
  bridge.customers.update = async () => {
    throw new Error('Transport failed');
  };

  await client.customers.update({reference, changes: {stock: 2, donate: false}});
  expect(observations[4]).toMatchObject({
    outcome: 'error',
    attributes: {stock: 2, donate: false},
    fault: {kind: 'transport'},
  });
  await client.customers.list({session: 'PRIVATE_SESSION', query: 'PRIVATE_QUERY'});
  await client.telemetry.save({
    dsn: 'https://PRIVATE_DSN@host/1',
    sampling: {...defaultTelemetrySampling},
  });
  expect(observations[5]?.attributes).toEqual({});
  expect(observations[6]?.attributes).toEqual({});
  expect(JSON.stringify(observations)).not.toContain('PRIVATE');
  expect(
    observations.every(value => !('arguments' in value) && !('result' in value))
  ).toBe(true);
});

test('final log and metric filtering removes private scope values and preserves native SDK metadata', () => {
  const payload = {
    items: [
      {
        attributes: {
          firstName: {type: 'string', value: 'PRIVATE_FIRST'},
          'sdk.future.metric': {
            type: 'double',
            value: 123,
            unit: 'millisecond',
            future: true,
          },
          'code.file.path': {
            type: 'string',
            value:
              'file:///home/PRIVATE_USER/app/src/new-module.ts?private=PRIVATE_QUERY',
            future: true,
          },
          email: {type: 'string', value: 'PRIVATE_EMAIL'},
          customer: {type: 'string', value: JSON.stringify(values)},
          customerNumber: {type: 'integer', value: 73021, unit: 'PRIVATE_UNIT'},
          donate: {type: 'boolean', value: false},
          stock: {type: 'integer', value: 9},
          balance: {type: 'string', value: '134.25'},
          previousBalance: {type: 'string', value: '-100.00'},
          action: {type: 'string', value: 'customers.get'},
          'sentry.trace.parent_span_id': {type: 'string', value: '0123456789abcdef'},
          'sentry.timestamp.sequence': {type: 'integer', value: 4},
          'sentry.environment': {type: 'string', value: 'PRIVATE_ENVIRONMENT'},
          'sentry.message.template': {
            type: 'string',
            value: 'Application action %s completed',
          },
          'sentry.message.parameter.0': {type: 'string', value: 'customers.get'},
          'sentry.message.parameter.1': {type: 'string', value: 'PRIVATE_PARAMETER'},
        },
      },
    ],
  };
  sanitizeLogMetricPayload(payload, 'production', 'main');
  expect(payload.items[0]?.attributes).toEqual({
    'sdk.future.metric': {type: 'double', value: 123, unit: 'millisecond', future: true},
    'code.file.path': {
      type: 'string',
      value: 'file:///home/[Filtered]/app/src/new-module.ts',
      future: true,
    },
    customerNumber: {type: 'integer', value: 73021},
    donate: {type: 'boolean', value: false},
    stock: {type: 'integer', value: 9},
    balance: {type: 'string', value: '134.25'},
    previousBalance: {type: 'string', value: '-100.00'},
    action: {type: 'string', value: 'customers.get'},
    'sentry.trace.parent_span_id': {type: 'string', value: '0123456789abcdef'},
    'sentry.timestamp.sequence': {type: 'integer', value: 4},
    'sentry.environment': {type: 'string', value: 'production'},
    process: {type: 'string', value: 'main'},
    'sentry.message.template': {type: 'string', value: 'Application action %s completed'},
    'sentry.message.parameter.0': {type: 'string', value: 'customers.get'},
  });
  expect(JSON.stringify(payload)).not.toContain('PRIVATE');
  const malformed = {
    items: [
      {attributes: 'PRIVATE_EMAIL'},
      {attributes: {balance: {value: 'PRIVATE_EMAIL'}, donate: {value: 'PRIVATE_EMAIL'}}},
      {
        attributes: {
          'sentry.message.template': {value: 'PRIVATE_TEMPLATE'},
          'sentry.message.parameter.0': {value: 'PRIVATE_PARAMETER'},
        },
      },
    ],
  };
  sanitizeLogMetricPayload(malformed, 'development', 'renderer');
  expect(malformed).toEqual({
    items: [
      {
        attributes: {
          'sentry.environment': {type: 'string', value: 'development'},
          process: {type: 'string', value: 'renderer'},
        },
      },
      {
        attributes: {
          'sentry.environment': {type: 'string', value: 'development'},
          process: {type: 'string', value: 'renderer'},
        },
      },
      {
        attributes: {
          'sentry.environment': {type: 'string', value: 'development'},
          process: {type: 'string', value: 'renderer'},
        },
      },
    ],
  });
});
