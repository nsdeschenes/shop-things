import {constants} from 'node:fs';
import {access, open, stat, unlink} from 'node:fs/promises';
import {dirname, isAbsolute} from 'node:path';

import {sql} from 'drizzle-orm';

import {DatabaseError} from './customers.js';
import {openDatabase, runMigrations} from './index.js';
import type {AppDatabase, DatabaseHandle} from './index.js';
import {snapshotBeforeMigrations} from './migrationBackup.js';

const initialMigration = '20260929093112_wealthy_hemingway';
const integrityMigration = '20260929120000_customer_integrity';
const phoneMigration = '20261001005150_rename_home_phone';
const numberMigration = '20261006232551_required_customer_numbers';
const supportedMigrations = [
  initialMigration,
  integrityMigration,
  phoneMigration,
  numberMigration,
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

export async function recognizeDatabase(db: AppDatabase): Promise<void> {
  try {
    const migrations = await db.all<{name: string}>(
      'select name from __drizzle_migrations order by id'
    );
    const names = migrations.map(row => row.name);

    if (
      !names.length ||
      names.length > supportedMigrations.length ||
      names.some((name, index) => name !== supportedMigrations[index])
    ) {
      throw new Error('Unsupported migration history');
    }

    const columns = await db.all<{
      name: string;
      type: string;
      pk: number;
      notnull: number;
    }>('pragma table_info(customers)');
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

      const indexes = await db.all<{name: string; unique: number}>(
        'pragma index_list(customers)'
      );

      if (
        !indexes.some(
          index => index.name === 'customers_customer_number_unique' && index.unique === 1
        )
      ) {
        throw new Error('Missing customer uniqueness');
      }

      const indexedColumns = await db.all<{name: string}>(
        'pragma index_info(customers_customer_number_unique)'
      );

      if (indexedColumns.length !== 1 || indexedColumns[0]?.name !== 'customerNumber') {
        throw new Error('Incorrect uniqueness index');
      }

      const triggers = await db.all<{sql: string}>(
        "select sql from sqlite_master where type = 'trigger' and name = 'customers_revision'"
      );

      if (triggers.length !== 1 || !triggers[0]?.sql.includes('OLD.revision + 1')) {
        throw new Error('Missing revision trigger');
      }
    }

    if (names.includes(numberMigration)) {
      const [table] = await db.all<{sql: string}>(
        "select sql from sqlite_master where type = 'table' and name = 'customers'"
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

    const tables = await db.all<{name: string}>(
      "select name from sqlite_master where type = 'table' and name not glob 'sqlite_*' and name not glob '__turso_internal_*'"
    );

    if (
      tables.some(table => !['customers', '__drizzle_migrations'].includes(table.name))
    ) {
      throw new Error('Unrelated tables');
    }
  } catch {
    throw new DatabaseError(
      'UNSUPPORTED_DATABASE',
      'Select a recognized application database with a supported schema'
    );
  }
}

async function writableFile(path: string) {
  if (!isAbsolute(path)) {
    throw new DatabaseError('VALIDATION', 'Database path must be absolute');
  }

  const info = await stat(path);
  if (!info.isFile()) {
    throw new DatabaseError('UNSUPPORTED_DATABASE', 'Database must be a regular file');
  }

  if ((info.mode & 0o222) === 0) {
    throw new DatabaseError('READ_ONLY', 'Open a writable database copy');
  }

  try {
    await access(path, constants.R_OK | constants.W_OK);
    await access(dirname(path), constants.W_OK);
  } catch {
    throw new DatabaseError('READ_ONLY', 'Open a writable database copy');
  }
}

export async function openExistingDatabase(
  path: string,
  options: {migrationsFolder: string; migrationBackupDirectory?: string}
): Promise<DatabaseHandle> {
  await writableFile(path);
  const handle = openDatabase(path);

  try {
    await recognizeDatabase(handle.db);
    await snapshotBeforeMigrations(handle.db, path, options);
    await runMigrations(handle.db, options);
    // A transaction that writes and rolls back tests driver-level writability without changing data.
    await handle.db.run('begin immediate');
    try {
      await handle.db.run('update customers set revision = revision where 0');
    } finally {
      await handle.db.run('rollback');
    }

    return handle;
  } catch (error) {
    handle.close();
    throw error;
  }
}

export async function createDatabase(
  path: string,
  options: {migrationsFolder: string}
): Promise<DatabaseHandle> {
  if (!isAbsolute(path)) {
    throw new DatabaseError('VALIDATION', 'Database path must be absolute');
  }

  const file = await open(path, 'wx');
  await file.close();
  const handle = openDatabase(path);
  try {
    await runMigrations(handle.db, options);
    return handle;
  } catch (error) {
    handle.close();
    await unlink(path);
    throw error;
  }
}

export async function backupDatabase(
  db: AppDatabase,
  destination: string
): Promise<void> {
  if (!isAbsolute(destination)) {
    throw new DatabaseError('VALIDATION', 'Backup path must be absolute');
  }

  // VACUUM INTO snapshots committed contents including pages still in the journal.
  if (destination.includes('\0')) {
    throw new DatabaseError('VALIDATION', 'Invalid backup path');
  }

  await db.run(sql.raw("VACUUM INTO '" + destination.replaceAll("'", "''") + "'"));
}
