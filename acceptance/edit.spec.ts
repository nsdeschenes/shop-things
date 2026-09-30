import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from '@playwright/test';

import launchElectron from './launchElectron';

test('Edit validates duplicate and unassigned numbers and persists exact text after reopening', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-edit-'));
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole('link', {name: 'Alpha One'}).click();
    await page.getByRole('button', {name: 'Edit customer'}).click();
    await expect(page.getByRole('textbox', {name: 'Home phone'})).toHaveValue(
      '+1 (902) 555-1234'
    );
    await expect(page.getByRole('textbox', {name: 'Province'})).toHaveValue('');
    const number = page.getByRole('textbox', {name: 'Customer number'});
    await number.fill('1');
    await page.getByRole('textbox', {name: 'Last name'}).fill('Edited');
    await page.getByRole('button', {name: 'Save'}).click();
    await expect(
      page.getByText('Customer number is already assigned', {exact: true})
    ).toBeVisible();
    await expect(number).toHaveValue('1');
    await expect(page.getByRole('textbox', {name: 'Last name'})).toHaveValue('Edited');
    await number.fill('11');
    await page.getByRole('textbox', {name: 'Province'}).fill('custom province');
    await page.getByRole('textbox', {name: 'Postal code'}).fill('aB cd');
    await page.getByRole('textbox', {name: 'Email address'}).fill('contact text');
    await page.getByRole('textbox', {name: 'Balance ($)', exact: true}).fill('-12.30');
    await page.getByRole('button', {name: 'Save'}).click();
    await expect(
      page.getByRole('heading', {name: 'Alpha Edited', exact: true})
    ).toBeVisible();
    await expect(page.getByText('Customer saved.', {exact: true})).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#/customers/2');
    await page.getByRole('link', {name: 'Back to customers'}).click();
    await expect(page.getByRole('link', {name: 'Alpha Edited'})).toBeVisible();
    await page.getByRole('link', {name: 'Unnumbered Three'}).click();
    await expect(page.getByText('Unassigned', {exact: true})).toBeVisible();
    await page.getByRole('button', {name: 'Edit customer'}).click();
    await expect(number).toHaveValue('');
    await page.getByRole('button', {name: 'Save'}).click();
    await expect(
      page.getByText('Enter a positive whole customer number.', {exact: true})
    ).toBeVisible();
    await expect(number).toBeFocused();
    await number.fill('-');
    await page.getByRole('button', {name: 'Save'}).click();
    await expect(number).toHaveValue('-');
    await number.fill('7');
    await page.getByRole('button', {name: 'Save'}).click();
    await expect(
      page.getByRole('heading', {name: 'Unnumbered Three', exact: true})
    ).toBeVisible();
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
    await page.getByRole('link', {name: 'Alpha Edited'}).click();
    await expect(page.getByText('aB cd', {exact: true})).toBeVisible();
    await expect(page.getByText('custom province', {exact: true})).toBeVisible();
    await expect(page.getByText('$-12.30', {exact: true})).toBeVisible();
    await page.getByRole('link', {name: 'Back to customers'}).click();
    await page.getByRole('link', {name: 'Unnumbered Three'}).click();
    await expect(page.getByText('7', {exact: true})).toBeVisible();
  } finally {
    await application.evaluate(() => Reflect.set(globalThis, 'acceptanceDiscard', true));
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('held Update freezes editing and rejects retained stale revisions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-edit-race-'));
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5179/',
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole('link', {name: 'Alpha One'}).click();
    await page.getByRole('button', {name: 'Edit customer'}).click();
    const name = page.getByRole('textbox', {name: 'First name'});
    await name.fill('Submitted');
    await application.evaluate(() =>
      Reflect.set(globalThis, 'acceptanceFault', {
        channel: 'shop-things:customers.update',
        hold: true,
      })
    );
    await page.getByRole('button', {name: 'Save'}).click();
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceHeldRead')?.channel)
      )
      .toBe('shop-things:customers.update');
    await expect(page.getByRole('button', {name: 'Save'})).toBeDisabled();
    await expect(name).toBeDisabled();
    await expect(page.getByRole('textbox', {name: 'Customer number'})).toBeDisabled();
    await page.keyboard.type('Ignored');
    await page.locator('form').evaluate(form => form.requestSubmit());
    await page.getByRole('link', {name: 'Cancel'}).click();
    await expect(
      page.getByRole('heading', {name: 'Edit Customer', exact: true})
    ).toBeVisible();
    await application.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceReleaseRead')();
      Reflect.set(globalThis, 'acceptanceHeldRead', null);
    });
    await expect(
      page.getByRole('heading', {name: 'Submitted One', exact: true})
    ).toBeVisible();
    expect(
      await application.evaluate(
        () =>
          Reflect.get(globalThis, 'acceptanceIpc').filter(
            (value: string) => value === 'shop-things:customers.update'
          ).length
      )
    ).toBe(1);
    await page.getByRole('button', {name: 'Edit customer'}).click();
    await name.fill('Retained draft');
    const external = await page.evaluate(async () => {
      const client = Reflect.get(window, 'shopThings');
      const status = await client.database.status();
      const loaded = await client.customers.get({session: status.value.session, id: 2});
      return client.customers.update({
        reference: loaded.value.reference,
        changes: {firstName: 'External'},
      });
    });
    expect(external.status).toBe('success');
    await page.getByRole('button', {name: 'Save'}).click();
    await expect(
      page.getByText('This customer changed. Reload before editing.', {exact: true})
    ).toBeVisible();
    await expect(name).toHaveValue('Retained draft');
    await expect(page.getByRole('button', {name: 'Save'})).toBeDisabled();
    await application.evaluate(({app}) => app.quit());
    await expect(name).toBeEnabled();
    await expect(name).toHaveValue('Retained draft');
    await application.evaluate(() => Reflect.set(globalThis, 'acceptanceDiscard', true));
    await page.getByRole('link', {name: 'Cancel'}).click();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
  } finally {
    await application.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceReleaseRead')?.();
      Reflect.set(globalThis, 'acceptanceDiscard', true);
    });
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('Chromium preview edits temporary saved records with exact contact and number drafts', async ({
  page,
}) => {
  await page.goto('/?preview=true#/customers/new');
  await page.getByRole('textbox', {name: 'First name'}).fill('Temporary');
  await page.getByRole('button', {name: 'Save'}).click();
  await page.getByRole('button', {name: 'Edit customer'}).click();
  const number = page.getByRole('textbox', {name: 'Customer number'});
  await number.fill('-');
  await page.getByRole('button', {name: 'Save'}).click();
  await expect(number).toHaveValue('-');
  await page.getByRole('link', {name: 'Cancel'}).click();
  await expect(page.getByRole('button', {name: 'Stay'})).toBeFocused();
  await page.keyboard.press('Enter');
  await number.fill('42');
  await page.getByRole('textbox', {name: 'Province'}).fill('arbitrary');
  await page.getByRole('textbox', {name: 'Postal code'}).fill('aB cd');
  await page.getByRole('textbox', {name: 'First name'}).fill('Edited');
  await page.getByRole('button', {name: 'Save'}).click();
  await expect(page.getByRole('heading', {name: 'Edited', exact: true})).toBeVisible();
  await expect(page.getByText('42', {exact: true})).toBeVisible();
  await expect(page.getByText('aB cd', {exact: true})).toBeVisible();
  await page.getByRole('link', {name: 'Back to customers'}).click();
  await page.getByRole('textbox', {name: 'Search customers'}).fill('0042');
  await page.getByRole('textbox', {name: 'Search customers'}).press('Enter');
  await expect(page.getByRole('link', {name: 'Edited', exact: true})).toBeVisible();
});
