/* oxlint-disable import/no-named-export -- Import planning is shared by backend actions. */
import type {ImportReview, ImportRow} from '@shop-things/contract';
import type {CustomerData} from '@shop-things/db';

type Group = ImportReview['matchGroups'][number];
type Reason = Group['reason'];
type Contact = Pick<ImportRow['values'], 'email' | 'phone'>;

function matchKeys(contact: Contact): [Reason, string][] {
  const email = contact.email.trim().toLowerCase();
  const phone = contact.phone.replace(/\D/g, '');
  return [
    ...(email ? [['email', email] as [Reason, string]] : []),
    ...(phone ? [['phone', phone] as [Reason, string]] : []),
  ];
}

// Shared groups keep reviews linear even when all 10,000 rows share a signal.
export function matchCustomerImportRows(
  rows: ImportRow[],
  saved: CustomerData[]
): Pick<ImportReview, 'rows' | 'matchGroups'> {
  const index = new Map<string, Group>();
  function add(contact: Contact, target: Group['targets'][number]) {
    for (const [reason, value] of matchKeys(contact)) {
      const id = JSON.stringify([reason, value]);
      const group = index.get(id) ?? {id, reason, targets: []};
      group.targets.push(target);
      index.set(id, group);
    }
  }

  for (const row of rows) {
    add(row.values, {kind: 'csv', recordNumber: row.recordNumber});
  }

  for (const customer of saved) {
    const {id, customerNumber, firstName, lastName} = customer;
    add(customer, {kind: 'customer', id, customerNumber, firstName, lastName});
  }

  const matchGroups = [...index.values()].filter(
    group =>
      group.targets.length > 1 && group.targets.some(target => target.kind === 'csv')
  );
  const matchingIds = new Set(matchGroups.map(group => group.id));
  return {
    matchGroups,
    rows: rows.map(row => {
      const matches = matchKeys(row.values)
        .map(([reason, value]) => JSON.stringify([reason, value]))
        .filter(id => matchingIds.has(id));
      const collisionFields = new Set(row.collisionFields);
      for (const [reason, value] of matchKeys(row.values)) {
        if (reason !== 'name' && matchingIds.has(JSON.stringify([reason, value]))) {
          collisionFields.add(reason);
        }
      }

      return {
        ...row,
        ...(collisionFields.size ? {collisionFields: [...collisionFields]} : {}),
        matches,
        choice: matches.length ? 'unresolved' : 'include',
      };
    }),
  };
}

export function summarizeCustomerImport(review: ImportReview): ImportReview {
  const includedCount = review.rows.filter(
    row => row.choice === 'include' || row.choice === 'add'
  ).length;
  const skippedCount = review.rows.filter(row => row.choice === 'skip').length;
  const unresolvedCount = review.rows.filter(row => row.choice === 'unresolved').length;
  return {
    ...review,
    includedCount,
    skippedCount,
    unresolvedCount,
    choicesResolved: unresolvedCount === 0,
  };
}
