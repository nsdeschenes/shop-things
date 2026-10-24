import {and, eq, sql} from 'drizzle-orm';
import {Effect} from 'effect';

import type {AppDatabase} from './database.js';
import {attempt, DatabaseError, DatabaseNativeError, native} from './failure.js';
import type {DatabaseFailure} from './failure.js';
import {customers} from './schema.js';
import {transaction} from './transaction.js';

const textFields = [
  'firstName',
  'lastName',
  'address',
  'city',
  'province',
  'postalCode',
  'phone',
  'email',
  'comments',
] as const;

export interface CustomerValues {
  firstName?: string;
  lastName?: string;
  address?: string;
  city?: string;
  province?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  comments?: string;
  stock?: number;
  balance?: string;
  previousBalance?: string;
  donate?: boolean;
}

export interface CustomerChanges extends CustomerValues {
  customerNumber?: number;
}

type Row = typeof customers.$inferSelect;

export type CustomerData = Omit<
  Row,
  | 'revision'
  | 'balance'
  | 'previousBalance'
  | 'donate'
  | (typeof textFields)[number]
  | 'stock'
> & {
  revision: string;
  balance: string;
  previousBalance: string;
  donate: boolean;
  stock: number;
} & Record<(typeof textFields)[number], string>;

export interface CustomerRevision {
  id: number;
  revision: string;
}

const decimalMoneyPattern = /^-?\d+(?:\.\d{1,2})?$/;
const minusPattern = /^-/;
const customerNumberPattern = /^\d+$/;
const regexMetacharacters = /[.*+?^${}()|[\]\\]/g;
const indexedNameToken = /[a-z0-9]{2}/i;

function nameSearchGram(needle: string): string | undefined {
  return indexedNameToken.exec(needle)?.[0].toLowerCase();
}

function moneyCents(value: unknown): bigint {
  if (typeof value !== 'string' || !decimalMoneyPattern.test(value)) {
    throw new DatabaseError(
      'VALIDATION',
      'Money must be decimal text with at most two decimal places'
    );
  }

  const negative = value.startsWith('-');
  const [whole = '', fraction = ''] = value.replace(minusPattern, '').split('.');
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (cents > 100000000000000n) {
    throw new DatabaseError('VALIDATION', 'Money exceeds one trillion');
  }

  return negative ? -cents : cents;
}

function money(value: unknown): number {
  return Number(moneyCents(value)) / 100;
}

function normalize(row: Row): CustomerData {
  return {
    ...row,
    firstName: row.firstName ?? '',
    lastName: row.lastName ?? '',
    address: row.address ?? '',
    city: row.city ?? '',
    province: row.province ?? '',
    postalCode: row.postalCode ?? '',
    phone: row.phone ?? '',
    email: row.email ?? '',
    comments: row.comments ?? '',
    stock: row.stock ?? 0,
    balance: (row.balance ?? 0).toFixed(2),
    previousBalance: (row.previousBalance ?? 0).toFixed(2),
    donate: row.donate ?? false,
    revision: String(row.revision),
  };
}

function validate(values: CustomerChanges, creation: boolean) {
  if (!values || typeof values !== 'object' || Array.isArray(values)) {
    throw new DatabaseError('VALIDATION', 'Customer values must be an object');
  }

  const allowed: readonly string[] = [
    ...textFields,
    'stock',
    'balance',
    'previousBalance',
    'donate',
    ...(creation ? [] : ['customerNumber']),
  ];
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.includes(key)) {
      throw new DatabaseError('VALIDATION', `Unknown customer field: ${key}`);
    }

    if ((textFields as readonly string[]).includes(key) && typeof value !== 'string') {
      throw new DatabaseError('VALIDATION', `${key} must be text`);
    }

    if (
      (key === 'stock' || key === 'customerNumber') &&
      (typeof value !== 'number' ||
        !Number.isSafeInteger(value) ||
        value < (key === 'stock' ? 0 : 1))
    ) {
      throw new DatabaseError('VALIDATION', `${key} must be a safe whole number`);
    }

    if (key === 'donate' && typeof value !== 'boolean') {
      throw new DatabaseError('VALIDATION', 'Donate must be boolean');
    }

    if (key === 'balance' || key === 'previousBalance') {
      money(value);
    }
  }

  const {balance, previousBalance, ...rest} = values;
  return {
    ...rest,
    ...(balance !== undefined ? {balance: money(balance)} : {}),
    ...(previousBalance !== undefined ? {previousBalance: money(previousBalance)} : {}),
  };
}

function requireName(values: {firstName?: string | null; lastName?: string | null}) {
  if (!values.firstName?.trim() && !values.lastName?.trim()) {
    throw new DatabaseError('VALIDATION', 'A first or last name is required');
  }
}

function verifyMoney(row: Row, values: CustomerValues) {
  for (const key of ['balance', 'previousBalance'] as const) {
    if (
      values[key] !== undefined &&
      BigInt(Math.round((row[key] ?? 0) * 100)) !== moneyCents(values[key])
    ) {
      throw new DatabaseError(
        'MONEY_PRECISION',
        'Stored money did not preserve entered cents'
      );
    }
  }
}

function translateError(error: DatabaseFailure): DatabaseFailure {
  const original = error instanceof DatabaseNativeError ? error.cause : error;
  if (
    (
      String(original) + (original instanceof Error ? String(original.cause) : '')
    ).includes('UNIQUE constraint failed: customers.customerNumber')
  ) {
    return new DatabaseError(
      'CUSTOMER_NUMBER_CONFLICT',
      'Customer number is already assigned'
    );
  }

  return error;
}

export function listCustomers(
  db: AppDatabase,
  query = ''
): Effect.Effect<CustomerData[], DatabaseFailure> {
  return Effect.gen(function* () {
    const needle = query.trim();
    // Turso REGEXP uses Unicode case folding; escape literal input before binding it.
    const pattern = '(?i)' + needle.replace(regexMetacharacters, '\\$&');
    const number =
      customerNumberPattern.test(needle) && Number.isSafeInteger(Number(needle))
        ? Number(needle)
        : -1;
    const candidates = nameSearchGram(needle);
    const matches = sql`coalesce(${customers.firstName}, '') regexp ${pattern} or coalesce(${customers.lastName}, '') regexp ${pattern} or ${customers.customerNumber} = ${number}`;
    const rows = yield* native(() =>
      db
        .select()
        .from(customers)
        .where(
          needle
            ? and(
                candidates
                  ? sql`${customers.id} in (select customerId from customer_name_grams where gram in (${candidates}, '') union all select id from customers where customerNumber = ${number})`
                  : undefined,
                matches
              )
            : undefined
        )
        .orderBy(customers.customerNumber, customers.id)
    );
    return rows.map(normalize);
  });
}

export function getCustomer(
  db: AppDatabase,
  id: number
): Effect.Effect<CustomerData | null, DatabaseFailure> {
  return Effect.gen(function* () {
    const [row] = yield* native(() =>
      db.select().from(customers).where(eq(customers.id, id))
    );
    return row ? normalize(row) : null;
  });
}

export function createCustomer(
  db: AppDatabase,
  values: CustomerValues
): Effect.Effect<CustomerData, DatabaseFailure> {
  return Effect.gen(function* () {
    const parsed = yield* attempt(() => validate(values, true));
    yield* attempt(() => requireName(values));
    return yield* transaction(
      db,
      Effect.gen(function* () {
        const [row] = yield* native(() =>
          db
            .insert(customers)
            .values({
              firstName: '',
              lastName: '',
              address: '',
              city: '',
              province: '',
              postalCode: '',
              phone: '',
              email: '',
              comments: '',
              stock: 0,
              balance: 0,
              previousBalance: 0,
              donate: false,
              ...parsed,
              customerNumber: sql`(select min(candidate) from (select 1 as candidate union all select customerNumber + 1 from customers where customerNumber >= 1) where candidate not in (select customerNumber from customers where customerNumber is not null))`,
            })
            .returning()
        );
        if (!row) {
          return yield* attempt(() => {
            throw new Error('Customer insert returned no row');
          });
        }

        const [stored] = yield* native(() =>
          db.select().from(customers).where(eq(customers.id, row.id))
        );
        if (!stored) {
          return yield* attempt(() => {
            throw new Error('Customer insert was not persisted');
          });
        }

        yield* attempt(() => verifyMoney(stored, values));
        return normalize(stored);
      })
    ).pipe(Effect.mapError(translateError));
  });
}

export function importCustomerBatch(
  db: AppDatabase,
  plan: (saved: CustomerData[]) => CustomerChanges[] | null
): Effect.Effect<CustomerData[] | null, DatabaseFailure> {
  return transaction(
    db,
    Effect.gen(function* () {
      const saved = yield* listCustomers(db);
      const values = yield* attempt(() => plan(saved));
      if (values === null) {
        return null;
      }

      const added: CustomerData[] = [];
      for (const value of values) {
        const parsed = yield* attempt(() => validate(value, false));
        yield* attempt(() => requireName(value));
        if (value.customerNumber === undefined) {
          return yield* Effect.fail(
            new DatabaseError('VALIDATION', 'An import customer number is required')
          );
        }

        const customerNumber = value.customerNumber;
        const [row] = yield* native(() =>
          db
            .insert(customers)
            .values({
              firstName: '',
              lastName: '',
              address: '',
              city: '',
              province: '',
              postalCode: '',
              phone: '',
              email: '',
              comments: '',
              stock: 0,
              balance: 0,
              previousBalance: 0,
              donate: false,
              ...parsed,
              customerNumber,
            })
            .returning()
        );
        if (!row) {
          return yield* attempt(() => {
            throw new Error('Customer import returned no row');
          });
        }

        const [stored] = yield* native(() =>
          db.select().from(customers).where(eq(customers.id, row.id))
        );
        if (!stored) {
          return yield* attempt(() => {
            throw new Error('Imported customer was not persisted');
          });
        }

        yield* attempt(() => verifyMoney(stored, value));
        added.push(normalize(stored));
      }

      return added;
    }),
    {
      begin: 'BEGIN IMMEDIATE',
      rollbackResult: result => result === null,
      retryRollbackFailure: true,
    }
  ).pipe(Effect.mapError(translateError));
}

export function updateCustomer(
  db: AppDatabase,
  reference: CustomerRevision,
  changes: CustomerChanges
): Effect.Effect<CustomerData, DatabaseFailure> {
  return Effect.gen(function* () {
    const parsed = yield* attempt(() => validate(changes, false));
    return yield* transaction(
      db,
      Effect.gen(function* () {
        const [old] = yield* native(() =>
          db.select().from(customers).where(eq(customers.id, reference.id))
        );
        if (!old) {
          return yield* Effect.fail(
            new DatabaseError('NOT_FOUND', 'Customer no longer exists')
          );
        }

        if (String(old.revision) !== reference.revision) {
          return yield* Effect.fail(
            new DatabaseError('STALE_CUSTOMER', 'Customer changed; reload before editing')
          );
        }

        yield* attempt(() => requireName({...old, ...changes}));
        const [row] = yield* native(() =>
          db
            .update(customers)
            .set({...parsed, revision: sql`${customers.revision} + 1`})
            .where(
              and(eq(customers.id, reference.id), eq(customers.revision, old.revision))
            )
            .returning()
        );
        if (!row) {
          return yield* Effect.fail(
            new DatabaseError('STALE_CUSTOMER', 'Customer changed; reload before editing')
          );
        }

        const [stored] = yield* native(() =>
          db.select().from(customers).where(eq(customers.id, row.id))
        );
        if (!stored) {
          return yield* attempt(() => {
            throw new Error('Customer update was not persisted');
          });
        }

        yield* attempt(() => verifyMoney(stored, changes));
        return normalize(stored);
      })
    ).pipe(Effect.mapError(translateError));
  });
}

export function deleteCustomer(
  db: AppDatabase,
  reference: CustomerRevision
): Effect.Effect<void, DatabaseFailure> {
  return Effect.gen(function* () {
    const rows = yield* native(() =>
      db
        .delete(customers)
        .where(
          and(
            eq(customers.id, reference.id),
            sql`cast(${customers.revision} as text) = ${reference.revision}`
          )
        )
        .returning({id: customers.id})
    );
    if (!rows.length) {
      yield* Effect.fail(
        new DatabaseError(
          (yield* getCustomer(db, reference.id)) ? 'STALE_CUSTOMER' : 'NOT_FOUND',
          'Customer changed or no longer exists'
        )
      );
    }
  });
}
