import {createHash} from 'node:crypto';
import {constants, createReadStream} from 'node:fs';
import {chmod, copyFile, lstat, open, readFile, readdir, rm} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join} from 'node:path';

import {DatabaseError} from './customers.js';
import {openDatabase} from './index.js';
import {recognizeDatabase} from './lifecycle.js';

interface MigrationHistory {
  name: string;
  hash: string;
}
export interface MigrationSnapshot {
  snapshotPath: string;
  canonicalSource: string;
  createdAt: string;
  sourceHistory: MigrationHistory[];
  targetMigrations: MigrationHistory[];
  snapshotDigest: string;
  metadataDigest: string;
}

const hashPattern = /^[a-f0-9]{64}$/;
const attemptPattern =
  /^\d{10,16}-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function digest(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function fileDigest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }

  return hash.digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function history(value: unknown): MigrationHistory[] {
  if (!Array.isArray(value) || !value.length || value.length > 256) {
    throw new Error('Invalid snapshot migration history');
  }

  return value.map((row: unknown) => {
    if (
      !isRecord(row) ||
      Object.keys(row).length !== 2 ||
      typeof row.name !== 'string' ||
      row.name.length > 255 ||
      !row.name.length ||
      typeof row.hash !== 'string' ||
      !hashPattern.test(row.hash)
    ) {
      throw new Error('Invalid snapshot migration history');
    }

    return {name: row.name, hash: row.hash};
  });
}

async function readSnapshot(directory: string): Promise<MigrationSnapshot> {
  const attempt = basename(directory);
  const sourceDirectory = dirname(directory);
  if (
    !attemptPattern.test(attempt) ||
    !hashPattern.test(basename(sourceDirectory)) ||
    !(await lstat(directory)).isDirectory() ||
    !(await lstat(sourceDirectory)).isDirectory()
  ) {
    throw new Error('Invalid snapshot directory');
  }

  const metadataPath = join(directory, 'metadata.json');
  const info = await lstat(metadataPath);
  if (!info.isFile() || info.size > 64 * 1024) {
    throw new Error('Invalid snapshot metadata file');
  }

  const bytes = await readFile(metadataPath);
  const metadata: unknown = JSON.parse(bytes.toString('utf8'));
  if (
    !isRecord(metadata) ||
    Object.keys(metadata).length !== 10 ||
    metadata.schemaVersion !== 1 ||
    metadata.attempt !== attempt ||
    typeof metadata.canonicalSource !== 'string' ||
    !isAbsolute(metadata.canonicalSource) ||
    metadata.canonicalSource.length > 4096 ||
    metadata.canonicalSource.includes('\0') ||
    digest(metadata.canonicalSource) !== basename(sourceDirectory) ||
    !isRecord(metadata.sourceIdentity) ||
    !Number.isSafeInteger(metadata.sourceIdentity.device) ||
    !Number.isSafeInteger(metadata.sourceIdentity.inode)
  ) {
    throw new Error('Invalid snapshot metadata');
  }

  const sourceHistory = history(metadata.sourceHistory);
  const targetMigrations = history(metadata.targetMigrations);
  const snapshotPath = join(directory, 'snapshot.db');
  if (
    metadata.snapshotPath !== snapshotPath ||
    !(await lstat(snapshotPath)).isFile() ||
    typeof metadata.snapshotDigest !== 'string' ||
    !hashPattern.test(metadata.snapshotDigest) ||
    metadata.sourceHistoryDigest !== digest(sourceHistory) ||
    metadata.targetHistoryDigest !== digest(targetMigrations) ||
    sourceHistory.some(
      (row, index) =>
        row.name !== targetMigrations[index]?.name ||
        row.hash !== targetMigrations[index]?.hash
    )
  ) {
    throw new Error('Snapshot identity or history does not match');
  }

  return {
    snapshotPath,
    canonicalSource: metadata.canonicalSource,
    createdAt: new Date(Number(attempt.split('-')[0])).toISOString(),
    sourceHistory,
    targetMigrations,
    snapshotDigest: metadata.snapshotDigest,
    metadataDigest: createHash('sha256').update(bytes).digest('hex'),
  };
}

export async function listMigrationSnapshots(
  root: string
): Promise<{snapshots: MigrationSnapshot[]; unavailableCount: number}> {
  if (!isAbsolute(root)) {
    throw new DatabaseError('VALIDATION', 'Snapshot directory must be absolute');
  }

  const snapshots: MigrationSnapshot[] = [];
  let unavailableCount = 0;
  try {
    if (!(await lstat(root)).isDirectory()) {
      throw new Error('Snapshot location must be a directory');
    }

    for (const source of await readdir(root)) {
      if (!hashPattern.test(source)) {
        continue;
      }

      const sourceDirectory = join(root, source);
      if (!(await lstat(sourceDirectory)).isDirectory()) {
        unavailableCount++;
        continue;
      }

      for (const attempt of await readdir(sourceDirectory)) {
        if (!attemptPattern.test(attempt)) {
          continue;
        }

        try {
          snapshots.push(await readSnapshot(join(sourceDirectory, attempt)));
        } catch {
          unavailableCount++;
        }
      }
    }
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return {snapshots, unavailableCount};
    }

    throw new DatabaseError(
      'SNAPSHOT_UNAVAILABLE',
      'Migration snapshots could not be read. Check backup folder permissions, then retry.'
    );
  }

  snapshots.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return {snapshots, unavailableCount};
}

export async function restoreMigrationSnapshot(
  snapshot: MigrationSnapshot,
  destination: string
): Promise<void> {
  if (!isAbsolute(destination)) {
    throw new DatabaseError('VALIDATION', 'Restore destination must be absolute');
  }

  let copied = false;
  try {
    const current = await readSnapshot(dirname(snapshot.snapshotPath));
    if (
      current.metadataDigest !== snapshot.metadataDigest ||
      (await fileDigest(snapshot.snapshotPath)) !== current.snapshotDigest
    ) {
      throw new Error('Snapshot changed or failed checksum validation');
    }

    for (const path of [destination, destination + '-wal', destination + '-shm']) {
      try {
        await lstat(path);
        throw new Error('Restore destination already exists; choose a new file');
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
          throw error;
        }
      }
    }

    await copyFile(snapshot.snapshotPath, destination, constants.COPYFILE_EXCL);
    copied = true;
    await chmod(destination, 0o600);
    if ((await fileDigest(destination)) !== current.snapshotDigest) {
      throw new Error('Recovered copy failed checksum validation');
    }

    const handle = openDatabase(destination);
    try {
      const integrity = await handle.db.all<{integrity_check: string}>(
        'pragma integrity_check'
      );
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') {
        throw new Error('Recovered copy failed integrity validation');
      }

      await recognizeDatabase(handle.db);
      const recoveredHistory = await handle.db.all(
        'select name,hash from __drizzle_migrations order by id'
      );
      if (digest(recoveredHistory) !== digest(current.sourceHistory)) {
        throw new Error('Recovered migration history differs from snapshot');
      }
    } finally {
      handle.close();
    }

    for (const path of [destination, dirname(destination)]) {
      const file = await open(path, 'r');
      try {
        await file.sync();
      } finally {
        await file.close();
      }
    }
  } catch (error) {
    if (copied) {
      for (const suffix of ['', '-wal', '-shm']) {
        await rm(destination + suffix, {force: true});
      }
    }

    if (error instanceof DatabaseError) {
      throw error;
    }

    throw new DatabaseError(
      'SNAPSHOT_UNAVAILABLE',
      'The migration snapshot could not be restored into a validated copy. Refresh snapshots or choose another destination, then retry.'
    );
  }
}
