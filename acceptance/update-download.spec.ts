import {execFileSync} from 'node:child_process';
import {createHash, generateKeyPairSync, sign} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

import {_electron, expect, test} from '@playwright/test';

async function fixture(guardedInstall = false) {
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
      guardedInstall,
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

test('controlled authentication holds the real guarded draft and restores cancellation, verification and failed reopen', async () => {
  const {app, directory} = await fixture();
  try {
    const page = await app.firstWindow();
    await app.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceUpdateMode', 'complete');
    });
    await page.getByRole('button', {name: 'Check for updates'}).click();
    await page.getByRole('button', {name: 'Update', exact: true}).click();
    await expect(page.getByRole('status')).toHaveText(
      'Download verified. Installation is not available yet.'
    );
    await page.addScriptTag({
      path: fileURLToPath(
        new URL('../acceptance-reports/harness/controlled-editor.mjs', import.meta.url)
      ),
      type: 'module',
    });
    await page.waitForFunction(
      () => Reflect.get(window, 'acceptanceEditorReady') === true
    );
    const draft = page.getByRole('textbox', {name: 'Controlled balance'});
    await draft.fill('-');
    await app.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceHelperDiscard', true);
      Reflect.set(globalThis, 'acceptanceHelperDenied', true);
    });
    // Pending renderer Save must drain before any authentication request.
    await page.evaluate(() => Reflect.get(window, 'acceptanceEditor').beginSave());
    const first = app.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceVerifyUpdateHelper')()
    );
    await expect(draft).toBeDisabled();
    expect(
      await app.evaluate(() => Reflect.get(globalThis, 'acceptanceHelperRequest'))
    ).toBeUndefined();
    await page.evaluate(() => Reflect.get(window, 'acceptanceEditor').finishSave());
    await expect
      .poll(() =>
        app.evaluate(() => Boolean(Reflect.get(globalThis, 'acceptanceReleaseHelper')))
      )
      .toBe(true);
    await expect(draft).toHaveValue('-');
    expect(
      await page.evaluate(async () => {
        const bridge = Reflect.get(window, 'shopThings');
        const state = await bridge.database.status();
        return bridge.customers.list({session: state.value.session, query: ''});
      })
    ).toMatchObject({status: 'error', error: {code: 'BUSY'}});
    await app.evaluate(() => Reflect.get(globalThis, 'acceptanceReleaseHelper')());
    expect(await first).toMatchObject({status: 'success', value: {verified: false}});
    await expect(draft).toBeEnabled();
    await expect(draft).toHaveValue('-');
    await app.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceReleaseHelper', null);
      Reflect.set(globalThis, 'acceptanceHelperDenied', false);
    });
    const second = app.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceVerifyUpdateHelper')()
    );
    await expect
      .poll(() =>
        app.evaluate(() => Boolean(Reflect.get(globalThis, 'acceptanceReleaseHelper')))
      )
      .toBe(true);
    await app.evaluate(() => Reflect.get(globalThis, 'acceptanceReleaseHelper')());
    expect(await second).toMatchObject({status: 'success', value: {verified: true}});
    await expect(draft).toBeEnabled();
    await expect(draft).toHaveValue('-');
    await app.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceReleaseHelper', null);
    });
    const third = app.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceVerifyUpdateHelper')()
    );
    await expect
      .poll(() =>
        app.evaluate(() => Boolean(Reflect.get(globalThis, 'acceptanceReleaseHelper')))
      )
      .toBe(true);
    await app.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceHelperReopenFailure', true);
      Reflect.get(globalThis, 'acceptanceReleaseHelper')();
    });
    expect(await third).toMatchObject({
      status: 'error',
      error: {code: 'DATABASE_UNAVAILABLE'},
    });
    await expect(draft).toHaveValue('-');
    expect(
      await page.evaluate(() => Reflect.get(window, 'shopThings').database.status())
    ).toMatchObject({
      value: {available: false, recoveryError: {code: 'DATABASE_UNAVAILABLE'}},
    });
  } finally {
    await app.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('guarded Update drains and holds customer work, then authentication cancellation restores the draft', async () => {
  const {app, directory} = await fixture(true);
  try {
    const page = await app.firstWindow();
    await page.getByRole('link', {name: 'Add customer'}).click();
    await page
      .getByRole('textbox', {name: 'First name'})
      .fill('Retained installation draft');
    await app.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceHelperDiscard', true);
    });
    await page.getByRole('button', {name: 'Check for updates'}).click();
    await page.getByRole('button', {name: 'Update', exact: true}).click();
    await app.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceReleaseUpdateDownload')()
    );
    await expect(page.getByRole('status')).toHaveText(
      'Approve the system authentication dialog to continue.'
    );
    await expect
      .poll(() =>
        app.evaluate(() => Boolean(Reflect.get(globalThis, 'acceptanceInstallRequest')))
      )
      .toBe(true);
    await expect(page.getByRole('textbox', {name: 'First name'})).toBeDisabled();
    const status = await page.evaluate(() =>
      Reflect.get(window, 'shopThings').database.status()
    );
    expect(
      await page.evaluate(
        session => Reflect.get(window, 'shopThings').customers.list({session, query: ''}),
        status.value.session
      )
    ).toMatchObject({status: 'error', error: {code: 'BUSY'}});
    await app.evaluate(() => Reflect.get(globalThis, 'acceptanceReleaseInstall')());
    await expect(page.getByRole('button', {name: 'Retry', exact: true})).toBeVisible();
    await expect(page.getByRole('textbox', {name: 'First name'})).toBeEnabled();
    await expect(page.getByRole('textbox', {name: 'First name'})).toHaveValue(
      'Retained installation draft'
    );
  } finally {
    await app.close();
    await rm(directory, {recursive: true, force: true});
  }
});

test('uncertain package outcome holds admissions and recovery without automatic retry', async () => {
  const {app, directory} = await fixture(true);
  try {
    const page = await app.firstWindow();
    await page.getByRole('link', {name: 'Add customer'}).click();
    const draft = page.getByRole('textbox', {name: 'First name'});
    await draft.fill('Retained uncertain draft');
    await app.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceHelperDiscard', true);
    });
    await page.getByRole('button', {name: 'Check for updates'}).click();
    await page.getByRole('button', {name: 'Update', exact: true}).click();
    await app.evaluate(() =>
      Reflect.get(globalThis, 'acceptanceReleaseUpdateDownload')()
    );
    await expect
      .poll(() =>
        app.evaluate(() => Boolean(Reflect.get(globalThis, 'acceptanceInstallRequest')))
      )
      .toBe(true);
    await app.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceInstallOutcome', 'uncertain');
      Reflect.get(globalThis, 'acceptanceReleaseInstall')();
    });
    await expect(
      page.getByRole('heading', {name: 'Package Recovery Required'})
    ).toBeVisible();
    await expect(page.getByRole('button', {name: 'Retry', exact: true})).toHaveCount(0);
    expect(
      await page.evaluate(() => Reflect.get(window, 'shopThings').database.retry())
    ).toMatchObject({status: 'error', error: {code: 'BUSY'}});
    expect(
      await app.evaluate(() =>
        Boolean(Reflect.get(globalThis, 'acceptanceInstalledExit'))
      )
    ).toBe(false);
    await expect(draft).toBeDisabled();
    await expect(
      page.getByRole('button', {name: 'Check again', exact: true})
    ).toBeVisible();
    await page.getByRole('button', {name: 'Check again', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Package Recovery Required'})
    ).toBeVisible();
    await expect(draft).toBeDisabled();
    await app.evaluate(() => {
      Reflect.set(globalThis, 'acceptanceAdministratorResolved', true);
      Reflect.set(globalThis, 'acceptanceInstallOutcome', 'unchanged');
    });
    await page.getByRole('button', {name: 'Check again', exact: true}).click();
    await expect(page.getByRole('button', {name: 'Retry', exact: true})).toBeVisible();
    await expect(draft).toBeEnabled();
    await expect(draft).toHaveValue('Retained uncertain draft');
    expect(
      await app.evaluate(() => Reflect.get(globalThis, 'acceptanceInstallInvocations'))
    ).toBe(1);
    expect(
      await app.evaluate(() => Reflect.get(globalThis, 'acceptanceUpdateRequests').length)
    ).toBe(1);
    expect(
      await app.evaluate(() => Reflect.get(globalThis, 'acceptanceSupervisorCancelled'))
    ).toBe(true);
  } finally {
    await app.close();
    await rm(directory, {recursive: true, force: true});
  }
});
