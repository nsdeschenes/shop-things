import {promiseAdapter} from './compatibility.js';
import * as operations from './effect.js';

export {openDatabase} from './database.js';
export type {AppDatabase, DatabaseHandle, OpenDatabaseOptions} from './database.js';
export {DatabaseError} from './failure.js';
export type {
  CustomerValues,
  CustomerChanges,
  CustomerData,
  CustomerRevision,
} from './customers.js';
export {relations} from './relations.js';
export * as schema from './schema.js';
export * from './queryTelemetry.js';

export const runMigrations = promiseAdapter(operations.runMigrations);
export const recognizeDatabase = promiseAdapter(operations.recognizeDatabase);
export const openExistingDatabase = promiseAdapter(operations.openExistingDatabase);
export const createDatabase = promiseAdapter(operations.createDatabase);
export const backupDatabase = promiseAdapter(operations.backupDatabase);
export const listCustomers = promiseAdapter(operations.listCustomers);
export const getCustomer = promiseAdapter(operations.getCustomer);
export const createCustomer = promiseAdapter(operations.createCustomer);
export const importCustomerBatch = promiseAdapter(operations.importCustomerBatch);
export const updateCustomer = promiseAdapter(operations.updateCustomer);
export const deleteCustomer = promiseAdapter(operations.deleteCustomer);
