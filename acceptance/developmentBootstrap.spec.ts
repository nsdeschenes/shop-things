import {mkdtemp, rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

import {_electron, expect, test} from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireInterface = createRequire(
  new URL('../packages/interface/package.json', import.meta.url)
);
const requireElectron = createRequire(
  new URL('../packages/electron/package.json', import.meta.url)
);
const {createServer} = await import(requireInterface.resolve('vite'));

test('cold real Vite development boots the live renderer and retains invalid edits on native Stay', async () => {
  const testInfo = test.info();
  test.setTimeout(45000);
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-vite-'));
  const initialCwd = process.cwd();
  const diagnostics: string[] = [];
  let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  let server: Awaited<ReturnType<typeof createServer>>;
  let passed = false;
  try {
    // Match pnpm dev's interface working directory without spawning another Vite child.
    process.chdir(join(root, 'packages/interface'));
    server = await createServer({
      root: join(root, 'packages/interface'),
      configFile: join(root, 'packages/interface/vite.config.ts'),
      cacheDir: join(directory, 'cold-vite-cache'),
      server: {host: '127.0.0.1', port: 0, strictPort: true},
    });
    expect(server.config.server.hmr).toBe(false);
    expect(server.config.optimizeDeps.holdUntilCrawlEnd).toBe(false);
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === 'string') {
      throw new Error('No ephemeral Vite port');
    }

    const url = `http://127.0.0.1:${address.port}/`;
    diagnostics.push(`Actual Vite ${url}; cold cache ${server.config.cacheDir}`);
    application = await _electron.launch({
      executablePath: requireElectron('electron'),
      args: [join(root, 'acceptance/electron-entry.mjs')],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        SHOP_THINGS_ACCEPTANCE_DATA: directory,
        SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
        VITE_DEV_SERVER_URL: url,
      },
    });
    const page = await application.firstWindow();
    page.on('console', message =>
      diagnostics.push(`console ${message.type()}: ${message.text()}`)
    );
    page.on('pageerror', error => diagnostics.push(`pageerror ${error.stack}`));
    page.on('requestfailed', request =>
      diagnostics.push(`requestfailed ${request.url()}: ${request.failure()?.errorText}`)
    );
    await expect(page.getByRole('link', {name: 'Alpha One'})).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText('Live mode', {exact: false})).toHaveCount(0);
    expect(page.url()).toBe(url + '#/customers');
    await page.getByRole('link', {name: 'Alpha One'}).click();
    await page.getByRole('button', {name: 'Edit customer'}).click();
    const balance = page.getByRole('textbox', {name: 'Balance ($)', exact: true});
    await balance.fill('-');
    const before = page.url();
    await application.evaluate(({BrowserWindow}) =>
      BrowserWindow.getAllWindows()[0].close()
    );
    await expect
      .poll(() =>
        application!.evaluate(
          () =>
            Reflect.get(globalThis, 'acceptanceDialogs').filter(
              (options: {message: string}) =>
                options.message === 'Discard unsaved changes?'
            ).length
        )
      )
      .toBe(1);
    await expect(balance).toBeEnabled();
    await expect(balance).toHaveValue('-');
    expect(page.url()).toBe(before);
    expect(
      await application.evaluate(() => Reflect.get(globalThis, 'acceptanceIpc'))
    ).toEqual(
      expect.arrayContaining([
        'shop-things:document',
        'shop-things:draft-register',
        'shop-things:database.status',
        'shop-things:customers.get',
      ])
    );
    passed = true;
  } finally {
    if (application) {
      await application
        .evaluate(() => Reflect.set(globalThis, 'acceptanceDiscard', true))
        .catch(() => {});
      const closed = await Promise.race([
        application
          .close()
          .then(() => true)
          .catch(() => false),
        delay(3000).then(() => false),
      ]);
      if (!closed) {
        diagnostics.push(
          'Failed probe cleanup: exit only its own Electron child; no protected shutdown proof.'
        );
        await application
          .evaluate(({app}) => app.exit(0))
          .catch(() => application!.process().kill('SIGKILL'));
        passed = false;
      }
    }

    await server?.close();
    process.chdir(initialCwd);
    await testInfo.attach('actual-vite.log', {
      body: diagnostics.join('\n'),
      contentType: 'text/plain',
    });
    await rm(directory, {recursive: true, force: true});
  }

  expect(passed).toBe(true);
});
