import {mkdtemp, readFile, writeFile, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {_electron, expect, test} from '@playwright/test';

import {listCustomers, openExistingDatabase} from '../packages/db/dist/index.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const executablePath = createRequire(
  new URL('../packages/electron/package.json', import.meta.url)
)('electron');
const savedComments = 'Saved, "quoted"\nsecond line';
async function launch(directory: string) {
  return _electron.launch({
    executablePath,
    args: [join(root, 'acceptance/electron-entry.mjs')],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      VITE_DEV_SERVER_URL: '',
      SHOP_THINGS_ACCEPTANCE_DATA: directory,
      SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
    },
  });
}

async function inspect(path: string) {
  const handle = await openExistingDatabase(path, {
    migrationsFolder: join(root, 'packages/db/migrations'),
  });
  try {
    return await listCustomers(handle.db);
  } finally {
    handle.close();
  }
}

async function menu(
  page: Awaited<ReturnType<Awaited<ReturnType<typeof launch>>['firstWindow']>>,
  name: string
) {
  await page.getByRole('button', {name: 'Database', exact: true}).click();
  await page.getByRole('menuitem', {name, exact: true}).click();
}

test('Backup and CSV include every saved row while searched editor draft, route, and session remain intact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-saved-files-'));
  const application = await launch(directory);
  try {
    const page = await application.firstWindow();
    await page
      .getByRole('textbox', {name: 'Search customers', exact: true})
      .fill('Alpha');
    await expect(page.getByText('1 result', {exact: true})).toBeVisible();
    await page.getByRole('link', {name: 'Alpha One', exact: true}).click();
    await page.getByRole('button', {name: 'Edit customer', exact: true}).click();
    await page.getByRole('textbox', {name: 'Comments', exact: true}).fill(savedComments);
    await page.getByRole('button', {name: 'Save', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Alpha One', exact: true})
    ).toBeVisible();
    await page.getByRole('button', {name: 'Edit customer', exact: true}).click();
    await page.getByRole('textbox', {name: 'First name', exact: true}).fill('UNSAVED');
    await page.getByRole('textbox', {name: 'Balance ($)', exact: true}).fill('-');
    const route = page.url();
    const before = await page.evaluate(() =>
      Reflect.get(window, 'shopThings').database.status()
    );
    const csv = join(directory, 'all.csv');
    const backup = join(directory, 'backup.sqlite');
    for (const [name, path, message] of [
      ['Back up database', backup, 'Backup saved.'],
      ['Export all customers', csv, 'Customers exported.'],
    ]) {
      await application.evaluate(
        (_electron, path) =>
          Reflect.get(globalThis, 'acceptanceFiles').push({path, hold: true}),
        path
      );
      await menu(page, name);
      await expect(page.getByText('Waiting for database operation…')).toBeVisible();
      await expect(page.locator('[aria-busy="true"]')).toHaveAttribute('inert', '');
      await application.evaluate(() =>
        Reflect.get(globalThis, 'acceptanceReleasePicker')()
      );
      await expect(page.getByText(`${message} ${path}`, {exact: true})).toBeVisible();
      await expect(
        page.getByRole('textbox', {name: 'First name', exact: true})
      ).toHaveValue('UNSAVED');
      await expect(
        page.getByRole('textbox', {name: 'Balance ($)', exact: true})
      ).toHaveValue('-');
      expect(page.url()).toBe(route);
      expect(
        await page.evaluate(() => Reflect.get(window, 'shopThings').database.status())
      ).toEqual(before);
    }

    const records = await inspect(backup);
    expect(records).toHaveLength(3);
    expect(records.map(row => row.firstName).toSorted()).toEqual([
      'Alpha',
      'Unnumbered',
      'Zed',
    ]);
    expect(records.find(row => row.firstName === 'Alpha')).toMatchObject({
      balance: '-1.23',
      comments: savedComments,
    });
    expect(
      records.find(row => row.firstName === 'Unnumbered')?.customerNumber
    ).toBeNull();
    const text = await readFile(csv, 'utf8');
    expect(text).toContain('"Zed"');
    expect(text).toContain('"Unnumbered"');
    expect(text).toContain('"Saved, ""quoted""\nsecond line"');
    expect(text).toContain('"-1.23","10.00"');
    expect(text).not.toContain('UNSAVED');
    const active = await page.evaluate(async () => {
      const client = Reflect.get(window, 'shopThings');
      const state = await client.database.status();
      return client.customers.list({session: state.value.session, query: ''});
    });
    expect(active.status).toBe('success');
    expect(
      active.value.find(
        (row: {customer: {firstName: string; comments: string}}) =>
          row.customer.firstName === 'Alpha'
      )?.customer.comments
    ).toBe(savedComments);
    const evidence = await application.evaluate(() => ({
      ipc: Reflect.get(globalThis, 'acceptanceIpc'),
      dialogs: Reflect.get(globalThis, 'acceptanceDialogs'),
    }));
    expect(evidence.ipc).toContain('shop-things:database.backup');
    expect(evidence.ipc).toContain('shop-things:exports.csv');
    expect(evidence.dialogs).toHaveLength(0);
  } finally {
    await application.evaluate(() => {
      if (Reflect.get(globalThis, 'acceptancePickerHeld')) {
        Reflect.get(globalThis, 'acceptanceReleasePicker')();
      }

      Reflect.set(globalThis, 'acceptanceDiscard', true);
    });
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('saved-file cancellation, existing destinations, unwritable folders, and BUSY clear pending without losing draft', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-saved-files-'));
  const application = await launch(directory);
  try {
    const page = await application.firstWindow();
    await page.getByRole('link', {name: 'Alpha One', exact: true}).click();
    await page.getByRole('button', {name: 'Edit customer', exact: true}).click();
    await page.getByRole('textbox', {name: 'Balance ($)', exact: true}).fill('-');
    const route = page.url();
    for (const name of ['Back up database', 'Export all customers']) {
      await menu(page, name);
      await expect(page.getByText('Waiting for database operation…')).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);
      const existing = join(
        directory,
        name === 'Back up database' ? 'existing.sqlite' : 'existing.csv'
      );
      await writeFile(existing, 'preserve existing bytes');
      await application.evaluate(
        (_electron, path) => Reflect.get(globalThis, 'acceptanceFiles').push({path}),
        existing
      );
      await menu(page, name);
      await expect(
        page.getByText(
          'A file already exists at this destination. Choose another name or location.',
          {exact: true}
        )
      ).toBeVisible();
      expect(await readFile(existing, 'utf8')).toBe('preserve existing bytes');
      await page.getByRole('button', {name: 'Dismiss error', exact: true}).click();
      await application.evaluate(
        (_electron, path) => Reflect.get(globalThis, 'acceptanceFiles').push({path}),
        join(directory, 'missing', 'output')
      );
      await menu(page, name);
      await expect(
        page.getByText(
          name === 'Back up database'
            ? 'The operation failed. Check the file and folder permissions, then try again.'
            : 'The file could not be saved. Choose a writable folder and a new filename, then try again.',
          {exact: true}
        )
      ).toBeVisible();
      await expect(page.getByText('Waiting for database operation…')).toHaveCount(0);
      await page.getByRole('button', {name: 'Dismiss error', exact: true}).click();
      await application.evaluate(
        (_electron, channel) =>
          Reflect.set(globalThis, 'acceptanceFault', {
            channel,
            before: true,
            error: {code: 'BUSY', message: 'Busy'},
          }),
        name === 'Back up database'
          ? 'shop-things:database.backup'
          : 'shop-things:exports.csv'
      );
      await menu(page, name);
      await expect(
        page.getByText('Another operation is in progress. Try again when it finishes.', {
          exact: true,
        })
      ).toBeVisible();
      await expect(page.getByText('Waiting for database operation…')).toHaveCount(0);
      await expect(
        page.getByRole('textbox', {name: 'Balance ($)', exact: true})
      ).toBeEnabled();
      await expect(
        page.getByRole('textbox', {name: 'Balance ($)', exact: true})
      ).toHaveValue('-');
      expect(page.url()).toBe(route);
      await page.getByRole('button', {name: 'Dismiss error', exact: true}).click();
    }

    expect(
      await application.evaluate(() => Reflect.get(globalThis, 'acceptanceDialogs'))
    ).toHaveLength(0);
  } finally {
    await application.evaluate(() => {
      if (Reflect.get(globalThis, 'acceptancePickerHeld')) {
        Reflect.get(globalThis, 'acceptanceReleasePicker')();
      }

      Reflect.set(globalThis, 'acceptanceDiscard', true);
    });
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('Chromium Backup and Export simulations are labelled, preserve drafts, and leave browser storage empty', async ({
  page,
}) => {
  await page.goto('/?preview=true');
  await page.getByRole('link', {name: 'Add customer', exact: true}).click();
  await page
    .getByRole('textbox', {name: 'First name', exact: true})
    .fill('Preview saved');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(
    page.getByRole('heading', {name: 'Preview saved', exact: true})
  ).toBeVisible();
  await page.getByRole('button', {name: 'Edit customer', exact: true}).click();
  await page.getByRole('textbox', {name: 'Balance ($)', exact: true}).fill('-');
  const route = page.url();
  for (const [name, path, message] of [
    [
      'Back up database (simulation)',
      'Preview: customers-backup.sqlite',
      'Backup saved.',
    ],
    [
      'Export all customers (simulation)',
      'Preview: all-saved-customers.csv',
      'Customers exported.',
    ],
  ]) {
    await menu(page, name);
    await expect(
      page.getByText(`Simulated: ${message} ${path}`, {exact: true})
    ).toBeVisible();
    await expect(
      page.getByRole('textbox', {name: 'Balance ($)', exact: true})
    ).toHaveValue('-');
    expect(page.url()).toBe(route);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }

  await page.getByRole('combobox', {name: 'Simulation result'}).selectOption('cancelled');
  await menu(page, 'Back up database (simulation)');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('combobox', {name: 'Simulation result'}).selectOption('error');
  await menu(page, 'Export all customers (simulation)');
  await expect(
    page.getByText(
      'Simulated file failure. Choose another name or location and try again.',
      {exact: true}
    )
  ).toBeVisible();
  await expect(page.getByRole('textbox', {name: 'Balance ($)', exact: true})).toHaveValue(
    '-'
  );
  expect(
    await page.evaluate(() => ({
      local: localStorage.length,
      session: sessionStorage.length,
    }))
  ).toEqual({local: 0, session: 0});
});
