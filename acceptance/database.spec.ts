import {mkdtemp, readFile, writeFile, rm, mkdir, access} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {_electron, expect, test} from '@playwright/test';

const activeLabel = /Active database:/;
const simulatedFailure = /Simulated file failure/;
const root = fileURLToPath(new URL('..', import.meta.url));
const executablePath = createRequire(
  new URL('../packages/electron/package.json', import.meta.url)
)('electron');
function launch(directory: string, extra = {}) {
  return _electron.launch({
    executablePath,
    args: [join(root, 'acceptance/electron-entry.mjs')],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      SHOP_THINGS_ACCEPTANCE_DATA: directory,
      VITE_DEV_SERVER_URL: '',
      ...extra,
    },
  });
}

test('database startup shows loading, first launch cancellation is silent, Create persists and remembered Open returns', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-database-'));
  const path = join(directory, 'created.sqlite');
  let application = await launch(directory, {
    SHOP_THINGS_ACCEPTANCE_DELAY_STARTUP: 'true',
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('Connecting to the application…')).toBeVisible();
    await expect(
      page.getByRole('button', {name: 'Database', exact: true})
    ).toBeDisabled();
    await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceReleaseStartup')()
    );
    await expect(page.getByRole('heading', {name: 'Set Up Your Database'})).toBeVisible();
    await page.getByRole('button', {name: 'Create database', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Set Up Your Database'})).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await application.evaluate(
      (_electron, path) =>
        Reflect.get(globalThis, 'acceptanceFiles').push({path, hold: true}),
      path
    );
    await page.getByRole('button', {name: 'Create database', exact: true}).click();
    await expect(page.getByText('Waiting for database operation…')).toBeVisible();
    await expect(
      page.getByRole('button', {name: 'Open database', exact: true})
    ).toBeDisabled();
    await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceReleasePicker')()
    );
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    await expect(page.getByText('Database created.', {exact: true})).toBeVisible();
    await expect(page.getByText('Active database: created.sqlite')).toBeVisible();
    await page.getByText('Full database path', {exact: true}).click();
    await expect(page.getByText(path, {exact: true})).toBeVisible();
    expect(JSON.parse(await readFile(join(directory, 'database.json'), 'utf8'))).toEqual({
      path,
    });
    await application.close();
    application = await launch(directory);
    const reopened = await application.firstWindow();
    await expect(
      reopened.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    await expect(reopened.getByText('Active database: created.sqlite')).toBeVisible();
  } finally {
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('database remembered recovery Retry never creates a missing file and Open recovers', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-database-'));
  const application = await launch(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
  });
  await expect(
    (await application.firstWindow()).getByText('3 results', {exact: true})
  ).toBeVisible();
  await application.close();
  const missing = join(directory, 'missing.sqlite');
  await writeFile(join(directory, 'database.json'), JSON.stringify({path: missing}));
  const recovery = await launch(directory);
  try {
    const page = await recovery.firstWindow();
    await expect(page.getByRole('heading', {name: 'Recover Database'})).toBeVisible();
    await expect(page.getByText('Failed remembered file: missing.sqlite')).toBeVisible();
    await expect(page.getByText(activeLabel)).toHaveCount(0);
    await page.getByRole('button', {name: 'Retry remembered database'}).click();
    await expect(page.getByText('Waiting for database operation…')).toHaveCount(0);
    await expect(access(missing)).rejects.toThrow();
    await recovery.evaluate(
      (_electron, path) => Reflect.get(globalThis, 'acceptanceFiles').push({path}),
      join(directory, 'customers.sqlite')
    );
    await page.getByRole('button', {name: 'Open database', exact: true}).click();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    await expect(page.getByText('Database opened.', {exact: true})).toBeVisible();
  } finally {
    await recovery.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('database failed candidates after discard approval preserve editor, search, active file and existing destination', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-database-'));
  const application = await launch(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole('textbox', {name: 'Search customers'}).fill('Alpha');
    await page.getByRole('textbox', {name: 'Search customers'}).press('Enter');
    await page.getByRole('link', {name: 'Alpha One'}).click();
    await page.getByRole('button', {name: 'Edit customer'}).click();
    await page.getByRole('textbox', {name: 'First name'}).fill('Retained draft');
    const before = await page.evaluate(
      async () => (await Reflect.get(window, 'shopThings').database.status()).value
    );
    const existing = join(directory, 'existing.sqlite');
    await writeFile(existing, 'existing bytes');
    await application.evaluate(() => Reflect.set(globalThis, 'acceptanceDiscard', true));
    async function select(action: string, path?: string) {
      await application.evaluate(
        (_electron, path) => Reflect.get(globalThis, 'acceptanceFiles').push({path}),
        path
      );
      await page.getByRole('button', {name: 'Database', exact: true}).click();
      await page.getByRole('menuitem', {name: action, exact: true}).click();
      await expect(page.getByText('Waiting for database operation…')).toHaveCount(0);
      await expect(page.getByRole('textbox', {name: 'First name'})).toHaveValue(
        'Retained draft'
      );
      expect(new URL(page.url()).hash).toBe('#/customers/2?q=Alpha');
      expect(
        await page.evaluate(
          async () => (await Reflect.get(window, 'shopThings').database.status()).value
        )
      ).toEqual(before);
    }

    await select('Open database');
    await expect(page.getByRole('alert')).toHaveCount(0);
    await select('Create database', existing);
    await expect(
      page.getByText(
        'A file already exists at this destination. Choose another name or location.'
      )
    ).toBeVisible();
    expect(await readFile(existing, 'utf8')).toBe('existing bytes');
    await select('Open database', existing);
    await expect(page.getByRole('alert')).toContainText('supported');
    await rm(join(directory, 'database.json'));
    await mkdir(join(directory, 'database.json'));
    await select('Create database', join(directory, 'candidate.sqlite'));
    await expect(page.getByRole('alert')).toContainText('permissions');
    await expect(page.getByRole('textbox', {name: 'First name'})).toBeEnabled();
  } finally {
    await application.evaluate(() => Reflect.set(globalThis, 'acceptanceDiscard', true));
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('database preview simulations preserve cancelled/failed drafts and reset only after correlated commit', async ({
  page,
}) => {
  await page.goto('/?preview=true');
  await page.getByRole('link', {name: 'Add customer'}).click();
  await page.getByRole('textbox', {name: 'First name'}).fill('Temporary draft');
  await page.getByRole('combobox', {name: 'Simulation result'}).selectOption('cancelled');
  async function open() {
    await page.getByRole('button', {name: 'Database', exact: true}).click();
    await page
      .getByRole('menuitem', {name: 'Open database (simulation)', exact: true})
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('button', {name: 'Discard', exact: true}).click();
  }

  await open();
  await expect(page.getByRole('textbox', {name: 'First name'})).toHaveValue(
    'Temporary draft'
  );
  await page.getByRole('combobox', {name: 'Simulation result'}).selectOption('error');
  await open();
  await expect(page.getByText(simulatedFailure)).toBeVisible();
  await expect(page.getByRole('textbox', {name: 'First name'})).toHaveValue(
    'Temporary draft'
  );
  await page.getByRole('combobox', {name: 'Simulation result'}).selectOption('success');
  await open();
  await expect(page.getByRole('heading', {name: 'Customers', exact: true})).toBeVisible();
  await expect(page.getByText('Simulated: Database opened.')).toBeVisible();
  await expect(
    page.getByText('Active database: Preview: open customers.sqlite')
  ).toBeVisible();
  await page.getByRole('button', {name: 'Simulate remembered-file failure'}).click();
  await expect(page.getByRole('heading', {name: 'Recover Database'})).toBeVisible();
  await page
    .getByRole('button', {name: 'Retry remembered database (simulation)'})
    .click();
  await expect(
    page.getByText('Active database: Preview: retry customers.sqlite')
  ).toBeVisible();
  expect(await page.evaluate(() => Reflect.has(window, 'shopThings'))).toBe(false);
});
