/* oxlint-disable import/no-named-export -- Saved-file operations are shared by the action service and tests. */
import {randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {chmod, copyFile, rm, stat, writeFile} from 'node:fs/promises';
import {basename, dirname, join} from 'node:path';

import type {CustomerData} from '@shop-things/db';

const customerFields = [
  'id',
  'customerNumber',
  'firstName',
  'lastName',
  'address',
  'city',
  'province',
  'postalCode',
  'homePhone',
  'email',
  'stock',
  'balance',
  'previousBalance',
  'donate',
  'comments',
] as const;

export async function writeCustomerCsv(
  destination: string,
  records: CustomerData[]
): Promise<void> {
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
  try {
    await writeFile(temporary, text, {flag: 'wx', mode: 0o600});
    await copyFile(temporary, destination, constants.COPYFILE_EXCL);
  } finally {
    await rm(temporary, {force: true});
  }
}

export function temporaryPath(destination: string): string {
  return join(dirname(destination), `.${basename(destination)}.${randomUUID()}.tmp`);
}

export async function removeDatabaseFile(path: string): Promise<void> {
  for (const suffix of ['', '-wal', '-shm']) {
    await rm(path + suffix, {force: true});
  }
}

export async function copyBackup(source: string, destination: string): Promise<void> {
  if (!(await stat(source)).isFile()) {
    throw new Error('The backup must be a file');
  }

  await copyFile(source, destination, constants.COPYFILE_EXCL);
  try {
    await chmod(destination, 0o600);
    // Standalone backups have no journal. Include a journal when importing a saved database fixture.
    try {
      await copyFile(source + '-wal', destination + '-wal', constants.COPYFILE_EXCL);
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
        throw error;
      }
    }
  } catch (error) {
    await removeDatabaseFile(destination);
    throw error;
  }
}
