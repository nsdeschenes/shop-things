import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {expect, test} from '@playwright/test';

import launchElectron from './launchElectron.js';

const root = fileURLToPath(new URL('..', import.meta.url));

test('actual IPC protects invalid controlled drafts, reversion, native close/quit and reload', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-protection-'));
  const application = await launchElectron(directory, {
    VITE_DEV_SERVER_URL: 'http://127.0.0.1:5179/',
  });
  try {
    const page = await application.firstWindow();
    await expect(
      page.getByRole('heading', {name: 'Set Up Your Database', exact: true})
    ).toBeVisible();
    await page.addScriptTag({
      path: join(root, 'acceptance-reports/harness/controlled-editor.mjs'),
      type: 'module',
    });
    await page.waitForFunction(
      () => Reflect.get(window, 'acceptanceEditorReady') === true
    );
    const input = page.getByRole('textbox', {name: 'Controlled balance'});
    await input.fill('-');
    await application.evaluate(({BrowserWindow}) => {
      BrowserWindow.getAllWindows()[0]!.close();
    });
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceDialogs').length)
      )
      .toBe(1);
    await expect(input).toHaveValue('-');
    await expect(input).toBeEnabled();
    await application.evaluate(({app}) => {
      app.quit();
    });
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceDialogs').length)
      )
      .toBe(2);
    expect(application.windows()).toHaveLength(1);
    await expect(input).toHaveValue('-');
    function reload() {
      return application.evaluate(({Menu}) => {
        const item = Menu.getApplicationMenu()!
          .items.find(entry => entry.label === 'View')!
          .submenu!.items.find(entry => entry.label === 'Reload')!;
        item.click();
      });
    }

    await reload();
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceDialogs').length)
      )
      .toBe(3);
    await expect(input).toHaveValue('-');
    await expect(input).toBeEnabled();
    // Explicit clean reversion lets reload proceed without another discard prompt.
    await input.fill('0.00');
    const reloaded = page.waitForEvent('load');
    await reload();
    await reloaded;
    await expect(
      page.getByRole('heading', {name: 'Set Up Your Database', exact: true})
    ).toBeVisible();
    await expect(input).toHaveCount(0);
    expect(
      await application.evaluate(
        () => Reflect.get(globalThis, 'acceptanceDialogs').length
      )
    ).toBe(3);
    // An unresponsive pending renderer Save must abort without treating timeout as consent.
    await page.addScriptTag({
      path: join(root, 'acceptance-reports/harness/controlled-editor.mjs'),
      type: 'module',
    });
    await page.waitForFunction(
      () => Reflect.get(window, 'acceptanceEditorReady') === true
    );
    await input.fill('-');
    await page.evaluate(() => Reflect.get(window, 'acceptanceEditor').beginSave());
    await reload();
    await expect(input).toBeDisabled();
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceDialogs').length)
      )
      .toBe(4);
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('-');
    await page.evaluate(() => Reflect.get(window, 'acceptanceEditor').finishSave());
    // A missing participant aborts before replacement and supplies retry guidance.
    await page.evaluate(() => Reflect.get(window, 'acceptanceEditor').stop());
    await reload();
    await expect
      .poll(() =>
        application.evaluate(() => Reflect.get(globalThis, 'acceptanceDialogs').length)
      )
      .toBe(5);
    await expect(input).toHaveCount(1);
    expect(
      await application.evaluate(
        () => Reflect.get(globalThis, 'acceptanceDialogs').at(-1).detail
      )
    ).toContain('try again');
    await page.evaluate(() => Reflect.get(window, 'acceptanceEditor').restore());
  } finally {
    const page = application.windows()[0];
    if (page) {
      await page.evaluate(async () => {
        const editor = Reflect.get(window, 'acceptanceEditor');
        editor?.finishSave();
        await editor?.restore();
      });
    }

    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});
