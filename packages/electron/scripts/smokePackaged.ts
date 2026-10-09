import assert from 'node:assert/strict';
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
  lstat,
  readlink,
} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, relative} from 'node:path';
import {pathToFileURL} from 'node:url';

import type {CreateCustomerInput} from '@shop-things/contract';
import type {DatabaseHandle} from '@shop-things/db';

const resources = process.argv[2];
const reportPath = process.argv[3];
const inventoryPath = process.argv[4];
const packageProofPath = process.argv[5];
const installerRoot = process.argv[6];

assert.ok(
  resources && reportPath && inventoryPath && packageProofPath && installerRoot,
  'Packaged runner requires resources and report paths'
);

const archive = join(resources, 'app.asar');
const {promises: originalFiles}: typeof import('node:fs') = createRequire(
  import.meta.url
)('original-fs');
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

async function digest(path: string, reader = readFile) {
  return createHash('sha256')
    .update(await reader(path))
    .digest('hex');
}

type PackageEntry = {
  path: string;
  kind: 'directory' | 'file' | 'symlink';
  mode: number;
  size?: number;
  sha256?: string;
  target?: string;
  package?: {name?: string; version?: string};
};

async function packageContents(root: string, folder = root): Promise<PackageEntry[]> {
  const entries: PackageEntry[] = [];
  const files = root === archive ? {readdir, lstat, readlink, readFile} : originalFiles;
  for (const name of (await files.readdir(folder)).sort()) {
    const path = join(folder, name);
    const info = await files.lstat(path);
    const entry = {path: relative(root, path), mode: info.mode & 0o7777};
    if (info.isSymbolicLink()) {
      entries.push({...entry, kind: 'symlink', target: await files.readlink(path)});
    } else if (info.isDirectory()) {
      entries.push({...entry, kind: 'directory'});
      entries.push(...(await packageContents(root, path)));
    } else {
      assert.ok(info.isFile(), `Unsupported packaged entry: ${path}`);
      const file: PackageEntry = {
        ...entry,
        kind: 'file',
        size: info.size,
        sha256: await digest(path, files.readFile),
      };
      if (name === 'package.json') {
        const manifest = JSON.parse(await files.readFile(path, 'utf8'));
        file.package = {name: manifest.name, version: manifest.version};
      }

      entries.push(file);
    }
  }

  return entries;
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
  const packageInputs: {
    commit: string;
    artifacts: {path: string; sha256: string}[];
    installerEntries: string;
    developmentRuntime: {version: string; executable: string; sha256: string};
    selectedElectronRuntime: {
      versions: {node: string; electron: string};
      executable: string;
      sha256: string;
    };
  } = JSON.parse(await readFile(packageProofPath, 'utf8'));
  assert.equal(packageInputs.commit, inventory.commit);
  assert.equal(
    process.versions.node,
    packageInputs.selectedElectronRuntime.versions.node,
    'Packaged Node differs from the selected Electron runtime'
  );
  assert.equal(
    process.versions.electron,
    packageInputs.selectedElectronRuntime.versions.electron,
    'Packaged Electron differs from the selected dependency'
  );
  const contents = {
    commit: inventory.commit,
    artifacts: packageInputs.artifacts,
    installerEntries: packageInputs.installerEntries,
    developmentRuntime: packageInputs.developmentRuntime,
    selectedElectronRuntime: packageInputs.selectedElectronRuntime,
    embeddedRuntime: process.versions,
    asar: await packageContents(archive),
    unpacked: await packageContents(dirname(resources)),
    installer: await packageContents(installerRoot),
  };
  report.packageContents = contents;
  for (const [scope, entries] of [
    ['asar', contents.asar],
    ['unpacked', contents.unpacked],
    ['installer', contents.installer],
  ] as const) {
    assert.ok(entries.length > 0, `Empty package inventory: ${scope}`);
    for (const entry of entries) {
      for (const path of [entry.path, entry.target ?? '']) {
        assert.equal(
          /(^|\/)(node_modules\/node|node@runtime[^/]*)(\/|$)/i.test(path) ||
            (entry.kind !== 'directory' && /(^|\/)node(?:\.exe)?$/i.test(path)),
          false,
          `Development Node path shipped in ${scope}: ${path}`
        );
      }

      assert.notEqual(entry.package?.name, 'node', `Node package shipped: ${entry.path}`);
      assert.notEqual(
        entry.sha256,
        packageInputs.developmentRuntime.sha256,
        `Development Node executable shipped in ${scope}: ${entry.path}`
      );
    }
  }

  const installedArchives = contents.installer.filter(
    entry =>
      entry.path === 'resources/app.asar' || entry.path.endsWith('/resources/app.asar')
  );
  assert.equal(installedArchives.length, 1);
  const installedArchive = installedArchives[0];
  assert.ok(installedArchive);
  assert.equal(installedArchive.kind, 'file');
  const applicationRoot = dirname(dirname(installedArchive.path));
  report.installedApplicationRoot = applicationRoot;
  const installedEntries = new Map(contents.installer.map(entry => [entry.path, entry]));
  for (const entry of contents.unpacked) {
    const installed = installedEntries.get(join(applicationRoot, entry.path));
    assert.ok(installed, `Installer entry absent: ${entry.path}`);
    assert.equal(installed.kind, entry.kind, `Installer kind changed: ${entry.path}`);
    assert.equal(installed.mode, entry.mode, `Installer mode changed: ${entry.path}`);
    if (entry.kind === 'file') {
      assert.equal(
        installed.sha256,
        entry.sha256,
        `Installer file changed: ${entry.path}`
      );
    } else if (entry.kind === 'symlink') {
      assert.equal(
        installed.target,
        entry.target,
        `Installer link changed: ${entry.path}`
      );
    }
  }

  phases.push(
    'complete-package-content-inventory/development-Node-excluded/embedded-runtime-unchanged'
  );
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
