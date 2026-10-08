import {isAbsolute} from 'node:path';

import {Database} from '@tursodatabase/database';
import {drizzle} from 'drizzle-orm/tursodatabase/database';
import {migrate} from 'drizzle-orm/tursodatabase/migrator';

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

export function openDatabase(databaseFilePath: string): DatabaseHandle {
  const client = new Database(databaseFilePath);

  return {
    db: createTypedDatabase(client),
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
export * from './migrationSnapshots.js';
