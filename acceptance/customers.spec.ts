import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from '@playwright/test';

import launchElectron from './launchElectron';

const alphaDetailLink = /\/customers\/2\?q=Alpha$/;

test('saved customer list/search/detail through actual bundled hash renderer IPC', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-customers-'));
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    expect(await page.locator('tbody a').allTextContents()).toEqual([
      'Alpha One',
      'Unnumbered Three',
      'Zed Two',
    ]);
    await expect(page.getByRole('link', {name: 'Add customer'})).toBeVisible();
    const search = page.getByRole('textbox', {name: 'Search customers'});
    await search.fill('Alpha');
    await expect(page.getByText('1 result', {exact: true})).toBeVisible();
    await expect(search).toBeFocused();
    await expect(page.getByRole('link', {name: 'Alpha One'})).toHaveAttribute(
      'href',
      alphaDetailLink
    );
    await page.getByRole('link', {name: 'Alpha One'}).click();
    await expect(
      page.getByRole('heading', {name: 'Alpha One', exact: true})
    ).toBeVisible();
    await expect(page.getByText('$-1.23', {exact: true})).toBeVisible();
    await expect(page.getByText('$10.00', {exact: true})).toBeVisible();
    await expect(page.getByText('+1 (902) 555-1234', {exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Edit customer'})).toBeEnabled();
    await expect(page.getByRole('button', {name: 'Delete customer'})).toBeEnabled();
    await page.reload();
    await expect(
      page.getByRole('heading', {name: 'Alpha One', exact: true})
    ).toBeVisible();
    expect(new URL(page.url()).hash).toContain('/customers/2?q=Alpha');
    await page.getByRole('link', {name: 'Back to customers'}).click();
    await expect(search).toHaveValue('Alpha');
    await expect(page.getByText('1 result', {exact: true})).toBeVisible();
    await search.fill('1');
    await search.press('Enter');
    await expect(page.getByRole('link', {name: 'Zed Two'})).toBeVisible();
    await page.getByRole('button', {name: 'Clear'}).click();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    await page.getByRole('link', {name: 'Unnumbered Three'}).click();
    await expect(page.getByText('Unassigned', {exact: true})).toBeVisible();
    await expect(page.getByText('$0.00', {exact: true})).toHaveCount(2);
    await page.getByRole('link', {name: 'Customer records Shop Things'}).click();
    await search.fill('no such customer');
    await search.press('Enter');
    await expect(
      page.getByRole('heading', {name: 'No Matching Customers'})
    ).toBeVisible();
    await expect(page.getByText('0 results', {exact: true})).toBeVisible();
    expect(
      await application.evaluate(() => Reflect.get(globalThis, 'acceptanceIpc'))
    ).toEqual(
      expect.arrayContaining(['shop-things:customers.list', 'shop-things:customers.get'])
    );
  } finally {
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('superseded reads stay loading for new targets and cannot paint obsolete success or failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-customer-delay-'));
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5179/',
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    const search = page.getByRole('textbox', {name: 'Search customers'});
    await application.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceFault', {
        channel: 'shop-things:customers.list',
        hold: true,
        error: {code: 'INTERNAL', message: 'Obsolete search failure'},
      });
    });
    await search.fill('Alpha');
    await search.press('Enter');
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceHeldRead')?.channel)
      )
      .toBe('shop-things:customers.list');
    await search.fill('Zed');
    await search.press('Enter');
    await expect(page.getByRole('status')).toHaveText('Loading customers…');
    await expect(page.getByRole('link', {name: 'Alpha One'})).toHaveCount(0);
    await application.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceReleaseRead')();
      Reflect.set(globalThis, 'acceptanceHeldRead', null);
    });
    await expect(page.getByRole('link', {name: 'Zed Two'})).toBeVisible();
    await expect(page.getByText('Obsolete search failure')).toHaveCount(0);
    await application.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceFault', {
        channel: 'shop-things:customers.get',
        hold: true,
      });
    });
    await page.evaluate(() => {
      location.hash = '/customers/2?q=Zed';
    });
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceHeldRead')?.channel)
      )
      .toBe('shop-things:customers.get');
    await page.evaluate(() => {
      location.hash = '/customers/1?q=Zed';
    });
    await expect(page.getByRole('status')).toHaveText('Loading customer…');
    await expect(page.getByRole('heading', {name: 'Alpha One', exact: true})).toHaveCount(
      0
    );
    await application.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceReleaseRead')();
      Reflect.set(globalThis, 'acceptanceHeldRead', null);
    });
    await expect(page.getByRole('heading', {name: 'Zed Two', exact: true})).toBeVisible();
    await expect(page.getByRole('heading', {name: 'Alpha One', exact: true})).toHaveCount(
      0
    );
    await application.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceFault', {
        channel: 'shop-things:customers.get',
        error: {code: 'BUSY', message: 'Wait and try again.'},
      });
    });
    await page.evaluate(() => {
      location.hash = '/customers/3?q=Zed';
    });
    await expect(page.getByText('Wait and try again.', {exact: true})).toBeVisible();
    await page.getByRole('button', {name: 'Retry', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Unnumbered Three', exact: true})
    ).toBeVisible();
    await page.evaluate(() => {
      location.hash = '/customers/999?q=Zed';
    });
    await expect(page.getByRole('heading', {name: 'Customer Not Found'})).toBeVisible();
    await page.getByRole('link', {name: 'Back to customers'}).click();
    await expect(search).toHaveValue('Zed');
    await application.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceFault', {
        channel: 'shop-things:customers.get',
        hold: true,
        error: {code: 'INTERNAL', message: 'Previous database failure'},
      });
    });
    await page.evaluate(() => {
      location.hash = '/customers/2?q=Zed';
    });
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceHeldRead')?.channel)
      )
      .toBe('shop-things:customers.get');
    const priorSession = await application.evaluate(
      () => Reflect.get(globalThis, 'acceptanceHeldRead').result.value.reference.session
    );
    await application.evaluate(
      ({dialog}, path) => {
        dialog.showOpenDialog = async () => ({canceled: false, filePaths: [path]});
      },
      join(directory, 'customers.sqlite')
    );
    const opened = await page.evaluate(() =>
      Reflect.get(window, 'shopThings').database.open()
    );
    expect(opened.status).toBe('success');
    expect(opened.value.session).not.toBe(priorSession);
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    await expect(search).toHaveValue('');
    await expect(page.getByRole('status')).toHaveText('Loading customers…');
    await application.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceReleaseRead')();
    });
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    await expect(page.getByText('Previous database failure')).toHaveCount(0);
  } finally {
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('temporary Chromium preview distinguishes empty/search and missing detail and preserves switches', async ({
  page,
}) => {
  await page.goto('/?preview=true#/customers');
  await expect(page.getByRole('heading', {name: 'No Customers Yet'})).toBeVisible();
  await expect(page.getByText('0 results', {exact: true})).toBeVisible();
  await page.getByRole('textbox', {name: 'Search customers'}).fill('Alpha');
  await page.getByRole('textbox', {name: 'Search customers'}).press('Enter');
  await expect(page.getByRole('heading', {name: 'No Matching Customers'})).toBeVisible();
  await page.evaluate(() => {
    location.hash = '/customers/999?q=Alpha';
  });
  await expect(page.getByRole('heading', {name: 'Customer Not Found'})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', {name: 'Customer Not Found'})).toBeVisible();
  await page.getByRole('link', {name: 'Customer records Shop Things'}).click();
  await expect(page.getByRole('textbox', {name: 'Search customers'})).toHaveValue(
    'Alpha'
  );
  expect(new URL(page.url()).searchParams.get('preview')).toBe('true');
  await page.getByRole('button', {name: 'Clear'}).click();
  await expect(page.getByRole('heading', {name: 'No Customers Yet'})).toBeVisible();
});

test('Chromium preview preserves canonical Unicode search and supplementary name ordering', async ({
  page,
}) => {
  await page.goto('/?preview=true#/customers');
  for (const name of ['ς', 'σ', 'İ', 'i', 'ſ', 's', 'Ｚ', '😀', '[literal]']) {
    await page.getByRole('link', {name: 'Add customer'}).click();
    await page.getByRole('textbox', {name: 'First name'}).fill(name);
    await page.getByRole('button', {name: 'Save'}).click();
    await expect(page.getByRole('heading', {name, exact: true})).toBeVisible();
    await page.getByRole('link', {name: 'Back to customers'}).click();
  }

  const search = page.getByRole('textbox', {name: 'Search customers'});
  await search.fill('σ');
  await search.press('Enter');
  await expect(page.getByText('2 results', {exact: true})).toBeVisible();
  await expect(page.locator('tbody a')).toHaveText(['ς', 'σ']);
  await search.fill('i');
  await search.press('Enter');
  await expect(page.getByText('2 results', {exact: true})).toBeVisible();
  await expect(page.locator('tbody a')).toHaveText(['[literal]', 'i']);
  await search.fill('s');
  await search.press('Enter');
  await expect(page.getByText('2 results', {exact: true})).toBeVisible();
  await expect(page.locator('tbody a')).toHaveText(['s', 'ſ']);
  await search.fill('[literal]');
  await search.press('Enter');
  await expect(page.getByText('1 result', {exact: true})).toBeVisible();
  await expect(page.locator('tbody a')).toHaveText(['[literal]']);
  await search.fill('');
  await search.press('Enter');
  await expect(page.getByText('9 results', {exact: true})).toBeVisible();
  await expect(page.locator('tbody a')).toHaveText([
    '[literal]',
    'i',
    's',
    'İ',
    'ſ',
    'ς',
    'σ',
    'Ｚ',
    '😀',
  ]);
});
