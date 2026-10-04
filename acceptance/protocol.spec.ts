import {mkdtemp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {_electron, expect, test} from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const executablePath = createRequire(
  new URL('../packages/electron/package.json', import.meta.url)
)('electron');

test('actual stale and duplicate draft resolutions cannot clear or unfreeze a newer prepared editor', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-protocol-'));
  const application = await _electron.launch({
    executablePath,
    args: [join(root, 'acceptance/electron-entry.mjs')],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      SHOP_THINGS_ACCEPTANCE_DATA: directory,
      SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
      SHOP_THINGS_ACCEPTANCE_BOUNDARY: 'true',
      VITE_DEV_SERVER_URL: '',
    },
  });
  try {
    const page = await application.firstWindow();
    await page.getByRole('link', {name: 'Alpha One'}).click();
    await page.getByRole('textbox', {name: 'Customer number'}).waitFor();
    const input = page.getByRole('textbox', {name: 'Balance ($)', exact: true});
    await input.fill('-');
    await application.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceDiscard', true);
      Reflect.get(globalThis, 'acceptanceFiles').push({hold: true});
    });
    async function prepareOpen() {
      // Exercise native lifecycle messages against an active draft independently of settings navigation.
      await page.evaluate(() => {
        void Reflect.get(window, 'shopThings').database.open();
      });
      await expect
        .poll(() =>
          application.evaluate(() => Reflect.get(globalThis, 'acceptancePickerHeld'))
        )
        .toBe(true);
      await expect(input).toBeDisabled();
      return application.evaluate(() =>
        Reflect.get(globalThis, 'acceptanceBoundary')
          .outgoing.filter(
            (entry: {channel: string}) => entry.channel === 'shop-things:draft-prepare'
          )
          .at(-1)
      );
    }

    const first = await prepareOpen();
    for (const kind of ['registration', 'request', 'document']) {
      await application.evaluate(
        ({BrowserWindow}, {first, kind}) => {
          const payload = {
            registrationId: first.payload.registrationId,
            resolution: {...first.payload.request, outcome: 'committed'},
          };
          if (kind === 'registration') {
            payload.registrationId = 'obsolete-registration';
          }

          if (kind === 'request') {
            payload.resolution.requestId = 'obsolete-request';
          }

          if (kind === 'document') {
            payload.resolution.documentId = 'obsolete-document';
          }

          BrowserWindow.getAllWindows()[0]!.webContents.send(
            'shop-things:draft-resolve',
            payload
          );
        },
        {first, kind}
      );
      await expect(input).toHaveValue('-');
      await expect(input).toBeDisabled();
    }

    await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceReleasePicker')()
    );
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('-');
    await application.evaluate(
      ({BrowserWindow}, first) =>
        BrowserWindow.getAllWindows()[0]!.webContents.send('shop-things:draft-resolve', {
          registrationId: first.payload.registrationId,
          resolution: {...first.payload.request, outcome: 'committed'},
        }),
      first
    );
    await expect(input).toHaveValue('-');
    await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceFiles').push({hold: true})
    );
    const second = await prepareOpen();
    expect(second.payload.request.requestId).not.toBe(first.payload.request.requestId);
    await application.evaluate(
      ({BrowserWindow}, first) =>
        BrowserWindow.getAllWindows()[0]!.webContents.send('shop-things:draft-resolve', {
          registrationId: first.payload.registrationId,
          resolution: {...first.payload.request, outcome: 'committed'},
        }),
      first
    );
    await expect(input).toHaveValue('-');
    await expect(input).toBeDisabled();
    await application.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceReleasePicker')()
    );
    await expect(input).toBeEnabled();
    await expect(input).toHaveValue('-');
    await expect(page.getByRole('status', {name: 'Loading database'})).toHaveCount(0);
  } finally {
    await application.evaluate(() => Reflect.set(globalThis, 'acceptanceDiscard', true));
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});
