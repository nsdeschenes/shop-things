import {isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';

import {openDatabase, runMigrations} from '@shop-things/db';

const args = process.argv.slice(2);
const databaseOption = args.indexOf('--database');
const databaseFilePath = args[databaseOption + 1];

if (
  args.length !== 2 ||
  databaseOption !== 0 ||
  !databaseFilePath ||
  !isAbsolute(databaseFilePath)
) {
  throw new Error('Usage: migrations:apply --database <absolute database file path>');
}

const migrationsFolder = fileURLToPath(new URL('../migrations', import.meta.url));
const handle = openDatabase(databaseFilePath);

try {
  await runMigrations(handle.db, {migrationsFolder});
} finally {
  handle.close();
}
