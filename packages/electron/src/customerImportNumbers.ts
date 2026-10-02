/* oxlint-disable import/no-named-export -- Backend import planning API. */
import type {ImportRow} from '@shop-things/contract';

export function numberCustomerImportRows(
  rows: ImportRow[],
  savedNumbers: Iterable<number | null>,
  includedRecordNumbers?: ReadonlySet<number>
): {rows: ImportRow[]; numberChangeCount: number} {
  const usedNumbers = new Set(savedNumbers);
  const reservations = new Map<number, number>();
  function included(row: ImportRow) {
    return !includedRecordNumbers || includedRecordNumbers.has(row.recordNumber);
  }

  for (const row of rows) {
    if (
      included(row) &&
      row.sourceCustomerNumber !== null &&
      !usedNumbers.has(row.sourceCustomerNumber)
    ) {
      usedNumbers.add(row.sourceCustomerNumber);
      reservations.set(row.recordNumber, row.sourceCustomerNumber);
    }
  }

  let nextNumber = 1;
  let numberChangeCount = 0;
  const numberedRows = rows.map(row => {
    if (!included(row)) {
      return {...row, assignedCustomerNumber: null};
    }

    let assignedCustomerNumber = reservations.get(row.recordNumber);
    if (assignedCustomerNumber === undefined) {
      while (usedNumbers.has(nextNumber)) {
        nextNumber++;
      }

      assignedCustomerNumber = nextNumber;
      usedNumbers.add(assignedCustomerNumber);
      nextNumber++;
    }

    if (assignedCustomerNumber !== row.sourceCustomerNumber) {
      numberChangeCount++;
    }

    return {...row, assignedCustomerNumber};
  });

  return {rows: numberedRows, numberChangeCount};
}
