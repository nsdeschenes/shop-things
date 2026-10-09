import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  cp,
  mkdtemp,
  readFile,
  readdir,
  rm,
  mkdir,
  writeFile,
  chmod,
  stat,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';

import type {CreateCustomerInput} from '@shop-things/contract';
import type {DatabaseHandle} from '@shop-things/db';

const resources = process.argv[2];
const reportPath = process.argv[3];
const inventoryPath = process.argv[4];

assert.ok(
  resources && reportPath && inventoryPath,
  'Packaged runner requires resources and report paths'
);

const archive = join(resources, 'app.asar');
const backendPath = join(archive, 'dist/actionService.js');
const databasePath = join(archive, 'node_modules/@shop-things/db/dist/index.js');
const directory = await mkdtemp(join(tmpdir(), 'shop-things-packaged-backend-'));

const report: Record<string, unknown> = {
  status: 'running',
  startedAt: new Date().toISOString(),
  backendPath,
  databasePath,
  environment: {
    platform: process.platform,
    arch: process.arch,
    versions: process.versions,
  },
  phases: [],
  fixtureDirectory: directory,
};

const phases: string[] = [];

async function digest(path: string) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

function success<T>(
  outcome:
    | {status: 'success'; value: T}
    | {status: 'error'; error: unknown}
    | {status: 'cancelled'}
): T {
  assert.equal(outcome.status, 'success', JSON.stringify(outcome));
  if (outcome.status !== 'success') {
    throw new Error('Expected successful operation');
  }

  return outcome.value;
}

const handles = new Set<DatabaseHandle>();
const services: import('../src/actionService.js').ActionService[] = [];
try {
  const inventory: {commit: string; files: {path: string; sha256: string}[]} = JSON.parse(
    await readFile(inventoryPath, 'utf8')
  );

  assert.ok(inventory.files.length > 10);

  for (const entry of inventory.files) {
    assert.equal(
      await digest(join(archive, entry.path)),
      entry.sha256,
      `Stale shipped artifact: ${entry.path}`
    );
  }

  report.buildInventory = inventory;
  phases.push('shipped-code-matches-current-committed-build-inventory');
  const backend: typeof import('../src/actionService.js') = await import(
    pathToFileURL(backendPath).href
  );

  const db: typeof import('@shop-things/db') = await import(
    pathToFileURL(databasePath).href
  );
  const {FileDatabaseSettings}: typeof import('../src/settings.js') = await import(
    pathToFileURL(join(archive, 'dist/settings.js')).href
  );

  const {DraftCoordinator}: typeof import('../src/draftCoordinator.js') = await import(
    pathToFileURL(join(archive, 'dist/draftCoordinator.js')).href
  );

  report.runtimeDependencies = await Promise.all(
    [
      '@tursodatabase/database',
      'drizzle-orm',
      '@shop-things/db',
      '@shop-things/contract',
    ].map(async name => {
      const manifest: {version: string} = JSON.parse(
        await readFile(join(archive, 'node_modules', name, 'package.json'), 'utf8')
      );
      return {name, version: manifest.version};
    })
  );

  const migrationsFolder = join(resources, 'migrations');
  const migrationBackupDirectory = join(directory, 'migration-backups');
  const paths = {
    working: join(directory, 'working.db'),
    backup: join(directory, 'snapshot.db'),
    restored: join(directory, 'restored.db'),
    csv: join(directory, 'customers.csv'),
    pending: join(directory, 'pending.db'),
    pendingRestored: join(directory, 'pending-restored.db'),
  };

  const createPath: string | null = paths.working;
  let openPath: string | null = null;
  let restoreSource: string | null = paths.backup;
  let restoreDestination: string | null = paths.restored;
  const settings = new FileDatabaseSettings(join(directory, 'settings.json'));
  const diagnostics: string[] = [];
  async function track(promise: Promise<DatabaseHandle>) {
    const handle = await promise;
    handles.add(handle);
    return {
      db: handle.db,
      close() {
        handle.close();
        handles.delete(handle);
      },
    };
  }

  function makeService() {
    const drafts = new DraftCoordinator();
    const participant = {
      documentId: 'packaged-participant',
      prepare(request: import('@shop-things/contract').DraftRequest) {
        drafts.reply(participant, {...request, hasUnsavedDraft: false});
      },
      resolve() {},
    };
    drafts.register(participant);
    const service = new backend.ActionService({
      migrationsFolder,
      migrationBackupDirectory,
      settings,
      drafts,
      dialogs: {
        createDatabase: async () => createPath,
        openDatabase: async () => openPath,
        importCsv: async () => null,
        exportCsv: async () => paths.csv,
        backupDatabase: async () => paths.backup,
        restoreSource: async () => restoreSource,
        restoreDestination: async () => restoreDestination,
        confirmDiscard: async () => true,
      },
      database: {
        ...backend.databaseOperations,
        createDatabase: (...args) => track(db.createDatabase(...args)),
        openExistingDatabase: (...args) => track(db.openExistingDatabase(...args)),
      },
      logError: error => diagnostics.push(String(error)),
    });
    services.push(service);
    return service;
  }

  async function inspect(path: string) {
    const handle = await db.openExistingDatabase(path, {migrationsFolder});
    try {
      return await db.listCustomers(handle.db);
    } finally {
      handle.close();
    }
  }

  const values: CreateCustomerInput = {
    firstName: 'Alice',
    lastName: 'Smith',
    address: '',
    city: '',
    province: '',
    postalCode: '',
    phone: '',
    email: '',
    stock: 0,
    balance: '12.34',
    previousBalance: '-1.23',
    donate: false,
    comments: 'Saved, "quoted"\nsecond line',
  };
  const service = makeService();
  await service.start();
  assert.equal(service.status().available, false);
  assert.equal(handles.size, 0);

  const createdState = success(await service.handlers['database.create']());
  assert.ok(createdState.session);

  const session = createdState.session;
  assert.equal(await settings.read(), paths.working);

  const customer = success(await service.handlers['customers.create']({session, values}));
  assert.equal(customer.customer.balance, '12.34');
  assert.equal(customer.customer.customerNumber, 1);

  const second = success(
    await service.handlers['customers.create']({
      session,
      values: {...values, firstName: 'Other', lastName: 'Jones', comments: ''},
    })
  );
  assert.equal(
    success(await service.handlers['customers.list']({session, query: ' sMiTh '})).length,
    1
  );
  assert.equal(
    success(
      await service.handlers['customers.list']({
        session,
        query: String(second.customer.customerNumber),
      })
    )[0]?.customer.id,
    second.customer.id
  );
  assert.deepEqual(
    success(await service.handlers['customers.get']({session, id: customer.customer.id})),
    customer
  );

  const updated = success(
    await service.handlers['customers.update']({
      reference: customer.reference,
      changes: {stock: 2, balance: '23.45'},
    })
  );
  assert.equal(updated.customer.balance, '23.45');

  const stale = await service.handlers['customers.update']({
    reference: customer.reference,
    changes: {stock: 9},
  });
  assert.equal(stale.status, 'error');

  if (stale.status === 'error') {
    assert.equal(stale.error.code, 'STALE_REVISION');
  }

  const unicode = success(
    await service.handlers['customers.create']({
      session,
      values: {...values, firstName: 'ÉMILIE', lastName: 'ÅNGSTRÖM', comments: ''},
    })
  );

  const literal = success(
    await service.handlers['customers.create']({
      session,
      values: {
        ...values,
        firstName: "Literal .* [ \\ %_ '",
        lastName: 'Literal',
        comments: '',
      },
    })
  );

  for (const query of ['éMi', ' åNgStrÖm ']) {
    assert.deepEqual(
      success(await service.handlers['customers.list']({session, query})).map(
        record => record.customer.id
      ),
      [unicode.customer.id]
    );
  }

  for (const query of ['.*', '[', '\\', '%_', "'"]) {
    assert.deepEqual(
      success(await service.handlers['customers.list']({session, query})).map(
        record => record.customer.id
      ),
      [literal.customer.id]
    );
  }

  assert.deepEqual(
    success(await service.handlers['customers.list']({session, query: '(?i)smith|.*'})),
    []
  );
  phases.push('shipped-native-Unicode-casefold/literal-metacharacter-search');
  phases.push('current-schema/customer-crud/search/revisions');
  success(await service.handlers['exports.csv']({session}));

  const csv = await readFile(paths.csv, 'utf8');
  assert.ok(csv.includes('"Other"'));
  assert.ok(csv.includes('"23.45"'));
  assert.ok(csv.includes('"Saved, ""quoted""\nsecond line"'));
  success(await service.handlers['database.backup']({session}));

  const backupHash = await digest(paths.backup);
  assert.equal(
    (await inspect(paths.backup)).find(row => row.id === customer.customer.id)?.balance,
    '23.45'
  );
  success(
    await service.handlers['customers.update']({
      reference: updated.reference,
      changes: {balance: '99.99'},
    })
  );

  const restored = success(await service.handlers['database.restore']());
  assert.ok(restored.session);
  assert.notEqual(restored.session, session);
  assert.equal(restored.selectedPath, paths.restored);
  assert.equal(await digest(paths.backup), backupHash);
  assert.equal(
    (await inspect(paths.working)).find(row => row.id === customer.customer.id)?.balance,
    '99.99'
  );
  assert.equal(
    (await inspect(paths.restored)).find(row => row.id === customer.customer.id)?.balance,
    '23.45'
  );
  const old = await service.handlers['customers.delete']({reference: updated.reference});
  assert.equal(old.status, 'error');
  if (old.status === 'error') {
    assert.equal(old.error.code, 'STALE_SESSION');
  }

  phases.push(
    'saved-csv/snapshot/separate-restore/source-preservation/session-invalidation'
  );
  // Cancelled and invalid candidates preserve the current session and its references.
  const before = service.status();
  openPath = null;
  assert.equal((await service.handlers['database.open']()).status, 'cancelled');
  assert.deepEqual(service.status(), before);
  openPath = join(directory, 'unrelated.db');
  const unrelated = db.openDatabase(openPath);
  await unrelated.db.run('create table legacy (name text)');
  unrelated.close();
  assert.equal((await service.handlers['database.open']()).status, 'error');
  assert.deepEqual(service.status(), before);
  openPath = join(directory, 'readonly.db');
  const readonlySource = await db.openExistingDatabase(paths.restored, {
    migrationsFolder,
  });
  try {
    await db.backupDatabase(readonlySource.db, openPath);
  } finally {
    readonlySource.close();
  }

  await chmod(openPath, 0o444);
  assert.equal((await service.handlers['database.open']()).status, 'error');
  await chmod(openPath, 0o600);
  assert.deepEqual(service.status(), before);
  success(await service.requestClose());
  assert.equal(handles.size, 0);
  const reopened = makeService();
  await reopened.start();
  assert.ok(reopened.status().session);
  const reopenedSession = reopened.status().session;
  assert.ok(reopenedSession);
  assert.notEqual(reopenedSession, restored.session);
  assert.equal(reopened.status().selectedPath, paths.restored);
  const reloaded = success(
    await reopened.handlers['customers.get']({
      session: reopenedSession,
      id: customer.customer.id,
    })
  );
  success(await reopened.handlers['customers.delete']({reference: reloaded.reference}));
  success(await reopened.requestClose());
  assert.equal(handles.size, 0);
  assert.equal(
    (await inspect(paths.restored)).some(row => row.id === customer.customer.id),
    false
  );
  phases.push('cancelled/invalid-candidate/remembered-reopen/delete/connection-closure');
  const missingPath = join(directory, 'missing.db');
  await settings.write(missingPath);
  const recovery = makeService();
  await recovery.start();
  assert.equal(recovery.status().available, false);
  assert.equal(recovery.status().selectedPath, missingPath);
  assert.equal((await recovery.handlers['database.retry']()).status, 'error');
  const missingInfo = await readFile(missingPath).then(
    () => 'exists',
    () => 'missing'
  );
  assert.equal(missingInfo, 'missing');
  openPath = paths.restored;
  success(await recovery.handlers['database.open']());
  success(await recovery.requestClose());
  assert.equal(handles.size, 0);
  phases.push('missing-remembered-path/retry/no-silent-replacement/open-recovery');
  // Build the pending fixture from shipped initial migration SQL, with no host fixture imports.
  const initial = '20260929093112_wealthy_hemingway';
  const initialOnly = join(directory, 'initial-migrations');
  await mkdir(initialOnly);
  await cp(join(migrationsFolder, initial), join(initialOnly, initial), {
    recursive: true,
  });
  const pending = db.openDatabase(paths.pending);
  await db.runMigrations(pending.db, {migrationsFolder: initialOnly});
  await pending.db.run(
    "insert into customers (customerNumber,firstName,balance) values (7,'Pending',12.34)"
  );
  pending.close();
  const pendingHash = await digest(paths.pending);
  restoreSource = paths.pending;
  restoreDestination = paths.pendingRestored;
  await settings.write(paths.restored);
  const pendingService = makeService();
  await pendingService.start();
  const pendingState = success(await pendingService.handlers['database.restore']());
  assert.ok(pendingState.session);
  assert.equal(await digest(paths.pending), pendingHash);
  const pendingRows = success(
    await pendingService.handlers['customers.list']({
      session: pendingState.session,
      query: '',
    })
  );
  assert.equal(pendingRows[0]?.customer.customerNumber, 7);
  assert.equal(pendingRows[0]?.customer.balance, '12.34');
  assert.equal(pendingRows[0]?.reference.revision, '1');
  success(await pendingService.requestClose());
  const migrated = await db.openExistingDatabase(paths.pendingRestored, {
    migrationsFolder,
  });
  try {
    const shippedMigrations = (await readdir(migrationsFolder, {withFileTypes: true}))
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
      .sort();
    const appliedMigrations = await migrated.db.all<{name: string}>(
      'select name from __drizzle_migrations order by id'
    );
    assert.deepEqual(
      appliedMigrations.map(migration => migration.name),
      shippedMigrations
    );
    const next = await db.createCustomer(migrated.db, {firstName: 'After migration'});
    assert.equal(next.customerNumber, 1);
  } finally {
    migrated.close();
  }

  const original = db.openDatabase(paths.pending);
  try {
    assert.equal(
      (await original.db.all('select name from __drizzle_migrations')).length,
      1
    );
    assert.equal(
      (await original.db.all<{name: string}>('pragma table_info(customers)')).some(
        column => column.name === 'revision'
      ),
      false
    );
  } finally {
    original.close();
  }

  assert.equal(await digest(paths.pending), pendingHash);
  assert.equal(handles.size, 0);
  phases.push('shipped-pending-migration/source-preserving-migrating-restore');
  // Execute snapshot recovery through the shipped public APIs and actual addon.
  async function copyPendingFixture(destination: string) {
    const source = db.openDatabase(paths.pending);
    try {
      // Turso can retain committed WAL after close: a raw file copy is incomplete.
      await db.backupDatabase(source.db, destination);
    } finally {
      source.close();
    }
  }

  const startupPath = join(directory, 'startup-pending.db');
  await copyPendingFixture(startupPath);
  await settings.write(startupPath);
  const startupService = makeService();
  await startupService.start();
  const startupSession = startupService.status().session;
  assert.ok(
    startupSession,
    JSON.stringify({startup: startupService.status(), diagnostics})
  );
  const snapshots = await db.listMigrationSnapshots(migrationBackupDirectory);
  assert.equal(snapshots.unavailableCount, 0);
  const startupSnapshot = snapshots.snapshots.find(
    snapshot => snapshot.canonicalSource === startupPath
  );
  assert.ok(startupSnapshot);
  assert.equal((await stat(startupSnapshot.snapshotPath)).mode & 0o777, 0o600);
  assert.equal(
    (await stat(join(startupSnapshot.snapshotPath, '..'))).mode & 0o777,
    0o700
  );
  assert.deepEqual(
    startupSnapshot.sourceHistory.map(row => row.name),
    [initial]
  );
  const snapshotHash = await digest(startupSnapshot.snapshotPath);
  const recoveredCopy = join(directory, 'recovered-snapshot.db');
  await db.restoreMigrationSnapshot(startupSnapshot, recoveredCopy);
  assert.equal(await digest(startupSnapshot.snapshotPath), snapshotHash);
  const recoveredHandle = db.openDatabase(recoveredCopy);
  try {
    assert.deepEqual(
      await recoveredHandle.db.all('select name from __drizzle_migrations'),
      [{name: initial}]
    );
    assert.deepEqual(await recoveredHandle.db.all('pragma integrity_check'), [
      {integrity_check: 'ok'},
    ]);
  } finally {
    recoveredHandle.close();
  }

  await assert.rejects(
    db.openExistingDatabase(startupPath, {migrationsFolder: initialOnly}),
    /migration history does not match/
  );
  const current = await db.openExistingDatabase(startupPath, {
    migrationsFolder,
    migrationBackupDirectory,
  });
  current.close();
  assert.equal(
    (await db.listMigrationSnapshots(migrationBackupDirectory)).snapshots.length,
    snapshots.snapshots.length
  );

  const snapshotState = success(
    await startupService.handlers['database.listMigrationSnapshots']({})
  );
  const selected = snapshotState.snapshots.find(
    snapshot => snapshot.sourcePath === startupPath
  );
  assert.ok(selected);
  restoreDestination = join(directory, 'restored-selected-snapshot.db');
  const restoredSnapshot = success(
    await startupService.handlers['database.restoreMigrationSnapshot']({
      snapshotId: selected.snapshotId,
    })
  );
  assert.ok(restoredSnapshot.session && restoredSnapshot.session !== startupSession);
  assert.equal(await digest(startupSnapshot.snapshotPath), snapshotHash);
  assert.equal(
    success(
      await startupService.handlers['customers.list']({
        session: restoredSnapshot.session,
        query: '',
      })
    )[0]?.customer.firstName,
    'Pending'
  );
  const laterPath = join(directory, 'later-pending.db');
  await copyPendingFixture(laterPath);
  openPath = laterPath;
  const laterState = success(await startupService.handlers['database.open']());
  assert.ok(laterState.session);
  assert.ok(
    (await db.listMigrationSnapshots(migrationBackupDirectory)).snapshots.some(
      snapshot => snapshot.canonicalSource === laterPath
    )
  );
  const failedPath = join(directory, 'failed-pending.db');
  await copyPendingFixture(failedPath);
  const unavailableBackup = join(directory, 'unavailable-backup');
  await writeFile(unavailableBackup, 'not a directory');
  await assert.rejects(
    db.openExistingDatabase(failedPath, {
      migrationsFolder,
      migrationBackupDirectory: unavailableBackup,
    }),
    /Cannot preserve a verified migration backup/
  );
  const untouched = db.openDatabase(failedPath);
  try {
    assert.deepEqual(await untouched.db.all('select name from __drizzle_migrations'), [
      {name: initial},
    ]);
  } finally {
    untouched.close();
  }

  const brokenFolder = join(directory, 'copied-failing-migrations');
  await cp(migrationsFolder, brokenFolder, {recursive: true});
  const injected = join(brokenFolder, '20991231235959_qualification_failure');
  await mkdir(injected);
  await writeFile(
    join(injected, 'migration.sql'),
    'INSERT INTO qualification_missing_table VALUES(1);'
  );
  const failedBackups = join(directory, 'failed-migration-backups');
  for (let attempt = 0; attempt < 2; attempt++) {
    await assert.rejects(
      db.openExistingDatabase(failedPath, {
        migrationsFolder: brokenFolder,
        migrationBackupDirectory: failedBackups,
      }),
      /qualification_missing_table/
    );
  }

  const retainedFailures = await db.listMigrationSnapshots(failedBackups);
  assert.equal(retainedFailures.snapshots.length, 2);
  assert.equal(retainedFailures.unavailableCount, 0);
  assert.notEqual(
    retainedFailures.snapshots[0]?.snapshotPath,
    retainedFailures.snapshots[1]?.snapshotPath
  );
  for (const snapshot of retainedFailures.snapshots) {
    const handle = db.openDatabase(snapshot.snapshotPath);
    try {
      assert.deepEqual(await handle.db.all('select name from __drizzle_migrations'), [
        {name: initial},
      ]);
    } finally {
      handle.close();
    }
  }

  report.migrationFailureFixture = {
    scope: 'temporary copy of shipped migrations with one intentionally failing SQL file',
    addedSqlSha256: await digest(join(injected, 'migration.sql')),
  };
  phases.push(
    'shipped-public-api/copied-failing-migration/distinct-retained-snapshots/explicit-retries'
  );
  assert.equal(startupService.status().session, laterState.session);
  assert.equal(
    success(
      await startupService.handlers['customers.list']({
        session: laterState.session,
        query: '',
      })
    )[0]?.customer.firstName,
    'Pending'
  );
  success(await startupService.requestClose());

  const writerPath = join(directory, 'writer-pending.db');
  await copyPendingFixture(writerPath);
  const owner = db.openDatabase(writerPath);
  function externalWriter() {
    return spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      const db = await import(process.argv[1]);
      try { const handle = db.openDatabase(process.argv[2]); await handle.db.run("insert into customers(customerNumber,firstName) values(99,'External')"); handle.close(); }
      catch(error) {
        // Drizzle wraps the native lock error; retain its bounded cause chain.
        let cause = error;
        for (let depth = 0; cause && depth < 8; depth++) {
          console.error(String(cause.message ?? cause).slice(0, 1024));
          cause = cause.cause;
        }
        process.exitCode = 2;
      }
    `,
        pathToFileURL(databasePath).href,
        writerPath,
      ],
      {
        encoding: 'utf8',
        timeout: 15000,
        maxBuffer: 65536,
        env: {...process.env, ELECTRON_RUN_AS_NODE: '1'},
      }
    );
  }

  try {
    await owner.db.all('select * from customers');
    await owner.db.run(
      "insert into customers(customerNumber,firstName,balance) values(88,'Committed journal',1)"
    );
    const journalSnapshot = join(directory, 'committed-journal.db');
    await db.backupDatabase(owner.db, journalSnapshot);
    const journal = db.openDatabase(journalSnapshot);
    try {
      assert.deepEqual(
        (
          await journal.db.all<{firstName: string}>(
            'select firstName from customers order by customerNumber'
          )
        ).map(row => row.firstName),
        ['Pending', 'Committed journal']
      );
    } finally {
      journal.close();
    }

    const blocked = externalWriter();
    assert.equal(blocked.status, 2, blocked.stderr);
    assert.match(blocked.stderr, /locked by another process/);
    await db.runMigrations(owner.db, {migrationsFolder});
    const stillBlocked = externalWriter();
    assert.equal(stillBlocked.status, 2, stillBlocked.stderr);
    assert.match(stillBlocked.stderr, /locked by another process/);
  } finally {
    owner.close();
  }

  const permitted = externalWriter();
  assert.equal(permitted.status, 0, permitted.stderr);
  phases.push(
    'shipped-startup-and-later-open/private-migration-snapshot/no-repeat/older-app-rejection'
  );
  phases.push(
    'shipped-validated-separate-snapshot-restore/opaque-selected-restore/source-preservation'
  );
  phases.push(
    'shipped-real-storage-path-failure/unchanged-history/active-session-preservation'
  );
  report.externalWriterProof =
    'Actual separate process rejected before/after migration with retained owner; no claim of observed inner snapshot/migration overlap';
  phases.push(
    'shipped-committed-journal-snapshot/retained-owner-external-writer-exclusion/positive-control'
  );

  // Inspect bundled preload and its esbuild manifest without attaching or executing it.
  const preloadPath = join(archive, 'dist/preload.cjs');
  const preload = await readFile(preloadPath, 'utf8');
  assert.ok(preload.length > 1000);
  const meta: {
    inputs: Record<string, unknown>;
    outputs: Record<string, {imports: {path: string; external?: boolean}[]}>;
  } = JSON.parse(await readFile(join(archive, 'dist/preload.meta.json'), 'utf8'));
  const inputs = Object.keys(meta.inputs);
  assert.ok(inputs.some(path => path.includes('zod')));
  assert.ok(inputs.some(path => path.includes('contract/dist/schemas')));
  assert.ok(inputs.some(path => path.includes('preloadBridge')));
  assert.equal(
    inputs.some(
      path =>
        path.includes('actionService') ||
        path.includes('/db/') ||
        path.startsWith('node:')
    ),
    false
  );
  const imports = Object.values(meta.outputs).flatMap(output => output.imports);
  assert.ok(imports.some(entry => entry.path === 'electron' && entry.external));
  assert.ok(imports.every(entry => entry.path === 'electron' && entry.external));
  phases.push('bundled-preload-presence/dependencies-inspected-without-execution');
  report.phases = phases;
  report.status = 'passed';
  report.files = {
    csv: await digest(paths.csv),
    backup: backupHash,
    pendingSource: pendingHash,
    preload: await digest(preloadPath),
  };
  report.openConnections = handles.size;
  report.diagnostics = diagnostics;
} catch (error) {
  report.status = 'failed';
  report.phases = phases;
  report.error =
    error instanceof Error ? {message: error.message, stack: error.stack} : String(error);
  process.exitCode = 1;
} finally {
  for (const service of services) {
    try {
      service.closeUnprotected();
    } catch {}
  }

  for (const handle of handles) {
    try {
      handle.close();
    } catch {}
  }

  report.finishedAt = new Date().toISOString();
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  if (report.status === 'passed') {
    await rm(directory, {recursive: true, force: true});
  }
}

process.stdout.write(JSON.stringify(report) + '\n');
