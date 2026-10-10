import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test, type Page} from '@playwright/test';

import launchElectron from './launchElectron';

async function expectCustomerOrder(page: Page, names: string[]) {
  const links = page.getByRole('list', {name: 'Customers'}).getByRole('link');
  await expect(links).toHaveCount(names.length);
  for (const [index, name] of names.entries()) {
    await expect(links.nth(index)).toHaveAccessibleName(name);
  }
}

const alphaDetailLink = /\/customers\/2$/;

test('saved customer list/search/detail through actual bundled hash renderer IPC', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-customers-'));
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    await expectCustomerOrder(page, ['Zed Two', 'Alpha One', 'Numbered Three']);
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
    await expect(
      page.getByRole('textbox', {name: 'Previous balance ($)', exact: true})
    ).toHaveValue('10.00');
    await expect(
      page.getByRole('textbox', {name: 'Balance ($)', exact: true})
    ).toHaveValue('-1.23');
    await expect(page.getByRole('textbox', {name: 'Phone', exact: true})).toHaveValue(
      '+1 (902) 555-1234'
    );
    await expect(page.getByRole('button', {name: 'Save'})).toBeDisabled();
    await expect(page.getByRole('button', {name: 'Delete customer'})).toBeEnabled();
    await page.reload();
    await expect(
      page.getByRole('heading', {name: 'Alpha One', exact: true})
    ).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#/customers/2');
    await page.getByRole('link', {name: 'Back to customers'}).click();
    await expect(search).toHaveValue('');
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    await search.fill('1');
    await search.press('Enter');
    await expect(page.getByRole('link', {name: 'Zed Two'})).toBeVisible();
    await page.getByRole('button', {name: 'Clear'}).click();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    await page.getByRole('link', {name: 'Numbered Three'}).click();
    await expect(
      page.getByRole('textbox', {name: 'Customer number', exact: true})
    ).toHaveValue('3');
    await expect(
      page.getByRole('textbox', {name: 'Balance ($)', exact: true})
    ).toHaveValue('0.00');
    await expect(
      page.getByRole('textbox', {name: 'Previous balance ($)', exact: true})
    ).toHaveValue('0.00');
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

test('header lookup opens exact saved numbers and retains focus through held reads and error toasts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-customer-lookup-'));
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole('link', {name: 'Alpha One', exact: true}).click();
    await page.getByRole('textbox', {name: 'Customer number', exact: true}).fill('42');
    await page.getByRole('textbox', {name: 'Phone', exact: true}).fill('9025551234');
    await page.getByRole('textbox', {name: 'Phone', exact: true}).press('Tab');
    await page.getByRole('button', {name: 'Save', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    await page.getByRole('region', {name: 'Notifications'}).focus();
    await page.getByLabel('Dismiss notification', {exact: true}).click();
    const input = page.getByRole('textbox', {
      name: 'Go to customer number',
      exact: true,
    });
    const go = page.getByRole('button', {name: 'Go', exact: true});
    await input.fill(' 0042 ');
    await go.click();
    await expect(
      page.getByRole('heading', {name: 'Alpha One', exact: true})
    ).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#/customers/2');
    await expect(
      page.getByRole('textbox', {name: 'Customer number', exact: true})
    ).toHaveValue('42');
    for (const outcome of ['missing', 'error']) {
      const value = outcome === 'missing' ? '4' : '42';
      await application.evaluate((_, outcome) => {
        Reflect.set(globalThis, 'acceptanceFault', {
          channel: 'shop-things:customers.list',
          hold: true,
          ...(outcome === 'error'
            ? {error: {code: 'INTERNAL', message: 'Lookup read failed'}}
            : {}),
        });
      }, outcome);
      await input.fill(value);
      await input.press('Enter');
      await expect
        .poll(() =>
          application.evaluate(
            () => Reflect.get(globalThis, 'acceptanceHeldRead')?.channel
          )
        )
        .toBe('shop-things:customers.list');
      await expect(input).toBeEnabled();
      await expect(input).toHaveAttribute('readonly', '');
      await expect(input).toBeFocused();
      await expect(go).toBeDisabled();
      await page.keyboard.type('1');
      await page.keyboard.press('Enter');
      await expect(input).toHaveValue(value);
      await application.evaluate(() => {
        Reflect.get(globalThis, 'acceptanceReleaseRead')();
        Reflect.set(globalThis, 'acceptanceHeldRead', null);
      });
      await expect(input).not.toHaveAttribute('readonly');
      await expect(input).toBeFocused();
      await expect(go).toBeEnabled();
      expect(new URL(page.url()).hash).toBe('#/customers/2');
      const notifications = page.getByRole('region', {name: 'Notifications'});
      const description =
        outcome === 'missing'
          ? 'Customer number 4 was not found.'
          : 'Could not open the customer. Try again.';
      await expect(notifications.getByText(description, {exact: true})).toBeVisible();
      await page.keyboard.press('F6');
      const toast = notifications.getByRole('alertdialog', {
        name: 'Could not open customer',
        exact: true,
      });
      await expect(toast).toHaveAccessibleDescription(description);
      await toast
        .getByRole('button', {name: 'Dismiss error', exact: true})
        .press('Enter');
      await expect(toast).toHaveCount(0);
      await expect(input).toBeFocused();
    }

    await page.getByRole('link', {name: 'Back to customers', exact: true}).click();
    await input.fill('42');
    await input.press('Enter');
    await expect(
      page.getByRole('heading', {name: 'Alpha One', exact: true})
    ).toBeVisible();
    expect(new URL(page.url()).hash).toBe('#/customers/2');
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
    await expect(page.getByRole('status')).toHaveText('Loading customers…');
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
      page.getByRole('heading', {name: 'Numbered Three', exact: true})
    ).toBeVisible();
    await page.evaluate(() => {
      location.hash = '/customers/999?q=Zed';
    });
    await expect(page.getByRole('heading', {name: 'Customer Not Found'})).toBeVisible();
    await page.getByRole('link', {name: 'Back to customers'}).click();
    await expect(search).toHaveValue('');
    // Reload to test a cold detail read rather than reuse the Router's cached record.
    await page.reload();
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
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
    await expect(page.getByRole('status')).toHaveText('Loading customers…');
    await application.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceReleaseRead')();
    });
    await expect(page.getByText('3 results', {exact: true})).toBeVisible();
    await expect(search).toHaveValue('');
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
  await expect(page.getByRole('textbox', {name: 'Search customers'})).toHaveValue('');
  expect(new URL(page.url()).searchParams.get('preview')).toBe('true');
  await expect(page.getByRole('button', {name: 'Clear'})).toBeDisabled();
  await expect(page.getByRole('heading', {name: 'No Customers Yet'})).toBeVisible();
});

test('Chromium preview searches temporary customers by name and number with predictable ordering', async ({
  page,
}) => {
  await page.goto('/?preview=true#/customers');
  for (const name of ['Zoe', 'alice', 'Alina', '[literal]']) {
    await page.getByRole('link', {name: 'Add customer'}).click();
    await page.getByRole('textbox', {name: 'First name'}).fill(name);
    await page.getByRole('button', {name: 'Save'}).click();
    await expect(page.getByRole('link', {name, exact: true})).toBeVisible();
  }

  const search = page.getByRole('textbox', {name: 'Search customers'});
  await search.fill(' ALI ');
  await search.press('Enter');
  await expect(page.getByText('2 results', {exact: true})).toBeVisible();
  await expectCustomerOrder(page, ['alice', 'Alina']);
  await search.fill('1');
  await search.press('Enter');
  await expect(page.getByText('1 result', {exact: true})).toBeVisible();
  await expectCustomerOrder(page, ['Zoe']);
  await search.fill('[literal]');
  await search.press('Enter');
  await expect(page.getByText('1 result', {exact: true})).toBeVisible();
  await expectCustomerOrder(page, ['[literal]']);
  await page.getByRole('button', {name: 'Clear'}).click();
  await expect(page.getByText('4 results', {exact: true})).toBeVisible();
  await expectCustomerOrder(page, ['Zoe', 'alice', 'Alina', '[literal]']);
});
