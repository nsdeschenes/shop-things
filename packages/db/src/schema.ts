import {sql} from 'drizzle-orm';
import {
  sqliteTable,
  text,
  real,
  integer,
  uniqueIndex,
  check,
} from 'drizzle-orm/sqlite-core';

export const customers = sqliteTable(
  'customers',
  {
    id: integer().primaryKey({autoIncrement: true}),
    customerNumber: integer().notNull(),
    revision: integer().notNull().default(1),
    firstName: text(),
    lastName: text(),
    address: text(),
    city: text(),
    province: text(),
    postalCode: text(),
    phone: text(),
    email: text(),
    stock: integer().default(0),
    balance: real().default(0),
    previousBalance: real().default(0),
    donate: integer({mode: 'boolean'}),
    comments: text(),
  },
  table => [
    uniqueIndex('customers_customer_number_unique').on(table.customerNumber),
    check(
      'customers_customer_number_valid',
      sql`typeof(${table.customerNumber}) = 'integer' and ${table.customerNumber} between 1 and 9007199254740991`
    ),
  ]
);
