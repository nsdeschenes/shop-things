import {randomUUID} from 'node:crypto';
import {chmod, lstat, mkdir, open, realpath, rename, rm, stat} from 'node:fs/promises';
import {dirname, isAbsolute, join} from 'node:path';

import {readMigrationFiles} from 'drizzle-orm/migrator';

import {DatabaseError} from './customers.js';
import {openDatabase} from './index.js';
import type {AppDatabase} from './index.js';
import {backupDatabase} from './lifecycle.js';
import {digest, fileDigest, verifySnapshotDatabase} from './snapshotVerification.js';

async function privateDirectory(path: string) {
  await mkdir(path, {recursive: true, mode: 0o700});
  if (!(await lstat(path)).isDirectory()) {
    throw new Error('Migration backup location must be a directory, not a symbolic link');
  }

  await chmod(path, 0o700);
}

async function syncPath(path: string) {
  const file = await open(path, 'r');
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

export async function snapshotBeforeMigrations(
  db: AppDatabase,
  source: string,
  options: {migrationsFolder: string; migrationBackupDirectory?: string}
): Promise<void> {
  const sourceHistory = await db.all<{name: string; hash: string}>(
    'select name,hash from __drizzle_migrations order by id'
  );
  const targetMigrations = readMigrationFiles(options).map(({name, hash}) => ({
    name,
    hash,
  }));
  if (
    sourceHistory.length > targetMigrations.length ||
    sourceHistory.some(
      (row, index) =>
        row.name !== targetMigrations[index]?.name ||
        row.hash !== targetMigrations[index]?.hash
    )
  ) {
    throw new DatabaseError(
      'UNSUPPORTED_DATABASE',
      'Database migration history does not match this application'
    );
  }

  if (sourceHistory.length === targetMigrations.length) {
    return;
  }

  let pendingDirectory: string | undefined;
  try {
    const canonicalSource = await realpath(source);
    const sourceInfo = await stat(source);
    const root =
      options.migrationBackupDirectory ?? join(dirname(source), '.migration-backups');
    if (!isAbsolute(root)) {
      throw new Error('Migration backup directory must be absolute');
    }

    await privateDirectory(root);
    const sourceDirectory = join(root, digest(canonicalSource));
    await privateDirectory(sourceDirectory);
    const attempt = `${Date.now()}-${randomUUID()}`;
    pendingDirectory = join(sourceDirectory, `.pending-${attempt}`);
    await mkdir(pendingDirectory, {mode: 0o700});
    const publishedDirectory = join(sourceDirectory, attempt);
    const snapshot = join(pendingDirectory, 'snapshot.db');

    // Turso rejects existing output files. Exclusive directory creation and its
    // private permissions protect the engine-created snapshot until publication.
    await backupDatabase(db, snapshot);
    await chmod(snapshot, 0o600);
    const backup = openDatabase(snapshot);
    try {
      await verifySnapshotDatabase(backup.db, sourceHistory, {
        integrity: 'Migration snapshot integrity check failed',
        history: 'Migration snapshot history differs from source',
      });
    } finally {
      backup.close();
    }

    await syncPath(snapshot);
    const metadata = await open(join(pendingDirectory, 'metadata.json'), 'wx', 0o600);
    try {
      await metadata.writeFile(
        JSON.stringify({
          schemaVersion: 1,
          attempt,
          canonicalSource,
          sourceIdentity: {device: sourceInfo.dev, inode: sourceInfo.ino},
          sourceHistory,
          targetMigrations,
          sourceHistoryDigest: digest(sourceHistory),
          targetHistoryDigest: digest(targetMigrations),
          snapshotPath: join(publishedDirectory, 'snapshot.db'),
          snapshotDigest: await fileDigest(snapshot),
        })
      );
      await metadata.sync();
    } finally {
      await metadata.close();
    }

    await syncPath(pendingDirectory);
    await rename(pendingDirectory, publishedDirectory);
    pendingDirectory = undefined;
    await syncPath(sourceDirectory);
    await syncPath(root);
    await syncPath(dirname(root));
  } catch (error) {
    if (pendingDirectory) {
      await rm(pendingDirectory, {recursive: true, force: true}).catch(() => {});
    }

    throw new DatabaseError(
      'MIGRATION_BACKUP_FAILED',
      `Cannot preserve a verified migration backup; retry or open a writable copy: ${error instanceof Error ? error.message : 'Unknown backup failure'}`
    );
  }
}
