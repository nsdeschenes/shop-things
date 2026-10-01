import {writeFile} from 'node:fs/promises';

import {afterEach, expect, it} from 'vitest';

import {DraftCoordinator} from '../src/draftCoordinator.js';
import {fixture, success, values} from './backendFixture.js';

const header = [
  'id',
  'customerNumber',
  'firstName',
  'lastName',
  'address',
  'city',
  'province',
  'postalCode',
  'phone',
  'email',
  'stock',
  'balance',
  'previousBalance',
  'donate',
  'comments',
];
function cell(value: unknown) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

const source = {id: 'ignored', customerNumber: '', ...values};
function csv(rows: object[], columns = header) {
  return [
    columns.map(cell).join(','),
    ...rows.map(row => columns.map(column => cell(Reflect.get(row, column))).join(',')),
  ].join('\r\n');
}

let cleanup: (() => Promise<void>) | undefined;
afterEach(async () => {
  await cleanup?.();
});
async function setup() {
  const f = await fixture();
  cleanup = f.cleanup;
  const session = success(await f.service.handlers['database.create']()).session!;
  return {
    ...f,
    session,
    async prepare(text: string | Uint8Array) {
      await writeFile(f.choices.csv!, text);
      const result = success(await f.service.handlers['imports.prepare']({session}));
      expect(
        success(await f.service.handlers['customers.list']({session, query: ''}))
      ).toEqual([]);
      return result;
    },
  };
}

it('preserves reordered exported text, BOM, quoted commas, quotes and embedded newlines without writing', async () => {
  const f = await setup();
  const row = {
    ...source,
    customerNumber: '00042',
    firstName: ' Éloïse ',
    phone: 'anything',
    comments: 'line 1, "quoted"\nline 2\r\nline 3',
  };
  const review = await f.prepare(
    '\uFEFF\r\n' + csv([row], header.toReversed()) + '\r\n\r\n'
  );
  expect(review.status).toBe('ready');
  expect(review.rows).toEqual([
    {
      recordNumber: 1,
      sourceCustomerNumber: 42,
      values: {
        ...values,
        firstName: row.firstName,
        phone: row.phone,
        comments: row.comments,
      },
    },
  ]);
  expect(
    success(
      await f.service.handlers['imports.review']({
        session: f.session,
        importId: review.importId,
      })
    )
  ).toEqual(review);
});

it('round trips the public export and ignores source identity', async () => {
  const f = await setup();
  const saved = success(
    await f.service.handlers['customers.create']({session: f.session, values})
  );
  success(await f.service.handlers['exports.csv']({session: f.session}));
  const review = success(
    await f.service.handlers['imports.prepare']({session: f.session})
  );
  expect(review.rows[0]?.values).toEqual(values);
  expect(review.rows[0]?.sourceCustomerNumber).toBe(saved.customer.customerNumber);
  expect(
    success(await f.service.handlers['customers.list']({session: f.session, query: ''}))
  ).toEqual([saved]);
});

it.each(['', '\r\n\n', csv([])])(
  'reports empty input without customers: %j',
  async text => {
    const f = await setup();
    expect((await f.prepare(text)).status).toBe('empty');
  }
);

it.each([
  Buffer.from([0xff]),
  'wrong,header',
  csv([], [...header.slice(0, -1), 'firstName']),
  csv(
    [],
    header.map(column => (column === 'id' ? ' id' : column))
  ),
  csv([source]) + '\n"unclosed',
  csv([]) + '\nshort,row',
  csv([]) + '\n"name"x,' + ','.repeat(13),
  csv([]) + '\r' + csv([source]),
])('rejects encoding, header or structure before field review: %j', async text => {
  const f = await setup();
  const review = await f.prepare(text);
  expect(review.status).toBe('rejected');
  expect(review.rows).toEqual([]);
});

it('rejects file and customer-record limits', async () => {
  const f = await setup();
  expect((await f.prepare(Buffer.alloc(10485761))).diagnostics[0]?.reason).toContain(
    '10 MiB'
  );
  expect(
    (await f.prepare(csv(Array.from<object>({length: 10001}).fill(source))))
      .diagnostics[0]?.reason
  ).toContain('10,000');
  expect(
    (await f.prepare(csv(Array.from<object>({length: 10000}).fill(source)))).rows
  ).toHaveLength(10000);
});

it.each([
  ['customerNumber', ' '],
  ['customerNumber', '0'],
  ['customerNumber', '9007199254740992'],
  ['stock', ''],
  ['stock', '-1'],
  ['stock', '1e2'],
  ['stock', '+1'],
  ['balance', ''],
  ['balance', '1.001'],
  ['balance', '1000000000000.01'],
  ['balance', ' 1'],
  ['balance', '$1'],
  ['previousBalance', '1,000'],
  ['donate', ''],
  ['donate', 'TRUE'],
  ['donate', '1'],
])('rejects invalid %s value %j', async (column, value) => {
  const f = await setup();
  const review = await f.prepare(csv([{...source, [column]: value}]));
  expect(review.status).toBe('rejected');
  expect(review.invalidRecordCount).toBe(1);
  expect(review.diagnostics.some(detail => detail.column === column)).toBe(true);
});

it('accepts numeric boundaries and valid lexical alternatives', async () => {
  const f = await setup();
  const review = await f.prepare(
    csv([
      {
        ...source,
        customerNumber: '9007199254740991',
        stock: '9007199254740991',
        balance: '-1000000000000',
        previousBalance: '-0.0',
        donate: 'true',
      },
      {...source, stock: '0000', balance: '00012.3'},
    ])
  );
  expect(review.status).toBe('ready');
  expect(review.rows).toHaveLength(2);
});

it('rejects the whole file and truncates details while counting invalid records once', async () => {
  const f = await setup();
  const invalid = {
    ...source,
    firstName: ' \n',
    lastName: '',
    stock: '',
    balance: '',
    previousBalance: '',
    donate: '',
  };
  const review = await f.prepare(
    csv([source, ...Array.from<object>({length: 30}).fill(invalid)])
  );
  expect(review.status).toBe('rejected');
  expect(review.rows).toEqual([]);
  expect(review.invalidRecordCount).toBe(30);
  expect(review.diagnostics).toHaveLength(100);
  expect(review.omittedDiagnosticCount).toBe(50);
  expect(review.diagnostics[0]?.recordNumber).toBe(2);
  expect((await f.prepare(csv([]) + '\n' + ','.repeat(14))).invalidRecordCount).toBe(1);
});

it('cancels the picker and releases admission during review; reopening expires preparation', async () => {
  const f = await setup();
  const review = await f.prepare(csv([source]));
  f.choices.csv = null;
  expect(await f.service.handlers['imports.prepare']({session: f.session})).toEqual({
    status: 'cancelled',
  });
  f.choices.open = f.choices.create;
  const drafts = new DraftCoordinator();
  const participant = {
    documentId: 'test',
    prepare(request: Parameters<typeof drafts.reply>[1]) {
      drafts.reply(participant, {...Object(request), hasUnsavedDraft: false});
    },
    resolve() {},
  };
  drafts.register(participant);
  f.options.drafts = drafts;
  expect((await f.service.handlers['database.open']()).status).toBe('success');
  expect(
    await f.service.handlers['imports.review']({
      session: f.session,
      importId: review.importId,
    })
  ).toMatchObject({status: 'error', error: {code: 'STALE_SESSION'}});
});
