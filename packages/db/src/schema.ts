import {sqliteTable, text, real, integer, uniqueIndex} from 'drizzle-orm/sqlite-core';

export const customers = sqliteTable(
  'customers',
  {
    id: integer().primaryKey({autoIncrement: true}),
    customerNumber: integer(),
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
  table => [uniqueIndex('customers_customer_number_unique').on(table.customerNumber)]
);
