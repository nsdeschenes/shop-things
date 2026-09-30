/* oxlint-disable import/no-named-export -- In-memory snapshots are private preview simulation state. */
import type {Client, CustomerRecord} from '@shop-things/contract';

interface PreviewSnapshot {
  customers: CustomerRecord[];
  nextId: number;
}

const exports = new WeakMap<Client, CustomerRecord[]>();
const backups = new WeakMap<Client, PreviewSnapshot>();

export function recordPreviewBackup(client: Client, snapshot: PreviewSnapshot) {
  backups.set(client, structuredClone(snapshot));
}

export function getPreviewBackup(client: Client) {
  const snapshot = backups.get(client);
  return snapshot ? structuredClone(snapshot) : null;
}

export function recordPreviewExport(client: Client, customers: CustomerRecord[]) {
  exports.set(client, structuredClone(customers));
}

export function getPreviewExport(client: Client) {
  const customers = exports.get(client);
  return customers ? structuredClone(customers) : null;
}
