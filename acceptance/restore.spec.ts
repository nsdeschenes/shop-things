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

async function explain(page: Page) {
  await page.getByRole('button', {name: 'Database', exact: true}).click();
  await page.getByRole('menuitem', {name: 'Restore backup', exact: true}).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Choose a backup, then a new destination.');
  await expect(dialog.getByRole('button', {name: 'Cancel', exact: true})).toBeFocused();
  return dialog;
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
  await (
    await explain(page)
  )
    .getByRole('button', {name: 'Continue', exact: true})
    .click();
  await expect(page.getByText('Waiting for database operation…')).toHaveCount(0);
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

test('Restore explains first and both picker cancellations preserve approved exact drafts and references', async () => {
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
    await page.getByRole('button', {name: 'Edit customer'}).click();
    const balance = page.getByRole('textbox', {name: 'Balance ($)', exact: true});
    await balance.fill('-');
    const before = await stateAndRecord(page);
    const hash = new URL(page.url()).hash;
    const requests = await application.evaluate(
      () =>
        Reflect.get(globalThis, 'acceptanceIpc').filter(
          (channel: string) => channel === 'shop-things:database.restore'
        ).length
    );
    await (
      await explain(page)
    )
      .getByRole('button', {name: 'Cancel', exact: true})
      .click();
    expect(
      await application.evaluate(
        () =>
          Reflect.get(globalThis, 'acceptanceIpc').filter(
            (channel: string) => channel === 'shop-things:database.restore'
          ).length
      )
    ).toBe(requests);
    const pickers = await application.evaluate(
      () => Reflect.get(globalThis, 'acceptancePickers').length
    );
    // Stay refuses native preparation before either file picker.
    await (
      await explain(page)
    )
      .getByRole('button', {name: 'Continue', exact: true})
      .click();
    await expect(balance).toBeEnabled();
    expect(
      await application.evaluate(
        () => Reflect.get(globalThis, 'acceptancePickers').length
      )
    ).toBe(pickers);
    await application.evaluate(() => Reflect.set(globalThis, 'acceptanceDiscard', true));
    await restore(application, page);
    await expect(balance).toHaveValue('-');
    await restore(application, page, source);
    await expect(balance).toHaveValue('-');
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

test('Restore failures preserve source, working database, route and draft; held picker admission rejects BUSY', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-restore-failure-'));
  const application = await launch(directory, true);
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    const source = join(directory, 'backup.sqlite');
    await backup(application, page, source);
    const sourceBytes = await readFile(source);
    await page.getByRole('link', {name: 'Alpha One'}).click();
    await page.getByRole('button', {name: 'Edit customer'}).click();
    const name = page.getByRole('textbox', {name: 'First name'});
    await name.fill('Retained restore draft');
    const before = await stateAndRecord(page);
    const hash = new URL(page.url()).hash;
    await application.evaluate(() => Reflect.set(globalThis, 'acceptanceDiscard', true));
    const existing = join(directory, 'existing.sqlite');
    await writeFile(existing, 'existing destination bytes');
    await restore(application, page, source, existing);
    await expect(page.getByRole('alert')).toContainText(
      'Choose another name or location'
    );
    expect(await readFile(existing, 'utf8')).toBe('existing destination bytes');
    const corrupt = join(directory, 'corrupt.sqlite');
    await writeFile(corrupt, 'unsupported backup bytes');
    const invalidDestination = join(directory, 'invalid-copy.sqlite');
    await restore(application, page, corrupt, invalidDestination);
    await expect(page.getByRole('alert')).toContainText('supported');
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
    await expect(page.getByRole('alert')).toContainText('permissions');
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
    await (
      await explain(page)
    )
      .getByRole('button', {name: 'Continue', exact: true})
      .click();
    await expect(page.getByText('Waiting for database operation…')).toBeVisible();
    await expect(name).toBeDisabled();
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
    await expect(page.getByText('Waiting for database operation…')).toHaveCount(0);
    await expect(name).toHaveValue('Retained restore draft');
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
    await page.getByRole('textbox', {name: 'Search customers'}).fill('Alpha');
    await page.getByRole('textbox', {name: 'Search customers'}).press('Enter');
    await page.getByRole('link', {name: 'Alpha One'}).click();
    await page.getByRole('button', {name: 'Edit customer'}).click();
    await page
      .getByRole('textbox', {name: 'First name'})
      .fill('Retained migration draft');
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
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(access(failed)).rejects.toThrow();
    await expect(page.getByRole('textbox', {name: 'First name'})).toHaveValue(
      'Retained migration draft'
    );
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
    await expect(
      reopened.getByText('Active database: restored-working.sqlite')
    ).toBeVisible();
    await reopened.getByRole('link', {name: 'Restored pending'}).click();
    await expect(reopened.getByText('$4.56', {exact: true})).toBeVisible();
  } finally {
    await cleanup(application, directory);
  }
});

test('Restore is available without an active database and enters saved customers after completion', async () => {
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
    await restore(application, setup, source, join(directory, 'setup-restored.sqlite'));
    await expect(setup.getByText('3 results', {exact: true})).toBeVisible();
    await expect(setup.getByText('Database restored.', {exact: true})).toBeVisible();
  } finally {
    await cleanup(application, directory);
  }
});

test('Chromium separate-file Restore simulation preserves cancelled/error drafts and clones all saved backup records', async ({
  page,
}) => {
  await page.goto('/?preview=true#/customers/new');
  await page.getByRole('textbox', {name: 'First name'}).fill('Alpha saved');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await page.getByRole('link', {name: 'Back to customers'}).click();
  await page.getByRole('link', {name: 'Add customer'}).click();
  await page.getByRole('textbox', {name: 'First name'}).fill('Zed saved');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await page.getByRole('link', {name: 'Back to customers'}).click();
  const search = page.getByRole('textbox', {name: 'Search customers'});
  await search.fill('Alpha');
  await search.press('Enter');
  await page.getByRole('link', {name: 'Alpha saved', exact: true}).click();
  await page.getByRole('button', {name: 'Edit customer'}).click();
  const name = page.getByRole('textbox', {name: 'First name'});
  await name.fill('Draft excluded');
  await page.getByRole('button', {name: 'Database', exact: true}).click();
  await page
    .getByRole('menuitem', {name: 'Back up database (simulation)', exact: true})
    .click();
  await expect(page.getByRole('status')).toContainText('Simulated: Backup saved.');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const hash = new URL(page.url()).hash;
  async function explanation() {
    await page.getByRole('button', {name: 'Database', exact: true}).click();
    await page
      .getByRole('menuitem', {name: 'Restore backup (simulation)', exact: true})
      .click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toContainText('This simulation uses temporary saved data');
    await expect(dialog.getByRole('button', {name: 'Cancel', exact: true})).toBeFocused();
    return dialog;
  }

  await (await explanation()).getByRole('button', {name: 'Cancel', exact: true}).click();
  await expect(name).toHaveValue('Draft excluded');
  await (
    await explanation()
  )
    .getByRole('button', {name: 'Continue (simulation)', exact: true})
    .click();
  await page.getByRole('dialog').getByRole('button', {name: 'Stay', exact: true}).click();
  await expect(name).toHaveValue('Draft excluded');
  for (const outcome of ['cancelled', 'error']) {
    await page.getByRole('combobox', {name: 'Simulation result'}).selectOption(outcome);
    await (
      await explanation()
    )
      .getByRole('button', {name: 'Continue (simulation)', exact: true})
      .click();
    await page
      .getByRole('dialog')
      .getByRole('button', {name: 'Discard', exact: true})
      .click();
    await expect(name).toBeEnabled();
    await expect(name).toHaveValue('Draft excluded');
    expect(new URL(page.url()).hash).toBe(hash);
  }

  await expect(page.getByRole('alert')).toContainText('Simulated file failure');
  await page.getByRole('combobox', {name: 'Simulation result'}).selectOption('success');
  await (
    await explanation()
  )
    .getByRole('button', {name: 'Continue (simulation)', exact: true})
    .click();
  await page
    .getByRole('dialog')
    .getByRole('button', {name: 'Discard', exact: true})
    .click();
  await expect(page.getByRole('heading', {name: 'Customers', exact: true})).toBeVisible();
  await expect(search).toHaveValue('');
  await expect(
    page.getByText('Simulated: Database restored.', {exact: true})
  ).toBeVisible();
  await expect(
    page.getByText('Active database: Preview: restored customers.sqlite')
  ).toBeVisible();
  await expect(page.getByRole('link', {name: 'Alpha saved', exact: true})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Zed saved', exact: true})).toBeVisible();
  await expect(page.getByRole('link', {name: 'Draft excluded', exact: true})).toHaveCount(
    0
  );
  // A restored working copy never aliases its backup source snapshot.
  await page.getByRole('link', {name: 'Alpha saved', exact: true}).click();
  await page.getByRole('button', {name: 'Edit customer'}).click();
  await name.fill('Changed restored copy');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await (
    await explanation()
  )
    .getByRole('button', {name: 'Continue (simulation)', exact: true})
    .click();
  await expect(page.getByRole('link', {name: 'Alpha saved', exact: true})).toBeVisible();
  await expect(
    page.getByRole('link', {name: 'Changed restored copy', exact: true})
  ).toHaveCount(0);
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual(
    [0, 0]
  );
});
