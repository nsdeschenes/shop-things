import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  writeFile,
} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join, relative} from 'node:path';
import {fileURLToPath} from 'node:url';

import {_electron, expect} from '@playwright/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const release = join(root, 'release');
const directory =
  process.env.ACCEPTANCE_REPORT_DIR ?? join(root, 'acceptance-reports/package-renderer');
const reportPath = join(directory, 'packaged-renderer.json');
const target = process.env.PACKAGED_RENDERER_TARGET ?? `linux-${process.arch}`;
const supporting = target === 'darwin-arm64-supporting';
const architecture = supporting ? 'arm64' : target.slice('linux-'.length);
const debArchitecture = architecture === 'x64' ? 'amd64' : architecture;
const bundle = supporting
  ? join(release, 'mac-arm64/Shop Things.app/Contents')
  : join(release, architecture === 'x64' ? 'linux-unpacked' : 'linux-arm64-unpacked');
const systemInstall = process.env.PACKAGED_RENDERER_SYSTEM_INSTALL === '1';
if (systemInstall) {
  assert.equal(target, 'linux-arm64');
  assert.notEqual(
    process.getuid(),
    0,
    'Installed Electron must run as the original nonroot user'
  );
}

const unpackedExecutable = join(bundle, supporting ? 'MacOS/Shop Things' : 'shop-things');
const unpackedResources = join(bundle, supporting ? 'Resources' : 'resources');
const executablePath = systemInstall
  ? '/opt/Shop Things/shop-things'
  : unpackedExecutable;
const resources = systemInstall ? '/opt/Shop Things/resources' : unpackedResources;
const archive = join(resources, 'app.asar');
const addon = join(
  resources,
  'app.asar.unpacked/node_modules',
  supporting
    ? '@tursodatabase/database-darwin-arm64/turso.darwin-arm64.node'
    : `@tursodatabase/database-linux-${architecture}-gnu/turso.linux-${architecture}-gnu.node`
);
const report = {
  schemaVersion: 2,
  status: 'running',
  startedAt: new Date().toISOString(),
  target,
  command: process.argv,
  evidence: supporting
    ? 'unsigned macOS arm64 packaged renderer supporting automation'
    : `Linux glibc ${architecture} normal packaged renderer automation`,
  skipped: 0,
  cases: [],
  logs: [],
};
let application;
let page;
let attempt = 0;
let failure;
let userData;
let fixture;
const expectedCases = [
  'isolated-normal-packaged-bootstrap-and-resource-inventory',
  'customer-create-update-and-search-persistence',
  'saved-backup-csv-from-settings',
  'nested-route-guarded-reload-and-native-close-Stay',
  'graceful-close-remembered-reopen-and-customer-delete',
  'independent-saved-database-backup-and-csv-verification',
];
async function persist() {
  await mkdir(directory, {recursive: true});
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
}

function git(args) {
  const result = spawnSync('git', args, {cwd: root, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

async function digest(path) {
  return createHash('sha256')
    .update(await readFile(path))
    .digest('hex');
}

async function filesUnder(folder) {
  const paths = [];
  for (const entry of await readdir(folder, {withFileTypes: true})) {
    const path = join(folder, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await filesUnder(path)));
    } else if (entry.isFile()) {
      paths.push(path);
    }
  }

  return paths.sort((first, second) => first.localeCompare(second));
}

async function passed(name) {
  report.cases.push({name, status: 'passed', finishedAt: new Date().toISOString()});
  await persist();
}

async function launch(readyButton = 'Database settings') {
  const env = {...process.env};
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.VITE_DEV_SERVER_URL;
  application = await _electron.launch({
    executablePath,
    args: [`--user-data-dir=${userData}`],
    env,
    timeout: 30_000,
  });
  attempt++;
  application.on('console', message =>
    report.logs.push({source: 'main', text: message.text()})
  );
  page = await application.firstWindow();
  // This assertion supplements the separately verified BEFORE-ready isolation fixture.
  const runtime = await application.evaluate(({app, BrowserWindow}) => ({
    packaged: app.isPackaged,
    appVersion: app.getVersion(),
    userData: app.getPath('userData'),
    appPath: app.getAppPath(),
    resources: process.resourcesPath,
    versions: process.versions,
    pid: process.pid,
    preferences: BrowserWindow.getAllWindows()[0]?.webContents.getLastWebPreferences(),
  }));
  assert.equal(runtime.packaged, true);
  assert.equal(runtime.userData, userData);
  assert.equal(runtime.appPath, archive);
  assert.equal(runtime.resources, resources);
  assert.equal(runtime.versions.electron, fixture.electron);
  assert.equal(runtime.preferences.contextIsolation, true);
  assert.equal(runtime.preferences.sandbox, true);
  assert.equal(runtime.preferences.nodeIntegration, false);
  report.runtime ??= runtime;
  report.launches ??= [];
  report.launches.push(runtime);
  await application.evaluate(({dialog}) => {
    globalThis.packagedPickers = [];
    globalThis.packagedDialogs = [];
    globalThis.packagedDiscard = false;
    dialog.showSaveDialog = async () => {
      const path = globalThis.packagedPickers.shift();
      return {canceled: !path, filePath: path};
    };

    dialog.showOpenDialog = async () => {
      const path = globalThis.packagedPickers.shift();
      return {canceled: !path, filePaths: path ? [path] : []};
    };

    dialog.showMessageBox = async (...args) => {
      const options = args.at(-1);
      globalThis.packagedDialogs.push(options);
      return {
        response:
          options.message === 'Discard unsaved changes?' && globalThis.packagedDiscard
            ? 1
            : 0,
        checkboxChecked: false,
      };
    };
  });
  page.setDefaultTimeout(15_000);
  page.on('pageerror', error =>
    report.logs.push({source: 'renderer', text: String(error)})
  );
  page.on('console', message =>
    report.logs.push({source: 'renderer-console', text: message.text()})
  );
  await page.context().tracing.start({screenshots: true, snapshots: true});
  await expect(
    page.getByRole(readyButton === 'Database settings' ? 'link' : 'button', {
      name: readyButton,
      exact: true,
    })
  ).toBeEnabled();
  assert.equal(new URL(page.url()).protocol, 'file:');
  assert.equal(
    await page.evaluate(
      () => typeof Reflect.get(window, 'shopThings')?.customers?.create
    ),
    'function'
  );
  assert.equal(
    await page.evaluate(() => typeof Reflect.get(window, 'require')),
    'undefined'
  );
}

async function picker(path) {
  await application.evaluate(
    (_electron, path) => Reflect.get(globalThis, 'packagedPickers').push(path),
    path
  );
}

async function menu(name) {
  await page.getByRole('link', {name: 'Database settings', exact: true}).click();
  await page.getByRole('button', {name, exact: true}).click();
}

async function status() {
  return page.evaluate(() => Reflect.get(window, 'shopThings').database.status());
}

async function closeNormally(discard = false) {
  await application.evaluate(
    (_electron, discard) => Reflect.set(globalThis, 'packagedDiscard', discard),
    discard
  );
  await page.context().tracing.stop();
  const child = application.process();
  await application.close();
  report.closures ??= [];
  report.closures.push({
    pid: child.pid,
    exitCode: child.exitCode,
    signal: child.signalCode,
  });
  assert.equal(child.exitCode, 0, 'Normal packaged app must exit gracefully');
  assert.equal(
    child.signalCode,
    null,
    'Graceful close must not terminate the process by signal'
  );
  application = undefined;
  page = undefined;
}

async function protectedInstalledFile(path) {
  for (let checked = path; ; checked = dirname(checked)) {
    const info = await lstat(checked);
    assert.ok(!info.isSymbolicLink(), 'Installed path must not contain symbolic links');
    assert.equal(info.uid, 0, 'Installed path must be root owned');
    assert.equal(
      info.mode & 0o022,
      0,
      'Installed path must not be writable by ordinary users'
    );
    if (checked === '/') {
      break;
    }
  }

  const info = await lstat(path);
  assert.ok(info.isFile(), 'Installed resource must be a regular file');
  return {uid: info.uid, mode: info.mode & 0o777};
}

async function inventory() {
  const expected = [];
  for (const [folder, destination] of [
    ['electron', 'dist'],
    ['db', 'node_modules/@shop-things/db/dist'],
    ['contract', 'node_modules/@shop-things/contract/dist'],
  ]) {
    const emitted = join(root, 'packages', folder, 'dist');
    for (const path of await filesUnder(emitted)) {
      if (path.endsWith('.d.ts')) {
        continue;
      }

      expected.push({
        path: join(destination, relative(emitted, path)),
        sha256: await digest(path),
      });
    }
  }

  const actual = await application.evaluate(async ({app}, expected) => {
    const fs = process.getBuiltinModule('node:fs/promises');
    const path = process.getBuiltinModule('node:path');
    const crypto = process.getBuiltinModule('node:crypto');
    const archive = app.getAppPath();
    const files = [];
    for (const entry of expected) {
      files.push({
        path: entry.path,
        sha256: crypto
          .createHash('sha256')
          .update(await fs.readFile(path.join(archive, entry.path)))
          .digest('hex'),
      });
    }

    return files;
  }, expected);
  assert.deepEqual(
    actual,
    expected,
    'Every emitted main/preload/renderer/backend file must match packaged bytes'
  );
  assert.ok(actual.some(entry => entry.path === 'dist/renderer/index.html'));
  assert.ok(actual.some(entry => entry.path.startsWith('dist/renderer/assets/')));
  report.buildInventory = {commit: report.commit, files: actual};
  report.migrations = [];
  const sourceMigrations = join(root, 'packages/db/migrations');
  const packagedMigrations = join(resources, 'migrations');
  const sourceFiles = await filesUnder(sourceMigrations);
  const shippedFiles = await filesUnder(packagedMigrations);
  assert.deepEqual(
    shippedFiles.map(path => relative(packagedMigrations, path)),
    sourceFiles.map(path => relative(sourceMigrations, path))
  );
  for (const path of sourceFiles) {
    const shipped = join(packagedMigrations, relative(sourceMigrations, path));
    assert.equal(await digest(shipped), await digest(path));
    report.migrations.push({
      path: relative(resources, shipped),
      sha256: await digest(shipped),
    });
  }

  if (systemInstall) {
    report.installedSystem = {uid: process.getuid(), files: [], identity: null};
    for (const path of [executablePath, archive, addon, ...shippedFiles]) {
      const ownership = await protectedInstalledFile(path);
      const unpacked =
        path === executablePath
          ? unpackedExecutable
          : join(unpackedResources, relative(resources, path));
      assert.equal(
        await digest(path),
        await digest(unpacked),
        'Installed bytes must match accepted unpacked artifact'
      );
      report.installedSystem.files.push({path, sha256: await digest(path), ...ownership});
    }

    const identity = '/usr/lib/shop-things/update/identity.json';
    const identityOwnership = await protectedInstalledFile(identity);
    const installedIdentity = JSON.parse(await readFile(identity, 'utf8'));
    assert.deepEqual(
      installedIdentity,
      JSON.parse(await readFile(join(resources, 'update/identity.json'), 'utf8'))
    );
    report.installedSystem.identity = {
      path: identity,
      sha256: await digest(identity),
      value: installedIdentity,
      ...identityOwnership,
    };
  }

  const artifacts = [
    unpackedExecutable,
    join(unpackedResources, 'app.asar'),
    systemInstall ? join(unpackedResources, relative(resources, addon)) : addon,
  ];
  if (!supporting) {
    const installers = (await readdir(release)).filter(name =>
      name.endsWith(`_${debArchitecture}.deb`)
    );
    assert.equal(installers.length, 1, `One Linux ${architecture} installer required`);
    artifacts.push(join(release, installers[0]));
    if (systemInstall) {
      const expectedPackage = spawnSync(
        '/usr/bin/dpkg-deb',
        ['--field', join(release, installers[0]), 'Package', 'Version', 'Architecture'],
        {encoding: 'utf8'}
      );
      assert.equal(expectedPackage.status, 0, expectedPackage.stderr);
      const installedPackage = spawnSync(
        '/usr/bin/dpkg-query',
        [
          '-W',
          '-f=Package: ${Package}\nVersion: ${Version}\nArchitecture: ${Architecture}\n',
          'shop-things',
        ],
        {encoding: 'utf8'}
      );
      assert.equal(installedPackage.status, 0, installedPackage.stderr);
      assert.equal(
        installedPackage.stdout,
        expectedPackage.stdout,
        'Installed package identity must match accepted installer'
      );
      report.installedSystem.package = installedPackage.stdout;
    }
  }

  report.artifacts = await Promise.all(
    artifacts.map(async path => ({
      path: relative(release, path),
      sha256: await digest(path),
    }))
  );
}

await persist();
try {
  report.commit = git(['rev-parse', 'HEAD']);
  report.dirtyCheckout = git(['status', '--porcelain', '--untracked-files=all']) !== '';
  assert.equal(
    report.dirtyCheckout,
    false,
    'Packaged acceptance requires clean committed sources'
  );
  assert.ok(
    target === 'linux-x64' || target === 'linux-arm64' || supporting,
    `Unsupported packaged target ${target}`
  );
  assert.equal(process.platform, supporting ? 'darwin' : 'linux');
  assert.equal(process.arch, architecture);
  report.executionEnvironment = {
    platform: process.platform,
    arch: process.arch,
    node: process.versions.node,
    release: process.getBuiltinModule('node:os').release(),
    glibc: process.report.getReport().header.glibcVersionRuntime,
  };
  if (!supporting) {
    async function readSecurity(path) {
      return (await readFile(path, 'utf8').catch(() => 'unavailable')).trim();
    }

    report.securityTopology = {
      apparmorRestriction: await readSecurity(
        '/proc/sys/kernel/apparmor_restrict_unprivileged_userns'
      ),
      userNamespaces: await readSecurity('/proc/sys/user/max_user_namespaces'),
      apparmorEnabled: await readSecurity('/sys/module/apparmor/parameters/enabled'),
      initialRunnerApparmorRestriction:
        process.env.ACCEPTANCE_INITIAL_APPARMOR_RESTRICTION ?? 'unrecorded',
      topology: systemInstall
        ? 'installed executable at recorded original runner restriction; Xvfb supporting CI proof'
        : 'unpacked supporting test topology; factory desktop proof pending',
    };
    if (systemInstall) {
      assert.equal(
        report.securityTopology.apparmorRestriction,
        process.env.ACCEPTANCE_INITIAL_APPARMOR_RESTRICTION
      );
    }
  }

  if (!supporting) {
    assert.ok(report.executionEnvironment.glibc, 'Linux glibc required');
  }

  userData = await realpath(
    await mkdtemp(join(tmpdir(), 'shop-things-packaged-renderer-'))
  );
  report.userData = userData;
  const localElectron = createRequire(join(root, 'packages/electron/package.json'))(
    'electron'
  );
  const isolation = spawnSync(
    localElectron,
    [join(root, 'acceptance/packagedIsolation.cjs'), `--user-data-dir=${userData}`],
    {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        VITE_DEV_SERVER_URL: '',
        SHOP_THINGS_ISOLATION_EXPECTED: userData,
      },
    }
  );
  report.isolation = {
    exitCode: isolation.status,
    signal: isolation.signal,
    error: isolation.error?.message,
    stdout: isolation.stdout,
    stderr: isolation.stderr,
  };
  assert.equal(
    isolation.status,
    0,
    `Standard flag isolation must be verified before production launch: ${isolation.stderr}`
  );
  fixture = JSON.parse(isolation.stdout.trim());
  assert.equal(fixture.beforeReady, userData);
  assert.equal(fixture.ready, userData);
  await launch('Create database');
  await inventory();
  await passed(expectedCases[0]);
  const working = join(userData, 'working.sqlite');
  const backup = join(userData, 'backup.sqlite');
  const csv = join(userData, 'all.csv');
  await expect(page.getByRole('heading', {name: 'Set Up Your Database'})).toBeVisible();
  await picker(working);
  await page.getByRole('button', {name: 'Create database', exact: true}).click();
  await expect(page.getByText('working.sqlite', {exact: true})).toBeVisible();
  await page.getByRole('link', {name: 'Add customer', exact: true}).click();
  await page.getByRole('textbox', {name: 'First name', exact: true}).fill('Packaged');
  await page.getByRole('textbox', {name: 'Last name', exact: true}).fill('Saved');
  await page.getByRole('textbox', {name: 'Balance ($)', exact: true}).fill('-12.30');
  await page
    .getByRole('textbox', {name: 'Comments', exact: true})
    .fill('Saved, "quoted"\nsecond line');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Customers', exact: true})).toBeVisible();
  await page.getByRole('link', {name: 'Packaged Saved', exact: true}).click();
  await expect(
    page.getByRole('heading', {name: 'Packaged Saved', exact: true})
  ).toBeVisible();
  await page.getByRole('textbox', {name: 'Customer number'}).waitFor();
  await page.getByRole('textbox', {name: 'City', exact: true}).fill('Saved city');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await page.getByRole('link', {name: 'Packaged Saved', exact: true}).click();
  await expect(page.getByRole('textbox', {name: 'City', exact: true})).toHaveValue(
    'Saved city'
  );
  await page.getByRole('link', {name: 'Back to customers', exact: true}).click();
  await page.getByRole('link', {name: 'Add customer', exact: true}).click();
  await page.getByRole('textbox', {name: 'First name', exact: true}).fill('Other');
  await page.getByRole('textbox', {name: 'Last name', exact: true}).fill('Saved');
  await page.getByRole('button', {name: 'Save', exact: true}).click();
  await expect(page.getByRole('heading', {name: 'Customers', exact: true})).toBeVisible();
  await page.getByRole('link', {name: 'Other Saved', exact: true}).click();
  await expect(
    page.getByRole('heading', {name: 'Other Saved', exact: true})
  ).toBeVisible();
  await page.getByRole('link', {name: 'Back to customers', exact: true}).click();
  await page
    .getByRole('textbox', {name: 'Search customers', exact: true})
    .fill('Packaged');
  await expect(page.getByText('1 result', {exact: true})).toBeVisible();
  await page.getByRole('link', {name: 'Packaged Saved', exact: true}).click();
  await expect(page).toHaveURL(/#\/customers\/1$/);
  await passed(expectedCases[1]);
  await page.getByRole('textbox', {name: 'Customer number'}).waitFor();
  await page.getByRole('link', {name: 'Database settings'}).click();
  const settingsRoute = page.url();
  const before = await status();
  for (const [name, path, message] of [
    ['Back up database', backup, 'Backup saved.'],
    ['Export all customers', csv, 'Customers exported.'],
  ]) {
    await picker(path);
    await menu(name);
    await expect(page.getByText(`${message} ${path}`, {exact: true})).toBeVisible();
    await expect(page.getByRole('heading', {name: 'Database Settings'})).toBeVisible();
    assert.equal(page.url(), settingsRoute);
    assert.deepEqual(await status(), before);
  }

  assert.equal(
    await application.evaluate(() => Reflect.get(globalThis, 'packagedDialogs').length),
    0
  );
  await passed(expectedCases[2]);
  await page.getByRole('link', {name: 'Shop Things'}).click();
  await page.getByRole('link', {name: 'Packaged Saved', exact: true}).click();
  await page.getByRole('textbox', {name: 'Customer number'}).waitFor();
  await page.getByRole('textbox', {name: 'Balance ($)', exact: true}).fill('-');
  const route = page.url();
  await application.evaluate(({Menu}) =>
    Menu.getApplicationMenu()
      .items.find(item => item.label === 'View')
      .submenu.items.find(item => item.label === 'Reload')
      .click()
  );
  await expect
    .poll(() =>
      application.evaluate(() => Reflect.get(globalThis, 'packagedDialogs').length)
    )
    .toBe(1);
  await expect(page.getByRole('textbox', {name: 'Balance ($)', exact: true})).toHaveValue(
    '-'
  );
  assert.equal(page.url(), route);
  await application.evaluate(({BrowserWindow}) =>
    BrowserWindow.getAllWindows()[0].close()
  );
  await expect
    .poll(() =>
      application.evaluate(() => Reflect.get(globalThis, 'packagedDialogs').length)
    )
    .toBe(2);
  await expect(page.getByRole('textbox', {name: 'Balance ($)', exact: true})).toHaveValue(
    '-'
  );
  assert.equal(
    await application.evaluate(({BrowserWindow}) => BrowserWindow.getAllWindows().length),
    1
  );
  const protections = await application.evaluate(() =>
    Reflect.get(globalThis, 'packagedDialogs')
  );
  assert.ok(
    protections.every(options => options.defaultId === 0 && options.cancelId === 0)
  );
  report.protectionDialogs = protections;
  await application.evaluate(() => Reflect.set(globalThis, 'packagedDiscard', true));
  const navigated = page.waitForEvent('load');
  await application.evaluate(({Menu}) =>
    Menu.getApplicationMenu()
      .items.find(item => item.label === 'View')
      .submenu.items.find(item => item.label === 'Reload')
      .click()
  );
  await navigated;
  await expect(
    page.getByRole('heading', {name: 'Packaged Saved', exact: true})
  ).toBeVisible();
  assert.equal(page.url(), route);
  await expect(page.getByRole('button', {name: 'Save', exact: true})).toBeVisible();
  assert.deepEqual(
    await status(),
    before,
    'Guarded reload must keep the database session'
  );
  await passed(expectedCases[3]);
  await closeNormally();
  await launch();
  await expect(
    page.getByRole('link', {name: 'Packaged Saved', exact: true})
  ).toBeVisible();
  const reopened = await status();
  assert.equal(reopened.value.selectedPath, working);
  assert.notEqual(reopened.value.session, before.value.session);
  await page.getByRole('link', {name: 'Packaged Saved', exact: true}).click();
  await expect(page.getByRole('textbox', {name: 'City', exact: true})).toHaveValue(
    'Saved city'
  );
  await page.getByRole('button', {name: 'Delete customer', exact: true}).click();
  const deletion = page.getByRole('dialog', {name: 'Delete Customer?', exact: true});
  await expect(deletion.getByRole('button', {name: 'Cancel', exact: true})).toBeFocused();
  await deletion.getByRole('button', {name: 'Delete customer', exact: true}).click();
  await expect(page.getByText('Customer deleted.', {exact: true})).toBeVisible();
  await expect(page.getByText('1 result', {exact: true})).toBeVisible();
  await closeNormally();
  await passed(expectedCases[4]);
  const {listCustomers, openExistingDatabase} =
    await import('../packages/db/dist/index.js');
  async function inspect(path) {
    const handle = await openExistingDatabase(path, {
      migrationsFolder: join(root, 'packages/db/migrations'),
    });
    try {
      return await listCustomers(handle.db);
    } finally {
      handle.close();
    }
  }

  assert.equal((await inspect(working)).length, 1);
  assert.equal((await inspect(working))[0].firstName, 'Other');
  const saved = await inspect(backup);
  assert.equal(saved.length, 2);
  const savedCustomer = saved.find(row => row.firstName === 'Packaged');
  assert.equal(savedCustomer.balance, '-12.30');
  assert.equal(savedCustomer.city, 'Saved city');
  const text = await readFile(csv, 'utf8');
  assert.ok(text.includes('"-12.30"'));
  assert.ok(text.includes('"Other"'));
  assert.ok(text.includes('"Saved, ""quoted""\nsecond line"'));
  assert.deepEqual(JSON.parse(await readFile(join(userData, 'database.json'), 'utf8')), {
    path: working,
  });
  report.outputs = await Promise.all(
    [working, backup, csv].map(async path => ({path, sha256: await digest(path)}))
  );
  await passed(expectedCases[5]);
  assert.deepEqual(
    report.cases.map(result => result.name),
    expectedCases
  );
  assert.equal(
    report.logs.filter(entry => entry.source === 'renderer').length,
    0,
    'No renderer page errors permitted'
  );
  assert.equal(
    git(['status', '--porcelain', '--untracked-files=all']),
    '',
    'Sources must remain clean through package execution'
  );
  report.status = 'passed';
} catch (error) {
  failure = error;
  report.status = 'failed';
  report.error = {message: String(error?.message ?? error), stack: error?.stack};
  if (page) {
    await page
      .screenshot({path: join(directory, 'packaged-renderer-failure.png')})
      .catch(() => {});
    await page
      .context()
      .tracing.stop({path: join(directory, `packaged-renderer-${attempt}-failure.zip`)})
      .catch(() => {});
  }
} finally {
  if (application) {
    // Failed probes may stop their own child, but forced cleanup never certifies protection.
    report.cleanup = 'failed-probe test-owned forced exit';
    await application.evaluate(({app}) => app.exit(0)).catch(() => {});
  } else {
    report.cleanup = 'normal protected close completed';
  }

  report.finishedAt = new Date().toISOString();
  await persist();
  await writeFile(
    join(directory, 'packaged-renderer-console.json'),
    JSON.stringify(report.logs, null, 2) + '\n'
  );
  console.log(JSON.stringify(report, null, 2));
}

if (failure) {
  throw failure;
}
