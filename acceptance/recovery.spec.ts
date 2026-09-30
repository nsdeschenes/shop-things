import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from '@playwright/test';

import launchElectron from './launchElectron';

test('real IPC stale reload cancels, fails, freezes, then adopts a fresh reference; deleted drafts remain copyable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-recovery-'));
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole('link', {name: 'Alpha One'}).click();
    await page.getByRole('button', {name: 'Edit customer'}).click();
    const name = page.getByRole('textbox', {name: 'First name'});
    await name.fill('Retained draft');
    expect(
      await page.evaluate(async () => {
        const client = Reflect.get(window, 'shopThings');
        const state = await client.database.status();
        const record = await client.customers.get({session: state.value.session, id: 2});
        return (
          await client.customers.update({
            reference: record.value.reference,
            changes: {firstName: 'External'},
          })
        ).status;
      })
    ).toBe('success');
    await page.getByRole('button', {name: 'Save'}).click();
    await expect(
      page.getByText(
        'The saved customer changed. Reload before saving again. Your edits are retained.'
      )
    ).toBeVisible();
    const reload = page.getByRole('button', {name: 'Reload customer'});
    await reload.click();
    await expect(name).toHaveValue('Retained draft');
    await expect(page.getByRole('button', {name: 'Save'})).toBeDisabled();
    await application.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceDiscard', true);
      Reflect.set(globalThis, 'acceptanceFault', {
        channel: 'shop-things:customers.get',
        before: true,
        error: {code: 'INTERNAL', message: 'Reload read failed'},
      });
    });
    await reload.click();
    await expect(page.getByText('Reload read failed', {exact: true})).toBeVisible();
    await expect(name).toHaveValue('Retained draft');
    await expect(page.getByRole('button', {name: 'Save'})).toBeDisabled();
    await application.evaluate(() =>
      Reflect.set(globalThis, 'acceptanceFault', {
        channel: 'shop-things:customers.get',
        hold: true,
      })
    );
    await reload.click();
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceHeldRead')?.channel)
      )
      .toBe('shop-things:customers.get');
    await expect(name).toBeDisabled();
    await application.evaluate(() => Reflect.get(globalThis, 'acceptanceReleaseRead')());
    await expect(name).toHaveValue('External');
    await expect(page.getByRole('button', {name: 'Save'})).toBeEnabled();
    await name.fill('Fresh reference');
    await page.getByRole('button', {name: 'Save'}).click();
    await expect(
      page.getByRole('heading', {name: 'Fresh reference One', exact: true})
    ).toBeVisible();
    await page.getByRole('button', {name: 'Edit customer'}).click();
    await name.fill('Copy this draft');
    expect(
      await page.evaluate(async () => {
        const client = Reflect.get(window, 'shopThings');
        const state = await client.database.status();
        const record = await client.customers.get({session: state.value.session, id: 2});
        return (await client.customers.delete({reference: record.value.reference}))
          .status;
      })
    ).toBe('success');
    await page.getByRole('button', {name: 'Save'}).click();
    await expect(page.getByRole('heading', {name: 'Customer Not Found'})).toBeVisible();
    await expect(name).toHaveValue('Copy this draft');
    await expect(name).toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', {name: 'Save'})).toBeDisabled();
    await application.evaluate(() => Reflect.set(globalThis, 'acceptanceDiscard', false));
    await page.getByRole('link', {name: 'Cancel', exact: true}).click();
    await expect(name).toHaveValue('Copy this draft');
    await application.evaluate(() => Reflect.set(globalThis, 'acceptanceDiscard', true));
    await page.getByRole('link', {name: 'Cancel', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    await expect(
      page.getByRole('link', {name: 'Fresh reference One', exact: true})
    ).toHaveCount(0);
  } finally {
    await application.evaluate(() => Reflect.set(globalThis, 'acceptanceDiscard', true));
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('unavailable real database retains mounted draft across cancelled and failed Retry, clears only committed new session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-unavailable-'));
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
    SHOP_THINGS_ACCEPTANCE_RECOVERY: 'true',
  });
  try {
    const page = await application.firstWindow();
    const search = page.getByRole('textbox', {name: 'Search customers'});
    await search.fill('Alpha');
    await search.press('Enter');
    await page.getByRole('link', {name: 'Alpha One'}).click();
    await page.getByRole('button', {name: 'Edit customer'}).click();
    const name = page.getByRole('textbox', {name: 'First name'});
    await name.fill('Unavailable draft');
    await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceService').closeUnprotected()
    );
    await expect(
      page.getByText('The database is unavailable. Your edits are retained.')
    ).toBeVisible();
    await expect(name).toHaveValue('Unavailable draft');
    await expect(page.getByRole('button', {name: 'Save'})).toBeDisabled();
    await page.getByRole('button', {name: 'Check database status'}).click();
    await expect(name).toHaveValue('Unavailable draft');
    await page.getByRole('button', {name: 'Retry database'}).click();
    await expect(name).toHaveValue('Unavailable draft');
    await application.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceDiscard', true);
      Reflect.set(globalThis, 'acceptanceFault', {
        channel: 'shop-things:database.retry',
        before: true,
        error: {code: 'INTERNAL', message: 'Retry failed'},
      });
    });
    await page.getByRole('button', {name: 'Retry database'}).click();
    await expect(page.getByText('Retry failed', {exact: true})).toBeVisible();
    await expect(name).toHaveValue('Unavailable draft');
    await page.getByRole('button', {name: 'Retry database'}).click();
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    await expect(search).toHaveValue('');
    await expect(page.getByRole('link', {name: 'Alpha One'})).toBeVisible();
    await expect(name).toHaveCount(0);
    expect(new URL(page.url()).hash).toBe('#/customers');
  } finally {
    await application.evaluate(() => Reflect.set(globalThis, 'acceptanceDiscard', true));
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('Chromium preview reload guards draft replacement and preserves canonical saved text', async ({
  page,
}) => {
  await page.goto('/?preview=true#/customers/new');
  await page.getByRole('textbox', {name: 'First name'}).fill('Saved preview');
  await page.getByRole('button', {name: 'Save'}).click();
  await page.getByRole('button', {name: 'Edit customer'}).click();
  const name = page.getByRole('textbox', {name: 'First name'});
  await name.fill('Preview draft');
  const reload = page.getByRole('button', {name: 'Reload customer'});
  await reload.click();
  await page.getByRole('dialog').getByRole('button', {name: 'Stay'}).click();
  await expect(name).toHaveValue('Preview draft');
  await reload.click();
  await page.getByRole('dialog').getByRole('button', {name: 'Discard'}).click();
  await expect(name).toHaveValue('Saved preview');
  await page.getByRole('link', {name: 'Cancel', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Customers', exact: true})).toBeVisible();
});

test('real IPC stale Delete stays blocked until fresh reload and deleted selection becomes not found', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-delete-recovery-'));
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole('link', {name: 'Alpha One'}).click();
    await expect(
      page.getByRole('heading', {name: 'Alpha One', exact: true})
    ).toBeVisible();
    expect(
      await page.evaluate(async () => {
        const client = Reflect.get(window, 'shopThings');
        const state = await client.database.status();
        const record = await client.customers.get({session: state.value.session, id: 2});
        return (
          await client.customers.update({
            reference: record.value.reference,
            changes: {firstName: 'External'},
          })
        ).status;
      })
    ).toBe('success');
    await page.getByRole('button', {name: 'Delete customer', exact: true}).click();
    await page
      .getByRole('dialog')
      .getByRole('button', {name: 'Delete customer', exact: true})
      .click();
    await expect(
      page.getByText('The saved customer changed. Reload before deleting again.')
    ).toBeVisible();
    await expect(
      page.getByRole('button', {name: 'Delete customer', exact: true})
    ).toBeDisabled();
    await page.getByRole('button', {name: 'Reload customer'}).click();
    await expect(
      page.getByRole('heading', {name: 'External One', exact: true})
    ).toBeVisible();
    await expect(
      page.getByRole('button', {name: 'Delete customer', exact: true})
    ).toBeEnabled();
    expect(
      await page.evaluate(async () => {
        const client = Reflect.get(window, 'shopThings');
        const state = await client.database.status();
        const record = await client.customers.get({session: state.value.session, id: 2});
        return (await client.customers.delete({reference: record.value.reference}))
          .status;
      })
    ).toBe('success');
    await page.getByRole('button', {name: 'Delete customer', exact: true}).click();
    await page
      .getByRole('dialog')
      .getByRole('button', {name: 'Delete customer', exact: true})
      .click();
    await expect(page.getByRole('heading', {name: 'Customer Not Found'})).toBeVisible();
    await expect(
      page.getByRole('button', {name: 'Delete customer', exact: true})
    ).toHaveCount(0);
  } finally {
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});
