import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {expect, test, type Page} from '@playwright/test';

import {getCustomer, openExistingDatabase} from '../packages/db/dist/index.js';
import launchElectron from './launchElectron';

const root = fileURLToPath(new URL('..', import.meta.url));

async function confirm(page: Page) {
  const dialog = page.getByRole('dialog', {name: 'Delete Customer?', exact: true});
  await expect(dialog).toBeHidden();
  await page.getByRole('main').getByRole('button', {name: 'Delete customer'}).click();
  await dialog.getByRole('button', {name: 'Delete customer'}).click();
}

test('identifying deletion persists and returns to the unfiltered list through actual bundled renderer IPC', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-delete-'));
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
  });
  let closed = false;
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    const search = page.getByRole('textbox', {name: 'Search customers'});
    await search.fill('Alpha');
    await search.press('Enter');
    await page.getByRole('link', {name: 'Alpha One'}).click();
    await page.getByRole('button', {name: 'Delete customer'}).click();
    const dialog = page.getByRole('dialog', {name: 'Delete Customer?', exact: true});
    await expect(dialog).toContainText('Alpha One (# 2)');
    await expect(dialog.getByRole('button', {name: 'Cancel'})).toBeFocused();
    await dialog.getByRole('button', {name: 'Cancel'}).click();
    await expect(
      page.getByRole('heading', {name: 'Alpha One', exact: true})
    ).toBeVisible();
    expect(
      await application.evaluate(
        () =>
          Reflect.get(globalThis, 'acceptanceIpc').filter(
            (channel: string) => channel === 'shop-things:customers.delete'
          ).length
      )
    ).toBe(0);
    await confirm(page);
    await expect(page.getByText('Customer deleted.', {exact: true})).toBeVisible();
    await expect(search).toHaveValue('');
    await expect(page.getByText('2 results', {exact: true})).toBeVisible();
    await application.close();
    closed = true;
    const handle = await openExistingDatabase(join(directory, 'customers.sqlite'), {
      migrationsFolder: join(root, 'packages/db/migrations'),
    });
    try {
      expect(await getCustomer(handle.db, 2)).toBeNull();
      expect(await getCustomer(handle.db, 1)).not.toBeNull();
    } finally {
      handle.close();
    }
  } finally {
    if (!closed) {
      await application.close();
    }

    await rm(directory, {recursive: true, force: true});
  }
});

test('same-session deletion refreshes an active cached list after returning during a held response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-delete-back-'));
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5179/',
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    const search = page.getByRole('textbox', {name: 'Search customers'});
    await search.fill('Alpha');
    await search.press('Enter');
    await page.getByRole('link', {name: 'Alpha One'}).click();
    await application.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceFault', {
        channel: 'shop-things:customers.delete',
        hold: true,
      });
    });
    await confirm(page);
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceHeldRead')?.channel)
      )
      .toBe('shop-things:customers.delete');
    await page.getByRole('link', {name: 'Back to customers'}).click();
    await expect(search).toHaveValue('');
    await expect(page.getByRole('link', {name: 'Alpha One'})).toBeVisible();
    await application.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceReleaseRead')();
    });
    await expect(page.getByText('2 results', {exact: true})).toBeVisible();
    await expect(page.getByRole('link', {name: 'Alpha One'})).toHaveCount(0);
    await expect(page.getByText('Customer deleted.', {exact: true})).toHaveCount(0);
    await expect(search).toHaveValue('');
  } finally {
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('real stale revision fails safely and late prior-session deletion cannot navigate the replacement view', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-delete-races-'));
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5179/',
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    await page.getByRole('link', {name: 'Numbered Three'}).click();
    await page.getByRole('button', {name: 'Delete customer'}).click();
    await expect(
      page.getByRole('dialog', {name: 'Delete Customer?', exact: true})
    ).toContainText('Numbered Three (# 3)');
    await page
      .getByRole('dialog', {name: 'Delete Customer?', exact: true})
      .getByRole('button', {name: 'Cancel'})
      .click();
    const changed = await page.evaluate(async () => {
      const client = Reflect.get(window, 'shopThings');
      const state = await client.database.status();
      const record = await client.customers.get({session: state.value.session, id: 3});
      return client.customers.update({
        reference: record.value.reference,
        changes: {comments: 'Changed after loading'},
      });
    });
    expect(changed.status).toBe('success');
    await confirm(page);
    await expect(page.getByRole('alert')).toContainText('Reload before editing');
    await expect(
      page.getByRole('heading', {name: 'Numbered Three', exact: true})
    ).toBeVisible();
    await expect(
      page.getByRole('main').getByRole('button', {name: 'Delete customer'})
    ).toBeDisabled();
    expect(
      await application.evaluate(
        () =>
          Reflect.get(globalThis, 'acceptanceIpc').filter(
            (channel: string) => channel === 'shop-things:customers.delete'
          ).length
      )
    ).toBe(1);
    await page.getByRole('link', {name: 'Back to customers'}).click();
    await page.getByRole('link', {name: 'Alpha One'}).click();
    await application.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceFault', {
        channel: 'shop-things:customers.delete',
        hold: true,
      });
    });
    await confirm(page);
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceHeldRead')?.channel)
      )
      .toBe('shop-things:customers.delete');
    await expect(page.getByRole('button', {name: 'Deleting customer…'})).toBeDisabled();
    await application.evaluate(
      ({dialog}, path) => {
        dialog.showOpenDialog = async () => ({canceled: false, filePaths: [path]});
      },
      join(directory, 'customers.sqlite')
    );
    expect(
      (await page.evaluate(() => Reflect.get(window, 'shopThings').database.open()))
        .status
    ).toBe('success');
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    await application.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceReleaseRead')();
    });
    await expect(page.getByText('2 results', {exact: true})).toBeVisible();
    await expect(page.getByText('Customer deleted.', {exact: true})).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe('#/customers');
  } finally {
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('Chromium preview cancels identifying deletion then removes the temporary saved customer', async ({
  page,
}) => {
  await page.goto('/?preview=true#/customers');
  await page.getByRole('link', {name: 'Add customer'}).click();
  await page.getByRole('textbox', {name: 'First name'}).fill('Temporary Delete');
  await page.getByRole('button', {name: 'Save'}).click();
  await expect(page.getByRole('heading', {name: 'Customers', exact: true})).toBeVisible();
  const search = page.getByRole('textbox', {name: 'Search customers'});
  await search.fill('Temporary');
  await search.press('Enter');
  await page.getByRole('link', {name: 'Temporary Delete', exact: true}).click();
  const detailRoute = new URL(page.url()).hash;
  await page.getByRole('button', {name: 'Delete customer'}).click();
  const dialog = page.getByRole('dialog', {name: 'Delete Customer?', exact: true});
  await expect(dialog).toContainText('Temporary Delete (# 1)');
  await expect(dialog.getByRole('button', {name: 'Cancel'})).toBeFocused();
  await dialog.getByRole('button', {name: 'Cancel'}).click();
  await expect(
    page.getByRole('heading', {name: 'Temporary Delete', exact: true})
  ).toBeVisible();
  await page.getByRole('link', {name: 'Back to customers'}).click();
  await expect(search).toHaveValue('');
  await expect(
    page.getByRole('link', {name: 'Temporary Delete', exact: true})
  ).toBeVisible();
  await page.getByRole('link', {name: 'Temporary Delete', exact: true}).click();
  await confirm(page);
  await expect(page.getByText('Customer deleted.', {exact: true})).toBeVisible();
  await expect(search).toHaveValue('');
  await expect(page.getByRole('heading', {name: 'No Customers Yet'})).toBeVisible();
  await expect(page.getByText('0 results', {exact: true})).toBeVisible();
  await expect(
    page.getByRole('link', {name: 'Temporary Delete', exact: true})
  ).toHaveCount(0);
  await page.evaluate(hash => {
    location.hash = hash;
  }, detailRoute);
  await expect(page.getByRole('heading', {name: 'Customer Not Found'})).toBeVisible();
  await page.getByRole('link', {name: 'Back to customers'}).click();
  await expect(page.getByRole('button', {name: 'Clear'})).toBeDisabled();
  await expect(page.getByRole('heading', {name: 'No Customers Yet'})).toBeVisible();
  expect(new URL(page.url()).searchParams.get('preview')).toBe('true');
});
