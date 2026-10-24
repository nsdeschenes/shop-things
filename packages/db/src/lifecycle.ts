import {constants} from 'node:fs';
import {access, open, stat, unlink} from 'node:fs/promises';
import {dirname, isAbsolute} from 'node:path';

import {sql} from 'drizzle-orm';
import {migrate} from 'drizzle-orm/tursodatabase/migrator';
import {Cause, Effect} from 'effect';

import {openDatabase} from './database.js';
import type {AppDatabase, DatabaseHandle, OpenDatabaseOptions} from './database.js';
import {attempt, DatabaseError, native} from './failure.js';
import type {DatabaseFailure} from './failure.js';
import {transaction} from './transaction.js';

const initialMigration = '20260929093112_wealthy_hemingway';
const integrityMigration = '20260929120000_customer_integrity';
const phoneMigration = '20261001005150_rename_home_phone';
const numberMigration = '20261006232551_required_customer_numbers';
const searchMigration = '20261024000000_customer_search_index';
const supportedMigrations = [
  initialMigration,
  integrityMigration,
  phoneMigration,
  numberMigration,
  searchMigration,
];
const expectedColumns = [
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

export function recognizeDatabase(db: AppDatabase): Effect.Effect<void, DatabaseFailure> {
  return Effect.gen(function* () {
    const migrations = yield* native(() =>
      db.all<{name: string}>('select name from __drizzle_migrations order by id')
    );
    const names = migrations.map(row => row.name);

    if (
      !names.length ||
      names.length > supportedMigrations.length ||
      names.some((name, index) => name !== supportedMigrations[index])
    ) {
      throw new Error('Unsupported migration history');
    }

    const columns = yield* native(() =>
      db.all<{
        name: string;
        type: string;
        pk: number;
        notnull: number;
      }>('pragma table_info(customers)')
    );
    const expected = [
      ...expectedColumns.map(name =>
        name === 'phone' && !names.includes(phoneMigration) ? 'homePhone' : name
      ),
      ...(names.includes(integrityMigration) ? ['revision'] : []),
    ];

    if (
      columns.length !== expected.length ||
      expected.some(name => !columns.some(column => column.name === name)) ||
      !columns.some(
        column =>
          column.name === 'id' &&
          column.type.toLowerCase() === 'integer' &&
          column.pk === 1
      )
    ) {
      throw new Error('Unsupported customer schema');
    }

    for (const column of columns) {
      const type = ['balance', 'previousBalance'].includes(column.name)
        ? 'real'
        : ['id', 'customerNumber', 'stock', 'donate', 'revision'].includes(column.name)
          ? 'integer'
          : 'text';

      if (column.type.toLowerCase() !== type) {
        throw new Error('Unsupported column type');
      }
    }

    if (names.includes(integrityMigration)) {
      if (columns.find(column => column.name === 'revision')?.notnull !== 1) {
        throw new Error('Missing revision constraint');
      }

      const indexes = yield* native(() =>
        db.all<{name: string; unique: number}>('pragma index_list(customers)')
      );

      if (
        !indexes.some(
          index => index.name === 'customers_customer_number_unique' && index.unique === 1
        )
      ) {
        throw new Error('Missing customer uniqueness');
      }

      const indexedColumns = yield* native(() =>
        db.all<{name: string}>('pragma index_info(customers_customer_number_unique)')
      );

      if (indexedColumns.length !== 1 || indexedColumns[0]?.name !== 'customerNumber') {
        throw new Error('Incorrect uniqueness index');
      }

      const triggers = yield* native(() =>
        db.all<{sql: string}>(
          "select sql from sqlite_master where type = 'trigger' and name = 'customers_revision'"
        )
      );

      if (triggers.length !== 1 || !triggers[0]?.sql.includes('OLD.revision + 1')) {
        throw new Error('Missing revision trigger');
      }
    }

    if (names.includes(numberMigration)) {
      const [table] = yield* native(() =>
        db.all<{sql: string}>(
          "select sql from sqlite_master where type = 'table' and name = 'customers'"
        )
      );
      if (
        columns.find(column => column.name === 'customerNumber')?.notnull !== 1 ||
        !table?.sql.includes('customers_customer_number_valid') ||
        !table.sql.includes('9007199254740991') ||
        !table.sql
          .replaceAll(/\s/g, '')
          .toLowerCase()
          .includes(
            'typeof("customernumber")=\'integer\'and"customernumber"between1and9007199254740991'
          )
      ) {
        throw new Error('Missing customer number constraint');
      }
    }

    const tables = yield* native(() =>
      db.all<{name: string}>(
        "select name from sqlite_master where type = 'table' and name not glob 'sqlite_*' and name not glob '__turso_internal_*'"
      )
    );

    const allowedTables = ['customers', '__drizzle_migrations'];
    if (names.includes(searchMigration)) {
      allowedTables.push(
        'customers_search',
        'customers_search_data',
        'customers_search_idx',
        'customers_search_content',
        'customers_search_docsize',
        'customers_search_config'
      );
    }

    if (tables.some(table => !allowedTables.includes(table.name))) {
      throw new Error('Unrelated tables');
    }
  }).pipe(
    Effect.catchCause(cause =>
      Cause.hasInterrupts(cause)
        ? Effect.failCause(cause)
        : Effect.fail(
            new DatabaseError(
              'UNSUPPORTED_DATABASE',
              'Select a recognized application database with a supported schema'
            )
          )
    )
  );
}

function writableFile(path: string): Effect.Effect<void, DatabaseFailure> {
  return Effect.gen(function* () {
    if (!isAbsolute(path)) {
      return yield* Effect.fail(
        new DatabaseError('VALIDATION', 'Database path must be absolute')
      );
    }

    const info = yield* native(() => stat(path));
    if (!info.isFile()) {
      return yield* Effect.fail(
        new DatabaseError('UNSUPPORTED_DATABASE', 'Database must be a regular file')
      );
    }

    if ((info.mode & 0o222) === 0) {
      return yield* Effect.fail(
        new DatabaseError('READ_ONLY', 'Open a writable database copy')
      );
    }

    yield* native(() => access(path, constants.R_OK | constants.W_OK)).pipe(
      Effect.flatMap(() => native(() => access(dirname(path), constants.W_OK))),
      Effect.mapError(
        () => new DatabaseError('READ_ONLY', 'Open a writable database copy')
      )
    );
  });
}

export function runMigrations(
  db: AppDatabase,
  {migrationsFolder}: {migrationsFolder: string}
): Effect.Effect<void, DatabaseFailure> {
  return Effect.gen(function* () {
    if (!isAbsolute(migrationsFolder)) {
      return yield* attempt(() => {
        throw new Error('migrationsFolder must be an absolute path');
      });
    }

    yield* native(() => migrate(db, {migrationsFolder}));
  });
}

export function openExistingDatabase(
  path: string,
  options: OpenDatabaseOptions & {migrationsFolder: string}
): Effect.Effect<DatabaseHandle, DatabaseFailure> {
  return Effect.gen(function* () {
    yield* writableFile(path);
    return yield* Effect.uninterruptibleMask(restore =>
      Effect.gen(function* () {
        const handle = yield* attempt(() => openDatabase(path, options));
        yield* restore(
          Effect.gen(function* () {
            yield* recognizeDatabase(handle.db);
            yield* runMigrations(handle.db, options);
            yield* transaction(
              handle.db,
              native(() =>
                handle.db.run('update customers set revision = revision where 0')
              ),
              {begin: 'BEGIN IMMEDIATE', rollbackResult: () => true}
            );
          })
        ).pipe(
          Effect.catchCause(cause =>
            attempt(() => handle.close()).pipe(
              Effect.flatMap(() => Effect.failCause(cause))
            )
          )
        );
        return handle;
      })
    );
  });
}

export function createDatabase(
  path: string,
  options: OpenDatabaseOptions & {migrationsFolder: string}
): Effect.Effect<DatabaseHandle, DatabaseFailure> {
  return Effect.gen(function* () {
    if (!isAbsolute(path)) {
      return yield* Effect.fail(
        new DatabaseError('VALIDATION', 'Database path must be absolute')
      );
    }

    return yield* Effect.uninterruptibleMask(restore =>
      Effect.gen(function* () {
        yield* Effect.acquireUseRelease(
          native(() => open(path, 'wx')),
          () => Effect.void,
          file => native(() => file.close())
        );
        const handle = yield* attempt(() => openDatabase(path, options));
        yield* restore(runMigrations(handle.db, options)).pipe(
          Effect.catchCause(cause =>
            attempt(() => handle.close()).pipe(
              Effect.flatMap(() => native(() => unlink(path))),
              Effect.flatMap(() => Effect.failCause(cause))
            )
          )
        );
        return handle;
      })
    );
  });
}

export function backupDatabase(
  db: AppDatabase,
  destination: string
): Effect.Effect<void, DatabaseFailure> {
  return Effect.gen(function* () {
    if (!isAbsolute(destination)) {
      return yield* Effect.fail(
        new DatabaseError('VALIDATION', 'Backup path must be absolute')
      );
    }

    if (destination.includes('\0')) {
      return yield* Effect.fail(new DatabaseError('VALIDATION', 'Invalid backup path'));
    }

    yield* native(() =>
      db.run(sql.raw("VACUUM INTO '" + destination.replaceAll("'", "''") + "'"))
    );
  });
}
