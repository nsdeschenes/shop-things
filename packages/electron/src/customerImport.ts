/* oxlint-disable import/no-named-export -- Backend CSV preparation boundary. */
import {randomUUID} from 'node:crypto';
import {open} from 'node:fs/promises';
import {basename} from 'node:path';

import type {ImportReview, ImportRow} from '@shop-things/contract';

const fields = [
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
const digitsPattern = /^\d+$/;
const moneyPattern = /^-?\d+(?:\.\d{1,2})?$/;
const minusPattern = /^-/;
const maxBytes = 10485760;

function parseCsv(text: string): string[][] {
  const records: string[][] = [];
  let cells: string[] = [];
  let cell = '';
  let quoted = false;
  let closed = false;
  let started = false;
  function finish() {
    if (started || cells.length || cell.length) {
      records.push([...cells, cell]);
    }

    cells = [];
    cell = '';
    closed = false;
    started = false;
  }

  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index++;
        } else {
          quoted = false;
          closed = true;
        }
      } else {
        cell += character;
      }

      continue;
    }

    if (character === ',') {
      cells.push(cell);
      cell = '';
      closed = false;
      started = true;
    } else if (character === '\n' || character === '\r') {
      if (character === '\r') {
        if (text[index + 1] !== '\n') {
          throw new Error('Use LF or CRLF record endings.');
        }

        index++;
      }

      finish();
    } else if (character === '"' && cell === '' && !closed) {
      quoted = true;
      started = true;
    } else {
      if (closed || character === '"') {
        throw new Error('Malformed CSV quoting.');
      }

      cell += character;
      started = true;
    }
  }

  if (quoted) {
    throw new Error('A quoted cell is missing its closing quote.');
  }

  finish();
  return records;
}

export async function readCustomerImport(
  path: string,
  session: string
): Promise<ImportReview> {
  const review: ImportReview = {
    importId: randomUUID(),
    session,
    fileName: basename(path),
    status: 'empty',
    rows: [],
    matchGroups: [],
    diagnostics: [],
    sourceRecordCount: 0,
    includedCount: 0,
    skippedCount: 0,
    unresolvedCount: 0,
    choicesResolved: true,
    invalidRecordCount: 0,
    omittedDiagnosticCount: 0,
    numberChangeCount: 0,
  };
  function reject(reason: string, recordNumber: number | null = null, column = 'file') {
    review.status = 'rejected';
    review.rows = [];
    review.diagnostics = [{recordNumber, column, reason}];
    return review;
  }

  const file = await open(path, 'r');
  let bytes: Buffer;
  try {
    if ((await file.stat()).size > maxBytes) {
      return reject('Files must be 10 MiB or smaller.');
    }

    // Bound the read even if another process grows the selected file after stat.
    bytes = Buffer.alloc(maxBytes + 1);
    let size = 0;
    while (size < bytes.length) {
      const result = await file.read(bytes, size, bytes.length - size, null);
      if (!result.bytesRead) {
        break;
      }

      size += result.bytesRead;
    }

    if (size > maxBytes) {
      return reject('Files must be 10 MiB or smaller.');
    }

    bytes = bytes.subarray(0, size);
  } finally {
    await file.close();
  }

  let records: string[][];
  try {
    records = parseCsv(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  } catch (error) {
    return reject(
      error instanceof TypeError
        ? 'The file must contain valid UTF-8 text.'
        : error instanceof Error
          ? error.message
          : 'Malformed CSV.'
    );
  }

  const header = records.shift();
  if (!header) {
    return review;
  }

  if (
    header.length !== fields.length ||
    new Set(header).size !== fields.length ||
    fields.some(field => !header.includes(field))
  ) {
    return reject(
      'Use each of the 14 exported column names exactly once, without changing case or adding spaces.',
      null,
      'header'
    );
  }

  if (records.length > 10000) {
    return reject('Files must contain at most 10,000 customer records.');
  }

  review.sourceRecordCount = records.length;
  const malformed = records.findIndex(record => record.length !== fields.length);
  if (malformed !== -1) {
    return reject('Each customer record must contain exactly 14 cells.', malformed + 1);
  }

  let detailCount = 0;
  records.forEach((cells, index) => {
    const recordNumber = index + 1;
    const source = Object.fromEntries(
      header.map((field, position) => [field, cells[position] ?? ''])
    );
    let invalid = false;
    function diagnostic(column: string, reason: string) {
      invalid = true;
      detailCount++;
      if (review.diagnostics.length < 100) {
        review.diagnostics.push({recordNumber, column, reason});
      }
    }

    function integer(column: 'customerNumber' | 'stock') {
      const value = source[column] ?? '';
      if (column === 'customerNumber' && value === '') {
        return null;
      }

      const number = Number(value);
      if (
        !digitsPattern.test(value) ||
        !Number.isSafeInteger(number) ||
        number < (column === 'stock' ? 0 : 1)
      ) {
        diagnostic(
          column,
          'Enter decimal digits for a safe whole number' +
            (column === 'customerNumber'
              ? ' greater than zero, or leave empty.'
              : ' zero or greater.')
        );
      }

      return number;
    }

    function money(column: 'balance' | 'previousBalance') {
      const value = source[column] ?? '';
      if (!moneyPattern.test(value)) {
        diagnostic(column, 'Enter decimal money with at most two decimal places.');
      } else {
        const [whole = '', fraction = ''] = value.replace(minusPattern, '').split('.');
        const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
        if (cents > 100000000000000n) {
          diagnostic(column, 'Money must not exceed one trillion in absolute value.');
        } else if (
          BigInt(
            Math.round((Number(value.startsWith('-') ? -cents : cents) / 100) * 100)
          ) !== (value.startsWith('-') ? -cents : cents)
        ) {
          diagnostic(column, 'Money must preserve the entered cents exactly.');
        }
      }

      return value;
    }

    if (!source.firstName?.trim() && !source.lastName?.trim()) {
      diagnostic('firstName', 'Enter a first or last name.');
    }

    const sourceCustomerNumber = integer('customerNumber');
    const stock = integer('stock') ?? 0;
    const balance = money('balance');
    const previousBalance = money('previousBalance');
    if (source.donate !== 'true' && source.donate !== 'false') {
      diagnostic('donate', 'Use exactly true or false.');
    }

    const values: ImportRow['values'] = {
      firstName: source.firstName ?? '',
      lastName: source.lastName ?? '',
      address: source.address ?? '',
      city: source.city ?? '',
      province: source.province ?? '',
      postalCode: source.postalCode ?? '',
      phone: source.phone ?? '',
      email: source.email ?? '',
      comments: source.comments ?? '',
      stock,
      balance,
      previousBalance,
      donate: source.donate === 'true',
    };
    if (invalid) {
      review.invalidRecordCount++;
    } else {
      review.rows.push({
        recordNumber,
        sourceCustomerNumber,
        assignedCustomerNumber: null,
        values,
        matches: [],
        choice: 'include',
      });
    }
  });
  review.omittedDiagnosticCount = detailCount - review.diagnostics.length;
  if (review.invalidRecordCount) {
    review.status = 'rejected';
    review.rows = [];
  } else if (review.rows.length) {
    review.status = 'ready';
  }

  return review;
}
