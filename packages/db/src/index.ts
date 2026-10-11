import {isAbsolute} from 'node:path';

import {Database} from '@tursodatabase/database';
import {drizzle} from 'drizzle-orm/tursodatabase/database';
import {migrate} from 'drizzle-orm/tursodatabase/migrator';

import {observeQueries} from './queryObserver.js';
import type {QueryObserver} from './queryTelemetry.js';
import {relations} from './relations.js';
import * as schema from './schema.js';

function createTypedDatabase(client: Database) {
  return drizzle({client, relations});
}

export {relations, schema};

export type AppDatabase = ReturnType<typeof createTypedDatabase>;

export interface DatabaseHandle {
  db: AppDatabase;
  close(): void;
}

export interface OpenDatabaseOptions {
  queryObserver?: QueryObserver;
}

export function openDatabase(
  databaseFilePath: string,
  options: OpenDatabaseOptions = {}
): DatabaseHandle {
  const client = new Database(databaseFilePath);
  const observed = options.queryObserver
    ? observeQueries(client, options.queryObserver)
    : client;

  return {
    db: createTypedDatabase(observed),
    close: () => client.close(),
  };
}

export async function runMigrations(
  db: AppDatabase,
  {migrationsFolder}: {migrationsFolder: string}
): Promise<void> {
  if (!isAbsolute(migrationsFolder)) {
    throw new Error('migrationsFolder must be an absolute path');
  }

  await migrate(db, {migrationsFolder});
}

export * from './customers.js';
export * from './lifecycle.js';

export * from './queryTelemetry.js';
