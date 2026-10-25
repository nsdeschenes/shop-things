import {glob, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';

import {_electron, expect, test} from '@playwright/test';

import launchElectron from './launchElectron.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const requireInterface = createRequire(
  new URL('../packages/interface/package.json', import.meta.url)
);
const requireElectron = createRequire(
  new URL('../packages/electron/package.json', import.meta.url)
);
const {createServer} = await import(requireInterface.resolve('vite'));

const databaseTabUrl = /#\/settings\/database$/;
const monitoringTabUrl = /#\/settings\/monitoring$/;

test('cold real Vite development boots the live renderer and retains invalid edits on native Stay', () =>
  verifyDevelopmentBoot(false));

test('warm Vite cache from before Settings tabs loads both tabs without React hook errors', () =>
  verifyDevelopmentBoot(true));

test('packaged application omits the developer tools menu command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-packaged-devtools-'));
  const application = await launchElectron(directory, {
    SHOP_THINGS_ACCEPTANCE_PACKAGED: 'true',
    SHOP_THINGS_ACCEPTANCE_RESOURCES: join(root, 'packages/db'),
  });
  try {
    const page = await application.firstWindow();
    await expect(page.getByRole('heading', {name: 'Set Up Your Database'})).toBeVisible();
    expect(
      await application.evaluate(({Menu}) =>
        Menu.getApplicationMenu()!
          .items.find(item => item.label === 'View')!
          .submenu!.items.some(item => item.role?.toLowerCase() === 'toggledevtools')
      )
    ).toBe(false);
  } finally {
    await application.close();
    await rm(directory, {recursive: true, force: true});
  }
});

async function verifyDevelopmentBoot(warm: boolean) {
  const testInfo = test.info();
  test.setTimeout(120000);
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-vite-'));
  const initialCwd = process.cwd();
  const diagnostics: string[] = [];
  let application: Awaited<ReturnType<typeof _electron.launch>> | undefined;
  let server: Awaited<ReturnType<typeof createServer>>;
  let passed = false;
  try {
    // Match pnpm dev's interface working directory without spawning another Vite child.
    process.chdir(join(root, 'packages/interface'));
    const cacheDir = join(directory, 'vite-cache');
    if (warm) {
      const imports = new Set(['react/jsx-runtime', 'react/jsx-dev-runtime']);
      for await (const path of glob('**/*.{ts,tsx}', {
        cwd: join(root, 'packages/interface/src'),
      })) {
        if (path.includes('.test.')) {
          continue;
        }

        const source = await readFile(join(root, 'packages/interface/src', path), 'utf8');
        for (const match of source.matchAll(
          /\b(?:from\s+|import\s*)['"]([^'"\s]+)['"]/g
        )) {
          const name = match[1]!;
          if (
            !name.startsWith('.') &&
            !name.startsWith('@shop-things/') &&
            name !== '@base-ui/react/tabs'
          ) {
            imports.add(name);
          }
        }
      }

      const entry = join(directory, 'before-tabs.ts');
      await symlink(
        join(root, 'packages/interface/node_modules'),
        join(directory, 'node_modules'),
        process.platform === 'win32' ? 'junction' : 'dir'
      );
      await writeFile(
        entry,
        [...imports]
          .sort()
          .map(name => `import '${name}';`)
          .join('\n')
      );
      const seed = await createServer({
        root: join(root, 'packages/interface'),
        configFile: join(root, 'packages/interface/vite.config.ts'),
        cacheDir,
        optimizeDeps: {entries: [entry]},
        server: {host: '127.0.0.1', port: 0, strictPort: true},
      });
      try {
        await seed.listen();
        await expect
          .poll(
            async () => {
              const metadata = JSON.parse(
                await readFile(join(cacheDir, 'deps/_metadata.json'), 'utf8').catch(
                  () => '{}'
                )
              );
              return Boolean(metadata.optimized?.react);
            },
            {timeout: 60000}
          )
          .toBe(true);
      } finally {
        await seed.close();
      }
    }

    server = await createServer({
      root: join(root, 'packages/interface'),
      configFile: join(root, 'packages/interface/vite.config.ts'),
      cacheDir,
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
    diagnostics.push(
      `Actual Vite ${url}; ${warm ? 'warm' : 'cold'} cache ${server.config.cacheDir}`
    );
    application = await _electron.launch({
      executablePath: requireElectron('electron'),
      args: [
        ...(process.env.SHOP_THINGS_ACCEPTANCE_NO_SANDBOX === 'true'
          ? ['--no-sandbox']
          : []),
        join(root, 'acceptance/electron-entry.mjs'),
      ],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        SHOP_THINGS_ACCEPTANCE_DATA: directory,
        SHOP_THINGS_ACCEPTANCE_SEED_CUSTOMERS: 'true',
        VITE_DEV_SERVER_URL: url,
      },
    });
    const page = await application.firstWindow();
    await page.setViewportSize({width: 1440, height: 1100});
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
    if (!warm) {
      for (const opened of [true, false]) {
        await application.evaluate(({BrowserWindow, Menu}) => {
          const window = BrowserWindow.getAllWindows()[0]!;
          const command = Menu.getApplicationMenu()!
            .items.find(item => item.label === 'View')!
            .submenu!.items.find(item => item.role?.toLowerCase() === 'toggledevtools');
          if (!command) {
            throw new Error('The development View menu is missing Developer Tools');
          }

          command.click({}, window, window.webContents);
        });
        await expect
          .poll(() =>
            application!.evaluate(({BrowserWindow}) =>
              BrowserWindow.getAllWindows()[0]!.webContents.isDevToolsOpened()
            )
          )
          .toBe(opened);
      }
    }

    await expect(page.getByText('Live mode', {exact: false})).toHaveCount(0);
    expect(page.url()).toBe(url + '#/customers');
    await expect(page.locator('main')).toHaveCSS('padding-left', '24px');
    await expect(page.locator('main')).toHaveCSS('max-width', '1240px');
    await page.getByRole('link', {name: 'Database settings', exact: true}).click();
    await expect(
      page.getByRole('heading', {name: 'Settings', exact: true})
    ).toBeVisible();
    await expect(page.locator('main')).toHaveCSS('padding-left', '32px');
    await expect(page.locator('main')).toHaveCSS('max-width', '1120px');
    await expect(page.getByRole('tab', {name: 'Database'})).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page).toHaveURL(url + '#/settings/database');
    await expect(page.getByRole('tab', {name: 'Database'})).toHaveAttribute(
      'href',
      databaseTabUrl
    );
    await expect(page.getByRole('tab', {name: 'Monitoring'})).toHaveAttribute(
      'href',
      monitoringTabUrl
    );
    await page.screenshot({
      path: testInfo.outputPath('settings-database.png'),
      fullPage: true,
    });
    await page.getByRole('tab', {name: 'Database'}).focus();
    await page.getByRole('tab', {name: 'Database'}).press('ArrowRight');
    await expect(page.getByRole('tab', {name: 'Monitoring'})).toBeFocused();
    await page.getByRole('tab', {name: 'Monitoring'}).press('Enter');
    await expect(page.getByRole('tab', {name: 'Monitoring'})).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page).toHaveURL(url + '#/settings/monitoring');
    await page.goBack();
    await expect(page.getByRole('tab', {name: 'Database'})).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await page.goForward();
    await expect(page.getByRole('tab', {name: 'Monitoring'})).toHaveAttribute(
      'aria-selected',
      'true'
    );
    await expect(page.getByRole('region', {name: 'Active database'})).toHaveCount(0);
    await expect(page.getByRole('region', {name: 'Monitoring'})).toHaveCSS(
      'padding-left',
      '24px'
    );
    await page.screenshot({
      path: testInfo.outputPath('development-settings.png'),
      fullPage: true,
    });
    await page.getByRole('link', {name: 'Back to customers'}).click();
    await page.getByRole('link', {name: 'Alpha One'}).click();
    await page.getByRole('textbox', {name: 'Customer number', exact: true}).waitFor();
    await expect(page.locator('main')).toHaveCSS('padding-left', '24px');
    await expect(page.locator('main form')).toHaveCSS('padding-left', '22px');
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
    expect(diagnostics.join('\n')).not.toContain(
      "Cannot read properties of null (reading 'useRef')"
    );
    expect(diagnostics.join('\n')).not.toContain('Invalid hook call');
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
}
