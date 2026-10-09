import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';

import type {AppDatabase} from './index.js';
import {recognizeDatabase} from './lifecycle.js';
export function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export async function fileDigest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

export async function verifySnapshotDatabase(
  db: AppDatabase,
  history: unknown,
  messages: {integrity: string; history: string}
) {
  const integrity = await db.all<{integrity_check: string}>('pragma integrity_check');
  if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
    throw new Error(messages.integrity);
  }

  await recognizeDatabase(db);
  const actual = await db.all('select name,hash from __drizzle_migrations order by id');
  if (digest(actual) !== digest(history)) {
    throw new Error(messages.history);
  }
}
