import {Database} from '@tursodatabase/database';
import {drizzle} from 'drizzle-orm/tursodatabase/database';

import {observeQueries} from './queryObserver.js';
import type {QueryObserver} from './queryTelemetry.js';
import {relations} from './relations.js';

function createTypedDatabase(client: Database) {
  return drizzle({client, relations});
}

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
