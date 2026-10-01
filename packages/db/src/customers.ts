import {and, eq, sql} from 'drizzle-orm';

import type {AppDatabase} from './index.js';
import {customers} from './schema.js';

export class DatabaseError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

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

function translateError(error: unknown): never {
  if (
    (String(error) + (error instanceof Error ? String(error.cause) : '')).includes(
      'UNIQUE constraint failed: customers.customerNumber'
    )
  ) {
    throw new DatabaseError(
      'CUSTOMER_NUMBER_CONFLICT',
      'Customer number is already assigned'
    );
  }

  throw error;
}

export async function listCustomers(
  db: AppDatabase,
  query = ''
): Promise<CustomerData[]> {
  const needle = query.trim();
  // Turso REGEXP uses Unicode case folding; escape literal input before binding it.
  const pattern = '(?i)' + needle.replace(regexMetacharacters, '\\$&');
  const number =
    customerNumberPattern.test(needle) && Number.isSafeInteger(Number(needle))
      ? Number(needle)
      : -1;
  const rows = await db
    .select()
    .from(customers)
    .where(
      needle
        ? sql`coalesce(${customers.firstName}, '') regexp ${pattern} or coalesce(${customers.lastName}, '') regexp ${pattern} or ${customers.customerNumber} = ${number}`
        : undefined
    )
    .orderBy(
      sql`coalesce(${customers.lastName}, '') collate nocase`,
      sql`coalesce(${customers.firstName}, '') collate nocase`,
      customers.customerNumber,
      customers.id
    );
  return rows.map(normalize);
}

export async function getCustomer(
  db: AppDatabase,
  id: number
): Promise<CustomerData | null> {
  const [row] = await db.select().from(customers).where(eq(customers.id, id));
  return row ? normalize(row) : null;
}

export async function createCustomer(
  db: AppDatabase,
  values: CustomerValues
): Promise<CustomerData> {
  const parsed = validate(values, true);
  requireName(values);
  try {
    return await db.transaction(async tx => {
      const [row] = await tx
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
        .returning();
      if (!row) {
        throw new Error('Customer insert returned no row');
      }

      const [stored] = await tx.select().from(customers).where(eq(customers.id, row.id));
      if (!stored) {
        throw new Error('Customer insert was not persisted');
      }

      verifyMoney(stored, values);
      return normalize(stored);
    });
  } catch (error) {
    return translateError(error);
  }
}

// The callback plans from the same locked snapshot used by every insertion.
// Native dialogs must finish before entering this transaction.
export async function importCustomerBatch(
  db: AppDatabase,
  plan: (saved: CustomerData[]) => CustomerChanges[] | null
): Promise<CustomerData[] | null> {
  let began = false;
  try {
    // The installed Drizzle adapter ignores transaction behavior configuration.
    await db.run('BEGIN IMMEDIATE');
    began = true;
    const values = plan(await listCustomers(db));
    if (values === null) {
      await db.run('ROLLBACK');
      began = false;
      return null;
    }

    const added: CustomerData[] = [];
    for (const value of values) {
      const parsed = validate(value, false);
      requireName(value);
      if (value.customerNumber === undefined) {
        throw new DatabaseError('VALIDATION', 'An import customer number is required');
      }

      const [row] = await db
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
        })
        .returning();
      if (!row) {
        throw new Error('Customer import returned no row');
      }

      const [stored] = await db.select().from(customers).where(eq(customers.id, row.id));
      if (!stored) {
        throw new Error('Imported customer was not persisted');
      }

      verifyMoney(stored, value);
      added.push(normalize(stored));
    }

    await db.run('COMMIT');
    began = false;
    return added;
  } catch (error) {
    if (began) {
      await db.run('ROLLBACK');
    }

    return translateError(error);
  }
}

export async function updateCustomer(
  db: AppDatabase,
  reference: CustomerRevision,
  changes: CustomerChanges
): Promise<CustomerData> {
  const parsed = validate(changes, false);
  try {
    return await db.transaction(async tx => {
      const [old] = await tx
        .select()
        .from(customers)
        .where(eq(customers.id, reference.id));
      if (!old) {
        throw new DatabaseError('NOT_FOUND', 'Customer no longer exists');
      }

      if (String(old.revision) !== reference.revision) {
        throw new DatabaseError(
          'STALE_CUSTOMER',
          'Customer changed; reload before editing'
        );
      }

      requireName({...old, ...changes});
      const [row] = await tx
        .update(customers)
        .set({...parsed, revision: sql`${customers.revision} + 1`})
        .where(and(eq(customers.id, reference.id), eq(customers.revision, old.revision)))
        .returning();
      if (!row) {
        throw new DatabaseError(
          'STALE_CUSTOMER',
          'Customer changed; reload before editing'
        );
      }

      const [stored] = await tx.select().from(customers).where(eq(customers.id, row.id));
      if (!stored) {
        throw new Error('Customer update was not persisted');
      }

      verifyMoney(stored, changes);
      return normalize(stored);
    });
  } catch (error) {
    return translateError(error);
  }
}

export async function deleteCustomer(
  db: AppDatabase,
  reference: CustomerRevision
): Promise<void> {
  const rows = await db
    .delete(customers)
    .where(
      and(
        eq(customers.id, reference.id),
        sql`cast(${customers.revision} as text) = ${reference.revision}`
      )
    )
    .returning({id: customers.id});
  if (!rows.length) {
    throw new DatabaseError(
      (await getCustomer(db, reference.id)) ? 'STALE_CUSTOMER' : 'NOT_FOUND',
      'Customer changed or no longer exists'
    );
  }
}
