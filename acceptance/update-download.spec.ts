import {execFileSync} from 'node:child_process';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {_electron, expect, test} from '@playwright/test';

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-update-ui-'));
  const packageRoot = join(directory, 'package');
  await mkdir(join(packageRoot, 'DEBIAN'), {recursive: true});
  await writeFile(
    join(packageRoot, 'DEBIAN/control'),
    'Package: shop-things\nVersion: 0.4.0\nArchitecture: arm64\nMaintainer: Shop Things\nDescription: Signed update UI acceptance\n'
  );
  const path = join(directory, 'fixture.deb');
  execFileSync('/usr/bin/dpkg-deb', ['--build', '--root-owner-group', packageRoot, path]);
  const installer = await readFile(path);
  const keys = generateKeyPairSync('ed25519');
  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      applicationId: 'com.shopthings.app',
      repository: 'nsdeschenes/shop-things',
      channel: 'stable',
      appVersion: '0.4.0',
      packageName: 'shop-things',
      packageVersion: '0.4.0',
      platform: 'linux',
      architecture: 'arm64',
      helperProtocol: {min: 1, max: 1},
      artifact: {
        filename: 'shop-things-0.4.0-linux-arm64.deb',
        byteLength: installer.length,
        sha256: createHash('sha256').update(installer).digest('hex'),
      },
    })
  );
  const release = {
    tag_name: 'v0.4.0',
    draft: false,
    prerelease: false,
    assets: [
      'shop-things-update-v1.json',
      'shop-things-update-v1.sig',
      'shop-things-0.4.0-linux-arm64.deb',
    ].map(name => ({
      name,
      browser_download_url: `https://github.com/nsdeschenes/shop-things/releases/download/v0.4.0/${name}`,
    })),
  };
  const fixturePath = join(directory, 'release.json');
  await writeFile(
    fixturePath,
    JSON.stringify({
      publicKey: keys.publicKey.export({format: 'pem', type: 'spki'}),
      manifest: manifest.toString('base64'),
      signature: sign(null, manifest, keys.privateKey).toString('base64'),
      installer: installer.toString('base64'),
      release,
    })
  );
  const executablePath = createRequire(
    new URL('../packages/electron/package.json', import.meta.url)
  )('electron');
  const app = await _electron.launch({
    executablePath,
    args: [fileURLToPath(new URL('./update-entry.mjs', import.meta.url))],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      SHOP_THINGS_ACCEPTANCE_DATA: directory,
      SHOP_THINGS_UPDATE_FIXTURE: fixturePath,
    },
  });
  return {app, directory};
}

test('explicit Update shows streaming progress, keeps customer edits usable, and closes independently', async () => {
  const {app, directory} = await fixture();
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', {name: 'Check for updates'}).click();
    await expect(page.getByRole('button', {name: 'Update', exact: true})).toBeEnabled();
    expect(
      await app.evaluate(() => Reflect.get(globalThis, 'acceptanceUpdateRequests').length)
    ).toBe(0);
    await page.getByRole('button', {name: 'Update', exact: true}).click();
    await expect(
      page.getByRole('progressbar', {name: 'Update download progress'})
    ).toHaveAttribute('value', '0.5');
    const state = await page.evaluate(() =>
      Reflect.get(window, 'shopThings').update.getState({})
    );
    const duplicate = await page.evaluate(
      candidateId => Reflect.get(window, 'shopThings').update.start({candidateId}),
      state.value.candidateId
    );
    expect(duplicate).toMatchObject({status: 'error', error: {code: 'BUSY'}});
    await page.getByRole('button', {name: 'Close', exact: true}).click();
    await page.getByRole('link', {name: 'Add customer'}).click();
    await page.getByRole('textbox', {name: 'First name'}).fill('Retained draft');
    await expect(page.getByRole('textbox', {name: 'First name'})).toBeEnabled();
    await app.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceReleaseUpdateDownload')()
    );
    await page.getByRole('button', {name: 'Check for updates'}).click();
    await expect(page.getByRole('status')).toHaveText(
      'Download verified. Installation is not available yet.'
    );
    await expect(page.getByRole('textbox', {name: 'First name'})).toHaveValue(
      'Retained draft'
    );
    expect(
      await app.evaluate(() => Reflect.get(globalThis, 'acceptanceUpdateRequests').length)
    ).toBe(1);
  } finally {
    await app.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('failed external transport offers only explicit retry and rejects stale attempt IDs', async () => {
  const {app, directory} = await fixture();
  try {
    const page = await app.firstWindow();
    await app.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceUpdateMode', 'failed');
    });
    await page.getByRole('button', {name: 'Check for updates'}).click();
    await page.getByRole('button', {name: 'Update', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Retry', exact: true})).toBeVisible();
    expect(
      await app.evaluate(() => Reflect.get(globalThis, 'acceptanceUpdateRequests').length)
    ).toBe(3);
    const failed = await page.evaluate(() =>
      Reflect.get(window, 'shopThings').update.getState({})
    );
    expect(
      await page.evaluate(() =>
        Reflect.get(window, 'shopThings').update.retry({attemptId: 'stale'})
      )
    ).toMatchObject({error: {code: 'VALIDATION'}});
    await app.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceUpdateMode', 'complete');
    });
    await page.getByRole('button', {name: 'Retry', exact: true}).click();
    await expect(page.getByRole('status')).toHaveText(
      'Download verified. Installation is not available yet.'
    );
    expect(
      await page.evaluate(
        attemptId => Reflect.get(window, 'shopThings').update.retry({attemptId}),
        failed.value.attemptId
      )
    ).toMatchObject({error: {code: 'VALIDATION'}});
    expect(
      await app.evaluate(() => Reflect.get(globalThis, 'acceptanceUpdateRequests').length)
    ).toBe(4);
  } finally {
    await app.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('an in-flight old document cannot start a transfer after renderer replacement', async () => {
  const {app, directory} = await fixture();
  try {
    const page = await app.firstWindow();
    await page.getByRole('button', {name: 'Check for updates'}).click();
    await expect(page.getByRole('button', {name: 'Update', exact: true})).toBeEnabled();
    const state = await page.evaluate(() =>
      Reflect.get(window, 'shopThings').update.getState({})
    );
    await app.evaluate(() => {
      Reflect.set(
        globalThis,
        'acceptanceUpdateIpcGate',
        new Promise<void>(resolve => {
          Reflect.set(globalThis, 'acceptanceReleaseUpdateIpc', resolve);
        })
      );
    });
    const pending = page
      .evaluate(
        candidateId => Reflect.get(window, 'shopThings').update.start({candidateId}),
        state.value.candidateId
      )
      .catch(() => null);
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, 'acceptanceUpdateIpcHeld')))
      .toBe(true);
    await page.reload();
    await app.evaluate(() => {
      Reflect.get(globalThis, 'acceptanceReleaseUpdateIpc')();
      Reflect.set(globalThis, 'acceptanceUpdateIpcGate', null);
    });
    await pending;
    await expect
      .poll(() => app.evaluate(() => Reflect.get(globalThis, 'acceptanceUpdateResults')))
      .toEqual([
        expect.objectContaining({
          status: 'error',
          error: expect.objectContaining({code: 'UNAUTHORIZED'}),
        }),
      ]);
    expect(
      await app.evaluate(() => Reflect.get(globalThis, 'acceptanceUpdateRequests').length)
    ).toBe(0);
  } finally {
    await app.close();
    await rm(directory, {recursive: true, force: true});
  }
});
