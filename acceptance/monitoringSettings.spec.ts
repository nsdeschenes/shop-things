import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from '@playwright/test';

import launchElectron from './launchElectron.js';

const monitoringTabUrl = /#\/settings\/monitoring$/;

test('Settings can save while actual database startup is held and corrupt monitoring settings keep recovery usable', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-held-settings-'));
  let application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_DELAY_STARTUP: 'true',
  });
  try {
    let page = await application.firstWindow();
    await page.getByRole('link', {name: 'Settings', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Settings', exact: true})
    ).toBeVisible();
    expect(
      await application.evaluate(() =>
        Boolean(Reflect.get(globalThis, 'acceptanceReleaseStartup'))
      )
    ).toBe(true);
    await expect(page.getByRole('tab', {name: 'Database'})).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await page.getByRole('tab', {name: 'Monitoring'}).click();
    await expect(page).toHaveURL(monitoringTabUrl);
    await page.reload();
    await expect(page.getByRole('tab', {name: 'Monitoring'})).toHaveAttribute(
      'aria-selected',
      'true'
    );
    const input = page.getByRole('textbox', {name: 'Sentry DSN'});
    await input.fill('http://public@localhost:9000/1');
    await page.getByRole('button', {name: 'Save monitoring'}).click();
    await expect(page.getByRole('status')).toContainText('Restart Shop Things');
    expect(
      await page.evaluate(() => window.shopThings!.telemetry.status())
    ).toMatchObject({value: {activeEnabled: false, restartRequired: true}});
    await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceReleaseStartup')()
    );
    await page.getByRole('link', {name: 'Back to setup'}).click();
    await expect(page.getByRole('heading', {name: 'Settings', exact: true})).toHaveCount(
      0
    );
    await expect(page.getByRole('heading', {name: 'Set Up Your Database'})).toBeVisible();
    await application.close();
    await writeFile(join(directory, 'telemetry.json'), '{broken');
    application = await launchElectron(directory);
    page = await application.firstWindow();
    await page.getByRole('link', {name: 'Settings', exact: true}).click();
    await page.getByRole('tab', {name: 'Monitoring'}).click();
    await expect(page.getByRole('textbox', {name: 'Sentry DSN'})).toHaveValue('');
    await expect(page.getByRole('status')).toContainText('Monitoring is off');
  } finally {
    await application
      .evaluate(() => Reflect.get(globalThis, 'acceptanceReleaseStartup')?.())
      .catch(() => {});
    await application.close().catch(() => {});
    await rm(directory, {recursive: true, force: true}).catch(() => {});
  }
});
