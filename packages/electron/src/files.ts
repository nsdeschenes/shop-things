import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, copyFile, rm, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';

import type {CustomerData} from '@shop-things/db';
import {Effect, Exit} from 'effect';

import {NativeFailure, native, originalCause, runBoundary} from './effectBoundary.js';

const customerFields = [
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
] as const;

export function writeCustomerCsv(
  destination: string,
  records: CustomerData[]
): Promise<void> {
  return runBoundary(writeCustomerCsvEffect(destination, records));
}

export function writeCustomerCsvEffect(
  destination: string,
  records: CustomerData[]
): Effect.Effect<void, NativeFailure> {
  return Effect.gen(function* () {
    function cell(value: string | number | boolean | null) {
      return `"${String(value ?? '').replaceAll('"', '""')}"`;
    }

    const text =
      [
        customerFields.map(cell).join(','),
        ...records.map(record =>
          customerFields.map(field => cell(record[field])).join(',')
        ),
      ].join('\r\n') + '\r\n';

    const temporary = temporaryPath(destination);
    const written = yield* Effect.exit(
      Effect.gen(function* () {
        yield* native(() => writeFile(temporary, text, {flag: 'wx', mode: 0o600}));
        yield* native(() => copyFile(temporary, destination, constants.COPYFILE_EXCL));
      })
    );
    yield* native(() => rm(temporary, {force: true}));
    if (Exit.isFailure(written)) {
      return yield* Effect.failCause(written.cause);
    }
  }).pipe(Effect.uninterruptible);
}

export function temporaryPath(destination: string): string {
  return join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
}

export function removeDatabaseFile(path: string): Promise<void> {
  return runBoundary(removeDatabaseFileEffect(path));
}

export function removeDatabaseFileEffect(
  path: string
): Effect.Effect<void, NativeFailure> {
  return Effect.gen(function* () {
    for (const suffix of ['', '-wal', '-shm']) {
      yield* native(() => rm(path + suffix, {force: true}));
    }
  });
}

export function copyBackup(source: string, destination: string): Promise<void> {
  return runBoundary(copyBackupEffect(source, destination));
}

export function copyBackupEffect(
  source: string,
  destination: string
): Effect.Effect<void, NativeFailure> {
  return Effect.gen(function* () {
    if (!(yield* native(() => stat(source))).isFile()) {
      throw new Error('The backup must be a file');
    }

    yield* native(() => copyFile(source, destination, constants.COPYFILE_EXCL));
    const copied = yield* Effect.exit(
      Effect.gen(function* () {
        yield* native(() => chmod(destination, 0o600));
        const journal = yield* Effect.exit(
          native(() =>
            copyFile(source + '-wal', destination + '-wal', constants.COPYFILE_EXCL)
          )
        );
        if (Exit.isFailure(journal)) {
          const error = originalCause(journal.cause);
          if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
            return yield* Effect.failCause(journal.cause);
          }
        }
      })
    );
    if (Exit.isFailure(copied)) {
      yield* removeDatabaseFileEffect(destination);
      return yield* Effect.failCause(copied.cause);
    }
  }).pipe(Effect.uninterruptible);
}
