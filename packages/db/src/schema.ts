import { sqliteTable, text, real, integer } from "drizzle-orm/sqlite-core";

export const customers = sqliteTable("customers", {
  id: integer().primaryKey({ autoIncrement: true }),
  customerNumber: integer(),
  firstName: text(),
  lastName: text(),
  address: text(),
  city: text(),
  province: text(),
  postalCode: text(),
  homePhone: text(),
  email: text(),
  stock: integer().default(0),
  balance: real().default(0),
  previousBalance: real().default(0),
  donate: integer({ mode: "boolean" }),
  comments: text(),
});
