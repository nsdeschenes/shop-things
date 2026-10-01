import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from '@playwright/test';

import launchElectron from './launchElectron';

test('Create persists exact contacts and decimal balances across guarded reload and database reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-create-'));
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    const search = page.getByRole('textbox', {name: 'Search customers'});
    await search.fill('Ada');
    await search.press('Enter');
    await page.getByRole('link', {name: 'Add customer'}).click();
    const number = page.getByRole('textbox', {name: 'Customer number'});
    await expect(number).toBeDisabled();
    await expect(number).toHaveValue('3');
    await expect(number).toHaveAccessibleDescription(
      'Automatically assigned when you save.'
    );
    await expect(page.getByRole('textbox', {name: 'Province'})).toHaveValue('');
    await page.getByRole('button', {name: 'Save'}).click();
    await expect(
      page.getByText('Enter a first name, a last name, or both.', {exact: true})
    ).toBeVisible();
    await expect(page.getByRole('textbox', {name: 'First name'})).toBeFocused();
    await page.getByRole('textbox', {name: 'First name'}).fill('Ada');
    await page.getByRole('textbox', {name: 'Province'}).fill('somewhere');
    await page.getByRole('textbox', {name: 'Postal code'}).fill('aB cd');
    await page.getByRole('textbox', {name: 'Home phone'}).fill('+1 (902) 555-1234');
    await page.getByRole('textbox', {name: 'Email address'}).fill('contact text');
    await page.getByRole('textbox', {name: 'Balance ($)', exact: true}).fill('-1.23');
    await page.getByRole('button', {name: 'Save'}).click();
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    await page.getByRole('link', {name: 'Ada', exact: true}).click();
    await expect(page.getByRole('heading', {name: 'Ada', exact: true})).toBeVisible();
    await expect(number).toHaveValue('3');
    await expect(page.getByText('Customer saved', {exact: true})).toBeVisible();
    await expect(page.getByRole('textbox', {name: 'Postal code'})).toHaveValue('aB cd');
    await expect(page.getByRole('textbox', {name: 'Email address'})).toHaveValue(
      'contact text'
    );
    await expect(
      page.getByRole('textbox', {name: 'Balance ($)', exact: true})
    ).toHaveValue('-1.23');
    expect(new URL(page.url()).hash).toBe('#/customers/4');
    await page.getByRole('link', {name: 'Back to customers'}).click();
    await expect(page.getByRole('link', {name: 'Ada', exact: true})).toBeVisible();
    await expect(page.getByText('4 results', {exact: true})).toBeVisible();
    await page.getByRole('link', {name: 'Ada', exact: true}).click();
    await page.reload();
    await expect(
      page.getByRole('textbox', {name: 'Balance ($)', exact: true})
    ).toHaveValue('-1.23');
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
    await expect(page.getByText('4 results', {exact: true})).toBeVisible();
    await page.getByRole('link', {name: 'Ada', exact: true}).click();
    await expect(page.getByRole('textbox', {name: 'Province'})).toHaveValue('somewhere');
    await expect(
      page.getByRole('textbox', {name: 'Balance ($)', exact: true})
    ).toHaveValue('-1.23');
  } finally {
    await application.evaluate(() => Reflect.set(globalThis, 'acceptanceDiscard', true));
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('actual Save freezes edits, prevents duplicates and protects failure versus native close', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-create-races-'));
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5179/',
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole('link', {name: 'Add customer'}).click();
    const name = page.getByRole('textbox', {name: 'First name'});
    await name.fill('Submitted');
    await application.evaluate(() =>
      Reflect.set(globalThis, 'acceptanceFault', {
        channel: 'shop-things:customers.create',
        hold: true,
      })
    );
    await page.getByRole('button', {name: 'Save'}).click();
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceHeldRead')?.channel)
      )
      .toBe('shop-things:customers.create');
    await expect(page.getByRole('button', {name: 'Save'})).toBeDisabled();
    await expect(name).toBeDisabled();
    await expect(page.getByRole('textbox', {name: 'Comments'})).toBeDisabled();
    await expect(page.getByRole('checkbox', {name: 'Donate'})).toBeDisabled();
    await page.keyboard.type('Ignored');
    await page.locator('form').evaluate(form => form.requestSubmit());
    await page.getByRole('link', {name: 'Cancel'}).click();
    await expect(
      page.getByRole('heading', {name: 'New Customer', exact: true})
    ).toBeVisible();
    await application.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceReleaseRead')();
      Reflect.set(globalThis, 'acceptanceHeldRead', null);
    });
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    await page.getByRole('link', {name: 'Submitted', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Submitted', exact: true})
    ).toBeVisible();
    expect(
      await application.evaluate(
        () =>
          Reflect.get(globalThis, 'acceptanceIpc').filter(
            (channel: string) => channel === 'shop-things:customers.create'
          ).length
      )
    ).toBe(1);
    expect(new URL(page.url()).hash).toBe('#/customers/4');
    await page.getByRole('link', {name: 'Back to customers'}).click();
    await expect(page.getByText('4 results', {exact: true})).toBeVisible();
    await page.getByRole('link', {name: 'Add customer'}).click();
    await name.fill('Saved before transition');
    await application.evaluate(
      ({dialog}, path) => {
        dialog.showOpenDialog = async () => ({canceled: false, filePaths: [path]});
      },
      join(directory, 'customers.sqlite')
    );
    await application.evaluate(() =>
      Reflect.set(globalThis, 'acceptanceFault', {
        channel: 'shop-things:customers.create',
        hold: true,
      })
    );
    await page.getByRole('button', {name: 'Save'}).click();
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceHeldRead')?.channel)
      )
      .toBe('shop-things:customers.create');
    const opening = page.evaluate(() =>
      Reflect.get(window, 'shopThings').database.open()
    );
    await expect(name).toBeDisabled();
    await application.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceReleaseRead')();
      Reflect.set(globalThis, 'acceptanceHeldRead', null);
    });
    expect((await opening).status).toBe('success');
    await expect(page.getByText('5 results', {exact: true})).toBeVisible();
    await expect(page.getByRole('link', {name: 'Saved before transition'})).toBeVisible();
    await expect(page.getByText('Customer saved', {exact: true})).toHaveCount(0);
    await page.getByRole('link', {name: 'Add customer'}).click();
    await name.fill('Retained failure');
    await application.evaluate(() =>
      Reflect.set(globalThis, 'acceptanceFault', {
        channel: 'shop-things:customers.create',
        before: true,
        hold: true,
        error: {
          code: 'VALIDATION',
          message: 'Supplied save failure',
          fieldErrors: {firstName: 'Supplied name feedback'},
        },
      })
    );
    await page.getByRole('button', {name: 'Save'}).click();
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceHeldRead')?.channel)
      )
      .toBe('shop-things:customers.create');
    await application.evaluate(({app}) => app.quit());
    await expect(name).toBeDisabled();
    await application.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceReleaseRead')();
      Reflect.set(globalThis, 'acceptanceHeldRead', null);
    });
    await expect(name).toBeEnabled();
    await expect(name).toHaveValue('Retained failure');
    await expect(
      page.getByRole('main').getByText('Supplied save failure', {exact: true})
    ).toBeVisible();
    await expect(page.getByText('Supplied name feedback', {exact: true})).toBeVisible();
    await application.evaluate(() => Reflect.set(globalThis, 'acceptanceDiscard', true));
    await page.getByRole('link', {name: 'Cancel'}).click();
    await expect(page.getByText('5 results', {exact: true})).toBeVisible();
  } finally {
    await application.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceReleaseRead')?.();
      Reflect.set(globalThis, 'acceptanceDiscard', true);
    });
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('Chromium preview Create shares validation and safe draft guards with temporary saved data', async ({
  page,
}) => {
  await page.goto('/?preview=true#/customers');
  await page.getByRole('link', {name: 'Add customer'}).click();
  await page.getByRole('textbox', {name: 'First name'}).fill('Temporary');
  await page.getByRole('textbox', {name: 'Balance ($)', exact: true}).fill('-');
  await page.getByRole('button', {name: 'Save'}).click();
  await expect(
    page.getByText('Enter an amount with at most two decimal places.', {exact: true})
  ).toBeVisible();
  await page.getByRole('link', {name: 'Cancel'}).click();
  await expect(page.getByRole('button', {name: 'Stay'})).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('textbox', {name: 'Balance ($)', exact: true})).toHaveValue(
    '-'
  );
  await page.getByRole('textbox', {name: 'Balance ($)', exact: true}).fill('-2.34');
  await page.getByRole('button', {name: 'Save'}).click();
  await expect(page.getByRole('heading', {name: 'Customers', exact: true})).toBeVisible();
  await page.getByRole('link', {name: 'Temporary', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Temporary', exact: true})).toBeVisible();
  await expect(page.getByRole('textbox', {name: 'Balance ($)', exact: true})).toHaveValue(
    '-2.34'
  );
  await page.getByRole('link', {name: 'Back to customers'}).click();
  await expect(page.getByRole('link', {name: 'Temporary', exact: true})).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', {name: 'No Customers Yet'})).toBeVisible();
  expect(new URL(page.url()).searchParams.get('preview')).toBe('true');
});

test('native close waits for an admitted Save and the saved customer survives reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-create-close-'));
  let application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole('link', {name: 'Add customer'}).click();
    await page.getByRole('textbox', {name: 'First name'}).fill('Saved before close');
    await application.evaluate(() =>
      Reflect.set(globalThis, 'acceptanceFault', {
        channel: 'shop-things:customers.create',
        hold: true,
      })
    );
    await page.getByRole('textbox', {name: 'First name'}).press('Enter');
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceHeldRead')?.channel)
      )
      .toBe('shop-things:customers.create');
    await application.evaluate(({BrowserWindow}) =>
      BrowserWindow.getAllWindows()[0].close()
    );
    await expect(page.getByRole('textbox', {name: 'First name'})).toBeDisabled();
    expect(application.windows()).toHaveLength(1);
    const closed = page.waitForEvent('close');
    await application.evaluate(() => Reflect.get(globalThis, 'acceptanceReleaseRead')());
    await closed;
    await application.close();
    application = await launchElectron(directory);
    const reopened = await application.firstWindow();
    await expect(reopened.getByRole('link', {name: 'Saved before close'})).toBeVisible();
  } finally {
    if (application.windows().length) {
      await application.evaluate(() => {
        Reflect.get(globalThis, 'acceptanceReleaseRead')?.();
        Reflect.set(globalThis, 'acceptanceDiscard', true);
      });
      await application.close();
    }

    await rm(directory, {recursive: true, force: true});
  }
});
