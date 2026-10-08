import {
  mkdtemp,
  readFile,
  writeFile,
  rm,
  mkdir,
  cp,
  chmod,
  access,
} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {
  _electron,
  expect,
  test,
  type ElectronApplication,
  type Page,
} from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const executablePath = createRequire(
  new URL('../packages/electron/package.json', import.meta.url)
)('electron');
function launch(directory: string, seed = false) {
  return _electron.launch({
    executablePath,
    args: [join(root, 'acceptance/electron-entry.mjs')],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      SHOP_THINGS_ACCEPTANCE_DATA: directory,
      SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: seed ? 'true' : '',
      SHOP_THINGS_ACCEPTANCE_RECOVERY: 'true',
      VITE_DEV_SERVER_URL: '',
    },
  });
}

async function startRestore(page: Page) {
  await page.getByRole('link', {name: 'Database settings', exact: true}).click();
  await page.getByRole('button', {name: 'Restore backup', exact: true}).click();
}

async function restore(
  application: ElectronApplication,
  page: Page,
  source?: string,
  destination?: string
) {
  await application.evaluate(
    (_electron, selections) =>
      Reflect.get(globalThis, 'acceptanceFiles').push(...selections),
    [{path: source}, ...(source ? [{path: destination}] : [])]
  );
  await startRestore(page);
  await expect(page.getByRole('status', {name: 'Loading database'})).toHaveCount(0);
}

async function backup(application: ElectronApplication, page: Page, source: string) {
  await application.evaluate(
    (_electron, path) => Reflect.get(globalThis, 'acceptanceFiles').push({path}),
    source
  );
  expect(
    await page.evaluate(async () => {
      const client = Reflect.get(window, 'shopThings');
      const state = await client.database.status();
      return (await client.database.backup({session: state.value.session})).status;
    })
  ).toBe('success');
}

async function stateAndRecord(page: Page) {
  return page.evaluate(async () => {
    const client = Reflect.get(window, 'shopThings');
    const state = await client.database.status();
    const record = await client.customers.get({session: state.value.session, id: 2});
    return {state, record};
  });
}

async function cleanup(application: ElectronApplication, directory: string) {
  await application.evaluate(() => {
    Reflect.set(globalThis, 'acceptanceDiscard', true);
    if (Reflect.get(globalThis, 'acceptancePickerHeld')) {
      Reflect.get(globalThis, 'acceptanceReleasePicker')();
    }
  });
  await application.close();
  await rm(directory, {recursive: true, force: true});
}

test('Keyboard Restore opens source selection directly and returns focus after cancellation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-restore-keyboard-'));
  const application = await launch(directory, true);
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceFiles').push({hold: true})
    );
    const trigger = page.getByRole('link', {name: 'Database settings', exact: true});
    await trigger.focus();
    await trigger.press('Enter');
    const item = page.getByRole('button', {name: 'Restore backup', exact: true});
    await item.focus();
    await expect(item).toBeFocused();
    await item.press('Enter');
    await expect(page.getByRole('status', {name: 'Loading database'})).toBeVisible();
    await expect(item).toBeDisabled();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptancePickers'))
      )
      .toMatchObject([{kind: 'open', title: 'Choose backup to restore'}]);
    expect(
      await application.evaluate(() => Reflect.get(globalThis, 'acceptanceDialogs'))
    ).toEqual([]);
    await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceReleasePicker')()
    );
    await expect(item).toBeEnabled();
    await expect(page.getByRole('status', {name: 'Loading database'})).toHaveCount(0);
    await expect(item).toBeFocused();
    await expect(page.getByRole('heading', {name: 'Database Settings'})).toBeVisible();
  } finally {
    await cleanup(application, directory);
  }
});

test('Settings navigation protects dirty drafts and restore cancellations preserve the saved database', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-restore-cancel-'));
  const application = await launch(directory, true);
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    const source = join(directory, 'backup.sqlite');
    await backup(application, page, source);
    const original = await readFile(source);
    await page.getByRole('textbox', {name: 'Search customers'}).fill('Alpha');
    await page.getByRole('textbox', {name: 'Search customers'}).press('Enter');
    await page.getByRole('link', {name: 'Alpha One'}).click();
    await page.getByRole('textbox', {name: 'Customer number'}).waitFor();
    const balance = page.getByRole('textbox', {name: 'Balance ($)', exact: true});
    await balance.fill('-');
    const before = await stateAndRecord(page);
    const pickers = await application.evaluate(
      () => Reflect.get(globalThis, 'acceptancePickers').length
    );
    // Stay refuses native preparation before either file picker.
    await page.getByRole('link', {name: 'Database settings'}).click();
    await expect(balance).toBeEnabled();
    expect(
      await application.evaluate(() =>
        Reflect.get(globalThis, 'acceptanceDialogs').at(-1)
      )
    ).toMatchObject({message: 'Discard unsaved changes?', defaultId: 0, cancelId: 0});
    await expect(balance).toHaveValue('-');
    expect(
      await application.evaluate(
        () => Reflect.get(globalThis, 'acceptancePickers').length
      )
    ).toBe(pickers);
    await application.evaluate(() => Reflect.set(globalThis, 'acceptanceDiscard', true));
    await page.getByRole('link', {name: 'Database settings'}).click();
    await expect(page.getByRole('heading', {name: 'Database Settings'})).toBeVisible();
    const hash = new URL(page.url()).hash;
    await restore(application, page);
    await restore(application, page, source);
    expect(await stateAndRecord(page)).toEqual(before);
    expect(new URL(page.url()).hash).toBe(hash);
    expect(await readFile(source)).toEqual(original);
    const selections = await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptancePickers').slice(-3)
    );
    expect(selections.map((selection: {title: string}) => selection.title)).toEqual([
      'Choose backup to restore',
      'Choose backup to restore',
      'Create restored working database',
    ]);
    expect(
      new Set(selections.map((selection: {windowId: number}) => selection.windowId)).size
    ).toBe(1);
    expect(selections[0].windowId).toBeGreaterThan(0);
  } finally {
    await cleanup(application, directory);
  }
});

test('Restore failures preserve source, working database and settings; held picker admission rejects BUSY', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-restore-failure-'));
  const application = await launch(directory, true);
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    const source = join(directory, 'backup.sqlite');
    await backup(application, page, source);
    const sourceBytes = await readFile(source);
    await page.getByRole('link', {name: 'Database settings'}).click();
    const name = page.getByRole('button', {name: 'Open database', exact: true});
    const before = await stateAndRecord(page);
    const hash = new URL(page.url()).hash;
    await application.evaluate(() => Reflect.set(globalThis, 'acceptanceDiscard', true));
    const existing = join(directory, 'existing.sqlite');
    await writeFile(existing, 'existing destination bytes');
    await restore(application, page, source, existing);
    await expect(page.getByRole('alertdialog', {includeHidden: true})).toContainText(
      'Choose another name or location'
    );
    expect(await readFile(existing, 'utf8')).toBe('existing destination bytes');
    const corrupt = join(directory, 'corrupt.sqlite');
    await writeFile(corrupt, 'unsupported backup bytes');
    const invalidDestination = join(directory, 'invalid-copy.sqlite');
    await restore(application, page, corrupt, invalidDestination);
    await expect(page.getByRole('alertdialog', {includeHidden: true})).toContainText(
      'supported'
    );
    await expect(access(invalidDestination)).rejects.toThrow();
    expect(await readFile(corrupt, 'utf8')).toBe('unsupported backup bytes');
    const settingsBytes = await readFile(join(directory, 'database.json'));
    await application.evaluate(() => {
      const settings = Reflect.get(globalThis, 'acceptanceService').options.settings;
      Reflect.set(globalThis, 'acceptanceSettingsWrite', settings.write.bind(settings));
      settings.write = async () => {
        throw new Error('Controlled settings persistence failure');
      };
    });
    const failedDestination = join(directory, 'settings-copy.sqlite');
    await restore(application, page, source, failedDestination);
    await expect(page.getByRole('alertdialog', {includeHidden: true})).toContainText(
      'permissions'
    );
    await expect(access(failedDestination)).rejects.toThrow();
    expect(await readFile(join(directory, 'database.json'))).toEqual(settingsBytes);
    await application.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceService').options.settings.write = Reflect.get(
        globalThis,
        'acceptanceSettingsWrite'
      );
    });
    await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceFiles').push({hold: true})
    );
    await startRestore(page);
    await expect(page.getByRole('status', {name: 'Loading database'})).toBeVisible();
    await expect(name).toBeDisabled();
    await expect(
      page.getByRole('button', {name: 'Restore backup', exact: true})
    ).toBeDisabled();
    expect(
      await page.evaluate(async () => {
        const client = Reflect.get(window, 'shopThings');
        const state = await client.database.status();
        return (await client.customers.list({session: state.value.session, query: ''}))
          .error.code;
      })
    ).toBe('BUSY');
    await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceReleasePicker')()
    );
    await expect(name).toBeEnabled();
    await expect(page.getByRole('status', {name: 'Loading database'})).toHaveCount(0);
    await expect(page.getByRole('heading', {name: 'Database Settings'})).toBeVisible();
    expect(await stateAndRecord(page)).toEqual(before);
    expect(new URL(page.url()).hash).toBe(hash);
    expect(await readFile(source)).toEqual(sourceBytes);
  } finally {
    await cleanup(application, directory);
  }
});

test('Restore migrates only a separate read-only backup copy, cleans failed migration, commits once and remembers reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-restore-migration-'));
  let application = await launch(directory, true);
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    const initial = join(directory, 'initial-migrations');
    await mkdir(initial);
    await cp(
      join(root, 'packages/db/migrations/20260929093112_wealthy_hemingway'),
      join(initial, '20260929093112_wealthy_hemingway'),
      {recursive: true}
    );
    const source = join(directory, 'pending-backup.sqlite');
    await application.evaluate(
      async (_electron, paths) => {
        const database = Reflect.get(globalThis, 'acceptanceDatabase');
        const handle = database.openDatabase(paths.source);
        try {
          await database.runMigrations(handle.db, {migrationsFolder: paths.initial});
          await handle.db.run(
            "insert into customers (customerNumber,firstName,balance) values(7,'Restored pending',4.56)"
          );
        } finally {
          handle.close();
        }
      },
      {
        source,
        initial,
      }
    );
    await chmod(source, 0o444);
    const sourceBytes = await readFile(source);
    await page.getByRole('link', {name: 'Database settings'}).click();
    const before = await stateAndRecord(page);
    const hash = new URL(page.url()).hash;
    await application.evaluate(async () => {
      const service = Reflect.get(globalThis, 'acceptanceService');
      await service.active.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
      Reflect.set(globalThis, 'acceptanceMigrations', service.options.migrationsFolder);
      Reflect.set(globalThis, 'acceptanceDiscard', true);
    });
    const workingBytes = await readFile(join(directory, 'customers.sqlite'));
    const broken = join(directory, 'broken-migrations');
    await cp(initial, broken, {recursive: true});
    const badMigration = join(broken, '20260930110000_broken_restore');
    await mkdir(badMigration);
    await writeFile(
      join(badMigration, 'migration.sql'),
      'select * from missing_restore_table;'
    );
    await application.evaluate((_electron, path) => {
      Reflect.get(globalThis, 'acceptanceService').options.migrationsFolder = path;
    }, broken);
    const failed = join(directory, 'failed-migration.sqlite');
    await restore(application, page, source, failed);
    await expect(page.getByRole('alertdialog', {includeHidden: true})).toBeVisible();
    await expect(access(failed)).rejects.toThrow();
    await expect(page.getByRole('heading', {name: 'Database Settings'})).toBeVisible();
    expect(await stateAndRecord(page)).toEqual(before);
    expect(new URL(page.url()).hash).toBe(hash);
    expect(await readFile(source)).toEqual(sourceBytes);
    expect(await readFile(join(directory, 'customers.sqlite'))).toEqual(workingBytes);
    await application.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceService').options.migrationsFolder = Reflect.get(
        globalThis,
        'acceptanceMigrations'
      );
    });
    const destination = join(directory, 'restored-working.sqlite');
    await restore(application, page, source, destination);
    await expect(page.getByText('Database restored.', {exact: true})).toBeVisible();
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    await expect(page.getByRole('textbox', {name: 'Search customers'})).toHaveValue('');
    await expect(page.getByRole('link', {name: 'Restored pending'})).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#/customers');
    const after = await page.evaluate(() =>
      Reflect.get(window, 'shopThings').database.status()
    );
    expect(after.value.session).not.toBe(before.state.value.session);
    expect(after.value.version).toBe(before.state.value.version + 1);
    expect(
      (
        await page.evaluate(
          reference =>
            Reflect.get(window, 'shopThings').customers.update({
              reference,
              changes: {firstName: 'Obsolete'},
            }),
          before.record.value.reference
        )
      ).error.code
    ).toBe('STALE_SESSION');
    expect(await readFile(source)).toEqual(sourceBytes);
    expect(await readFile(join(directory, 'customers.sqlite'))).toEqual(workingBytes);
    expect(JSON.parse(await readFile(join(directory, 'database.json'), 'utf8'))).toEqual({
      path: destination,
    });
    await application.close();
    application = await launch(directory);
    const reopened = await application.firstWindow();
    await expect(reopened.getByText('restored-working.sqlite')).toBeVisible();
    await reopened.getByRole('link', {name: 'Restored pending'}).click();
    await expect(
      reopened.getByRole('textbox', {name: 'Balance ($)', exact: true})
    ).toHaveValue('4.56');
  } finally {
    await cleanup(application, directory);
  }
});

test('Restore after database setup enters saved customers after completion', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-restore-setup-'));
  let application = await launch(directory, true);
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    const source = join(directory, 'setup-backup.sqlite');
    await backup(application, page, source);
    await application.close();
    await rm(join(directory, 'database.json'));
    application = await launch(directory);
    const setup = await application.firstWindow();
    await expect(
      setup.getByRole('heading', {name: 'Set Up Your Database'})
    ).toBeVisible();
    await expect(setup.getByRole('button', {name: 'Database', exact: true})).toHaveCount(
      0
    );
    await application.evaluate(
      (_electron, path) => Reflect.get(globalThis, 'acceptanceFiles').push({path}),
      join(directory, 'new.sqlite')
    );
    await setup.getByRole('button', {name: 'Create database', exact: true}).click();
    await expect(setup.getByRole('heading', {name: 'No Customers Yet'})).toBeVisible();
    await restore(application, setup, source, join(directory, 'setup-restored.sqlite'));
    await expect(setup.getByText('3 results', {exact: true})).toBeVisible();
    await expect(setup.getByText('Database restored.', {exact: true})).toBeVisible();
  } finally {
    await cleanup(application, directory);
  }
});

test('retained migration snapshots preserve drafts on failed restore and recover into a separate copy', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-snapshot-recovery-'));
  const application = await launch(directory, true);
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    const initial = join(directory, 'initial-migrations');
    await mkdir(initial);
    const name = '20260929093112_wealthy_hemingway';
    await cp(join(root, 'packages/db/migrations', name), join(initial, name), {
      recursive: true,
    });
    const source = join(directory, 'source.sqlite');
    const snapshotPath = await application.evaluate(
      async (_electron, paths) => {
        const database = Reflect.get(globalThis, 'acceptanceDatabase');
        const service = Reflect.get(globalThis, 'acceptanceService');
        const legacy = database.openDatabase(paths.source);
        try {
          await database.runMigrations(legacy.db, {migrationsFolder: paths.initial});
          await legacy.db.run(
            "insert into customers(customerNumber,firstName) values(7,'Before update')"
          );
        } finally {
          legacy.close();
        }

        const original = await database.openExistingDatabase(paths.source, {
          migrationsFolder: service.options.migrationsFolder,
          migrationBackupDirectory: service.options.migrationBackupDirectory,
        });
        try {
          await original.db.run("update customers set firstName='After update'");
        } finally {
          original.close();
        }

        return (
          await database.listMigrationSnapshots(service.options.migrationBackupDirectory)
        ).snapshots[0].snapshotPath;
      },
      {source, initial}
    );
    const sourceBytes = await readFile(source);
    const snapshotBytes = await readFile(snapshotPath);
    await page.getByRole('link', {name: 'Database settings', exact: true}).click();
    const restoreCopy = page.getByRole('button', {name: 'Restore new copy'});
    await expect(restoreCopy).toBeEnabled();
    await expect(page.getByRole('region', {name: 'Migration snapshots'})).toContainText(
      source
    );
    await page.addScriptTag({
      path: join(root, 'acceptance-reports/harness/controlled-editor.mjs'),
      type: 'module',
    });
    await page.waitForFunction(
      () => Reflect.get(window, 'acceptanceEditorReady') === true
    );
    const draft = page.getByRole('textbox', {name: 'Controlled balance'});
    await draft.fill('-');
    const before = await stateAndRecord(page);
    await application.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceDiscard', true);
      Reflect.get(globalThis, 'acceptanceFiles').push({path: null});
    });
    await restoreCopy.click();
    await expect(draft).toBeEnabled();
    await expect(draft).toHaveValue('-');
    await expect(restoreCopy).toBeEnabled();
    expect(await stateAndRecord(page)).toEqual(before);
    const destination = join(directory, 'recovered.sqlite');
    await writeFile(snapshotPath, 'damaged snapshot');
    await application.evaluate(
      (_electron, path) => Reflect.get(globalThis, 'acceptanceFiles').push({path}),
      destination
    );
    await restoreCopy.click();
    await expect(page.getByRole('alertdialog', {includeHidden: true})).toBeVisible();
    await expect(draft).toHaveValue('-');
    await expect(draft).toBeEnabled();
    expect(await stateAndRecord(page)).toEqual(before);
    await expect(access(destination)).rejects.toThrow();
    await writeFile(snapshotPath, snapshotBytes);
    await application.evaluate(
      (_electron, path) => Reflect.get(globalThis, 'acceptanceFiles').push({path}),
      destination
    );
    await restoreCopy.click();
    await expect(
      page.getByRole('link', {name: 'Before update', exact: true})
    ).toBeVisible();
    await expect(draft).toHaveValue('0.00');
    const recovered = await page.evaluate(() =>
      Reflect.get(window, 'shopThings').database.status()
    );
    expect(recovered.value.selectedPath).toBe(destination);
    expect(recovered.value.session).not.toBe(before.state.value.session);
    expect(await readFile(source)).toEqual(sourceBytes);
    expect(await readFile(snapshotPath)).toEqual(snapshotBytes);
    expect(
      await application.evaluate(async () => {
        const database = Reflect.get(globalThis, 'acceptanceDatabase');
        const service = Reflect.get(globalThis, 'acceptanceService');
        return (
          await database.listMigrationSnapshots(service.options.migrationBackupDirectory)
        ).snapshots.length;
      })
    ).toBe(2);
  } finally {
    await cleanup(application, directory);
  }
});
