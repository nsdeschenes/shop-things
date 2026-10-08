import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from '@playwright/test';

import launchElectron from './launchElectron';

test('real header/preload/main discovery fails closed without installed trust and retries explicitly', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-updates-'));
  const app = await launchElectron(directory);
  try {
    const page = await app.firstWindow();
    const control = page.getByRole('button', {name: 'Check for updates'});
    await expect(control).toBeVisible();
    await control.click();
    await expect(page.getByRole('status')).toHaveText(
      'Could not check for updates. Try again.'
    );
    await page.getByRole('button', {name: 'Retry', exact: true}).click();
    await expect(page.getByRole('status')).toHaveText(
      'Could not check for updates. Try again.'
    );
    const state = await page.evaluate(() =>
      Reflect.get(window, 'shopThings').update.getState({})
    );
    expect(state).toMatchObject({
      status: 'success',
      value: {
        phase: 'check-failed',
        errorCode: 'TRUST_UNAVAILABLE',
        capabilityReasons: expect.arrayContaining(['Installation is not available yet.']),
      },
    });
    const invalid = await page.evaluate(() =>
      Reflect.get(window, 'shopThings').update.start({
        candidateId: '../package.deb',
        command: 'install',
      })
    );
    expect(invalid).toMatchObject({status: 'error', error: {code: 'VALIDATION'}});
    await page.getByRole('button', {name: 'Close', exact: true}).click();
    await expect(control).toBeVisible();
    await expect(page.getByRole('button', {name: 'Retry', exact: true})).toHaveCount(0);
  } finally {
    await app.close();
    await rm(directory, {recursive: true, force: true});
  }
});
