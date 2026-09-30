import {mkdtemp, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from '@playwright/test';

import launchElectron from './launchElectron';

for (const parameter of ['', '?preview=false', '?preview=TRUE', '?preview=empty']) {
  test(`browser disables preview with ${parameter || 'no switch'}`, async ({page}) => {
    await page.goto(`/${parameter}#/customers`);
    await expect(page.getByText('Application unavailable', {exact: true})).toBeVisible();
    await expect(page.getByRole('button', {name: 'Add customer'})).toHaveCount(0);
  });
}

test('explicit preview survives routing and reload without native storage', async ({
  page,
}) => {
  await page.goto('/?preview=true#/customers/new');
  await expect(
    page.getByText('Browser preview — temporary data', {exact: false})
  ).toBeVisible();
  await expect(page.getByRole('button', {name: 'Database', exact: true})).toHaveCount(0);
  await expect(page.getByRole('combobox', {name: 'Simulation result'})).toHaveCount(0);
  await expect(
    page.getByRole('button', {name: 'Simulate remembered-file failure'})
  ).toHaveCount(0);
  for (const name of [
    'Create database',
    'Open database',
    'Retry remembered database',
    'Back up database',
    'Restore backup',
    'Export all customers',
  ]) {
    await expect(page.getByRole('button', {name, exact: true})).toHaveCount(0);
    await expect(page.getByRole('menuitem', {name, exact: true})).toHaveCount(0);
  }

  await expect(page.getByRole('button', {name: 'Save'})).toBeEnabled();
  await page.getByRole('link', {name: 'Customer records Shop Things'}).click();
  await expect(page.getByRole('heading', {name: 'Customers', exact: true})).toBeVisible();
  expect(new URL(page.url()).searchParams.get('preview')).toBe('true');
  await page.reload();
  await expect(
    page.getByText('Browser preview — temporary data', {exact: false})
  ).toBeVisible();
  expect(await page.evaluate(() => [localStorage.length, sessionStorage.length])).toEqual(
    [0, 0]
  );
});

for (const development of [true, false]) {
  test(`real Electron ${development ? 'development resource' : 'bundled HTML'} bootstrap`, async () => {
    const directory = await mkdtemp(join(tmpdir(), 'shop-things-renderer-'));
    const application = await launchElectron(directory, {
      SHOP_THINGS_ACCEPTANCE_DENY_HANDSHAKE: 'true',
      VITE_DEV_SERVER_URL: development ? 'http://127.0.0.1:5179/' : '',
    });
    try {
      const page = await application.firstWindow();
      await expect(page.getByText('Live mode', {exact: false})).toHaveCount(0);
      await expect(
        page.getByRole('heading', {name: 'Set Up Your Database', exact: true})
      ).toBeVisible();
      expect(
        await application.evaluate(() => Reflect.get(globalThis, 'acceptanceIpc'))
      ).toEqual(
        expect.arrayContaining([
          'shop-things:document',
          'shop-things:state-subscribe',
          'shop-things:draft-register',
          'shop-things:database.status',
        ])
      );
      const messages = await application.evaluate(() =>
        Reflect.get(globalThis, 'acceptanceIpc')
      );
      expect(messages.indexOf('shop-things:state-subscribe')).toBeLessThan(
        messages.indexOf('shop-things:database.status')
      );
      expect(messages.indexOf('shop-things:draft-register')).toBeLessThan(
        messages.indexOf('shop-things:database.status')
      );
      const url = new URL(page.url());
      url.search = '?preview=true';
      url.hash = '/customers/new';
      await application.evaluate(async ({BrowserWindow}, destination) => {
        await BrowserWindow.getAllWindows()[0]!.loadURL(destination);
      }, url.href);
      await expect(page.getByText('Live mode', {exact: false})).toHaveCount(0);
      await expect(
        page.getByRole('heading', {name: 'Set Up Your Database', exact: true})
      ).toBeVisible();
      await expect(page.getByRole('textbox', {name: 'First name'})).toHaveCount(0);
      await page.reload();
      await expect(
        page.getByRole('heading', {name: 'Set Up Your Database'})
      ).toBeVisible();
      await page.evaluate(() => {
        window.open('https://example.com');
      });
      expect(application.windows()).toHaveLength(1);
      const before = page.url();
      await page.evaluate(() => {
        location.href = 'https://example.com';
      });
      expect(
        await application.evaluate(({BrowserWindow}) =>
          BrowserWindow.getAllWindows()[0]!.webContents.getURL()
        )
      ).toBe(before);
      expect(
        await application.evaluate(({BrowserWindow}) =>
          BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(
            'document.querySelector("h1").textContent'
          )
        )
      ).toBe('Set Up Your Database');
      const protectedStatus = await application.evaluate(({BrowserWindow}) =>
        BrowserWindow.getAllWindows()[0]!.webContents.executeJavaScript(
          'window.shopThings.database.status()'
        )
      );
      expect(protectedStatus.status).toBe('success');
    } finally {
      await application.close();
      await rm(directory, {recursive: true, force: true});
    }
  });
}

test('failed live handshake never enters preview and Retry restores live registration', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-renderer-retry-'));
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_DENY_HANDSHAKE: 'always',
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5179/?preview=true',
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('button', {name: 'Retry'})).toBeVisible();
    await expect(page.getByText('Live mode', {exact: false})).toHaveCount(0);
    await expect(page.getByText('Browser preview', {exact: false})).toHaveCount(0);
    await application.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceDenyHandshake', null);
    });
    await page.getByRole('button', {name: 'Retry'}).click();
    await expect(
      page.getByRole('heading', {name: 'Set Up Your Database', exact: true})
    ).toBeVisible();
  } finally {
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});
test('actual newer database notification wins over a delayed startup status response', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-renderer-order-'));
  const databasePath = join(directory, 'created.sqlite');
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_DELAY_STATUS: 'true',
    SHOP_THINGS_ACCEPTANCE_CREATE_PATH: databasePath,
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5179/',
  });
  try {
    const page = await application.firstWindow();
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceStatusDelayed'))
      )
      .toBe(true);
    await expect(page.getByRole('status', {name: 'Loading application'})).toBeVisible();
    await expect(page.getByRole('banner').getByText('Shop Things')).toBeVisible();
    const created = await page.evaluate(async () => {
      const bridge = Reflect.get(window, 'shopThings');
      return bridge.database.create();
    });
    expect(created.status).toBe('success');
    expect(created.value.selectedPath).toBe(databasePath);
    expect((await stat(databasePath)).size).toBeGreaterThan(0);
    // Database controls wait for startup status while the header remains visible.
    await expect(
      page.getByText('Active database: created.sqlite', {exact: true})
    ).toHaveCount(0);
    const held = await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceHeldStatus')
    );
    expect(held.value.version).toBeLessThan(created.value.version);
    expect(held.value.available).toBe(false);
    await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceReleaseStatus')()
    );
    await expect(
      page.getByRole('heading', {name: 'Customers', exact: true})
    ).toBeVisible();
    await expect(
      page.getByText('Active database: created.sqlite', {exact: true})
    ).toBeVisible();
    const messages = await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceIpc')
    );
    expect(messages.indexOf('shop-things:state-subscribe')).toBeLessThan(
      messages.indexOf('shop-things:database.status')
    );
  } finally {
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});
