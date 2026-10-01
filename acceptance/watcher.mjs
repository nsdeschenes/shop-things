import {spawn, spawnSync} from 'node:child_process';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir} from 'node:fs/promises';
import {mkdtemp, readFile, writeFile, realpath} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {createServer} from 'node:net';
import {release} from 'node:os';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url));
const reportDirectory =
  process.env.ACCEPTANCE_REPORT_DIR ?? join(root, 'acceptance-reports');
await mkdir(reportDirectory, {recursive: true});
const commit = execFileSync('git', ['rev-parse', 'HEAD'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
  cwd: root,
  encoding: 'utf8',
}).trim();
if (dirty) {
  throw new Error('Require clean committed sources before watcher acceptance');
}

const req = createRequire(join(root, 'package.json'));
const {chromium, expect} = req('@playwright/test');
const electron = createRequire(join(root, 'packages/electron/package.json'))('electron');
const directory = await realpath(await mkdtemp(join(tmpdir(), 'shop-things-watcher-')));
const report = {
  schemaVersion: 1,
  status: 'running',
  commit,
  root,
  directory,
  startedAt: new Date().toISOString(),
  environment: {
    platform: process.platform,
    arch: process.arch,
    os: release(),
    node: process.version,
    electron: createRequire(root + '/packages/electron/package.json')(
      'electron/package.json'
    ).version,
  },
  events: [],
  passed: false,
  cleanup: false,
};
const control = join(directory, 'control.json');
await writeFile(control, JSON.stringify({discard: false}));
const isolation = spawnSync(
  electron,
  [join(root, 'acceptance/watcherIsolation.cjs'), '--user-data-dir=' + directory],
  {
    env: {...process.env, ELECTRON_RUN_AS_NODE: '', SHOP_THINGS_EXPECTED_DATA: directory},
    encoding: 'utf8',
    timeout: 10000,
  }
);
console.log(isolation.stdout);
if (isolation.status !== 0) {
  throw new Error('Flag isolation probe failed: ' + isolation.stderr);
}

const {createDatabase, createCustomer, openExistingDatabase, listCustomers} =
  await import(root + '/packages/db/dist/index.js');
const path = join(directory, 'customers.sqlite');
const db = await createDatabase(path, {
  migrationsFolder: root + '/packages/db/migrations',
});
await createCustomer(db.db, {
  firstName: 'Watcher',
  lastName: 'Proof',
  address: '',
  city: '',
  province: '',
  postalCode: '',
  homePhone: '',
  email: '',
  stock: 0,
  balance: '0.00',
  previousBalance: '0.00',
  donate: false,
  comments: '',
});
db.close();
await writeFile(join(directory, 'database.json'), JSON.stringify({path}));
const server = createServer();
await new Promise(done => server.listen(0, '127.0.0.1', done));
const port = server.address().port;
await new Promise(done => server.close(done));
const source = join(root, 'packages/interface/src/main.tsx');
const original = await readFile(source, 'utf8');
const build = join(root, 'packages/electron/dist/main.js');
async function hash() {
  return createHash('sha256')
    .update(await readFile(build))
    .digest('hex');
}

let launcher,
  browser,
  output = '',
  allOutput = '',
  eventLines = '',
  pids = [];
function record(message) {
  report.events.push({at: Date.now(), message});
  console.log(message);
}

async function until(predicate, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) {
      throw new Error('Timeout ' + label + '\n' + output.slice(-2500));
    }

    await delay(100);
  }
}

async function attach() {
  await until(() => output.includes('DevTools listening'), 'debugger');
  browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, {timeout: 10000});
  report.chromium = browser.version();
  const page = browser.contexts()[0].pages()[0];
  page.on('pageerror', e => record('PAGEERROR ' + e.message));
  await expect(page.getByRole('heading', {name: 'Customers', exact: true})).toBeVisible({
    timeout: 15000,
  });
  return page;
}

try {
  launcher = spawn(process.execPath, [join(root, 'acceptance/watcherLauncher.mjs')], {
    cwd: root,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      WATCHER_ROOT: root,
      WATCHER_ENTRY: join(root, 'acceptance/watcherEntry.mjs'),
      WATCHER_MAIN: root + '/packages/electron/dist/main.js',
      WATCHER_DATA: directory,
      WATCHER_CONTROL: control,
      WATCHER_DEBUG_PORT: String(port),
    },
  });
  for (const stream of [launcher.stdout, launcher.stderr]) {
    stream.on('data', chunk => {
      const text = String(chunk);
      output += text;
      allOutput += text;
      process.stdout.write(text);
      eventLines += text;
      const lines = eventLines.split('\n');
      eventLines = lines.pop();
      for (const line of lines) {
        if (line.startsWith('WATCHER_SPAWN ')) {
          const data = JSON.parse(line.slice(14));
          pids.push(data.pid);
          report.events.push({at: Date.now(), spawn: data});
        }

        if (line.startsWith('WATCHER_EXIT ')) {
          report.events.push({at: Date.now(), exit: JSON.parse(line.slice(13))});
        }
      }
    });
  }

  let page = await attach();
  const first = pids[0];
  record('FIRST_PID ' + first);
  expect(report.events.find(entry => entry.spawn)?.spawn.connected).toBe(true);
  await page.getByRole('link', {name: 'Watcher Proof'}).click();
  await page.getByRole('textbox', {name: 'Customer number'}).waitFor();
  await page.getByRole('textbox', {name: 'Balance ($)', exact: true}).fill('-');
  const before = await hash();
  await writeFile(source, original + '\n// watcher supporting probe\n');
  await until(() => output.includes('Restart was not approved'), 'Stay denial', 20000);
  expect(pids).toEqual([first]);
  expect(await hash()).toBe(before);
  await expect(page.getByRole('textbox', {name: 'Balance ($)', exact: true})).toHaveValue(
    '-'
  );
  record('STAY_RETAINS_PID_DRAFT_BUILD');
  const dialogs = output.split('WATCHER_DIALOG').length;
  await delay(1200);
  expect(output.split('WATCHER_DIALOG').length).toBe(dialogs);
  launcher.kill('SIGTERM');
  await until(
    () => output.includes('The application remains open. Type r'),
    'denied parent shutdown',
    20000
  );
  expect(pids).toEqual([first]);
  await expect(page.getByRole('textbox', {name: 'Balance ($)', exact: true})).toHaveValue(
    '-'
  );
  output = '';
  await writeFile(source, original + '\n// watcher resumed polling probe\n');
  await until(
    () => output.includes('Restart was not approved'),
    'resumed source polling',
    20000
  );
  expect(pids).toEqual([first]);
  record('DENIED_PARENT_SHUTDOWN_RESUMES_POLLING');
  await writeFile(control, JSON.stringify({discard: true}));
  await browser.close();
  browser = null;
  output = '';
  launcher.stdin.write('r\n');
  await until(() => pids.length === 2, 'approved replacement');
  page = await attach();
  expect(pids[1]).not.toBe(first);
  expect(report.events.find(entry => entry.exit?.pid === first)?.exit).toEqual({
    pid: first,
    code: 0,
    signal: null,
  });
  record('APPROVED_REPLACEMENT ' + pids[1]);
  await browser.close();
  browser = null;
  output = '';
  await writeFile(source, original + '\nthis is invalid syntax !\n');
  await until(
    () => output.includes('Fix any build errors'),
    'failed prerequisite',
    30000
  );
  expect(pids).toHaveLength(2);
  expect(report.events.find(entry => entry.exit?.pid === pids[1])?.exit).toEqual({
    pid: pids[1],
    code: 0,
    signal: null,
  });
  record('BUILD_FAILURE_NO_REPLACEMENT');
  await writeFile(source, original);
  output = '';
  launcher.stdin.write('r\n');
  await until(() => pids.length === 3, 'fixed build replacement');
  page = await attach();
  record('FIXED_SOURCE_FRESH_REPLACEMENT ' + pids[2]);
  await browser.close();
  browser = null;
  launcher.kill('SIGTERM');
  await until(
    () => launcher.exitCode !== null || launcher.signalCode !== null,
    'graceful parent shutdown',
    20000
  );
  expect(report.events.find(entry => entry.exit?.pid === pids[2])?.exit).toEqual({
    pid: pids[2],
    code: 0,
    signal: null,
  });
  expect(launcher.exitCode).toBe(0);
  record('GRACEFUL_PARENT_SHUTDOWN');
  const reopened = await openExistingDatabase(path, {
    migrationsFolder: root + '/packages/db/migrations',
  });
  const rows = await listCustomers(reopened.db, '');
  expect(rows[0].balance).toBe('0.00');
  reopened.close();
  report.passed = true;
  report.cleanup = true;
} catch (error) {
  record('FAILURE ' + error.stack);
  report.error = error.stack;
} finally {
  await writeFile(source, original);
  await writeFile(control, JSON.stringify({discard: true}));
  if (browser) {
    await browser.close();
  }

  if (launcher && launcher.exitCode === null && launcher.signalCode === null) {
    launcher.kill('SIGTERM');
    try {
      await until(
        () => launcher.exitCode !== null || launcher.signalCode !== null,
        'cleanup',
        15000
      );
      report.cleanup = true;
    } catch {
      report.cleanup = false;
      record('CLEANUP_LIMITATION parent alive; owned PIDs ' + pids.join(','));
    }
  }

  report.finishedAt = new Date().toISOString();
  report.status = report.passed && report.cleanup ? 'passed' : 'failed';
  report.sourceRestored = (await readFile(source, 'utf8')) === original;
  report.cleanAfter =
    execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], {
      cwd: root,
      encoding: 'utf8',
    }).trim() === '';
  if (!report.cleanAfter || !report.sourceRestored) {
    report.status = 'failed';
    report.passed = false;
  }

  await writeFile(join(reportDirectory, 'watcher.json'), JSON.stringify(report, null, 2));
  await writeFile(join(reportDirectory, 'watcher.log'), allOutput);
}

if (report.status !== 'passed') {
  process.exitCode = 1;
}
