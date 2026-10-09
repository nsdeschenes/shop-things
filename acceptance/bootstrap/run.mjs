// External native ARM64 package/runtime fixture. No installed updater test operation.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {basename, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

import {_electron, expect} from '@playwright/test';

import {
  createCustomer,
  createDatabase,
  listMigrationSnapshots,
} from '../../packages/db/dist/index.js';

const installerName = /^shop-things-.*-linux-arm64\.deb$/;
const root = fileURLToPath(new URL('../..', import.meta.url));
const reportDirectory = resolve(process.argv[2] ?? 'acceptance-reports/bootstrap');
assert.equal(process.platform, 'linux');
assert.equal(process.arch, 'arm64');
assert(process.getuid() !== 0, 'Native Electron must run as the original ordinary user.');
const directory = await mkdtemp(join(tmpdir(), 'shop-things-bootstrap-'));
const report = {
  builtCommit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(),
  architecture: process.arch,
  runner: process.env.RUNNER_NAME ?? 'local',
  image: '',
  containers: [],
  runtime: [],
  limits: [
    'Container package/retention proof and extracted native runtime proof are separate.',
    'User target desktop authentication and disposable VM power loss remain unqualified.',
  ],
};
await mkdir(reportDirectory, {recursive: true});
async function persist() {
  await writeFile(
    join(reportDirectory, 'bootstrap.json'),
    JSON.stringify(report, null, 2)
  );
}

function command(name, args) {
  return execFileSync(name, args, {encoding: 'utf8', maxBuffer: 16 * 1024 * 1024});
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function runtime(executablePath, config, name, protectedQuit = false) {
  const application = await _electron.launch({
    executablePath,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '',
      VITE_DEV_SERVER_URL: '',
      XDG_CONFIG_HOME: config,
    },
  });
  try {
    const page = await application.firstWindow();
    await expect(
      page.getByRole('link', {name: 'Bootstrap retained', exact: true})
    ).toBeVisible();
    const identity = await application.evaluate(({app}) => ({
      name: app.getName(),
      userData: app.getPath('userData'),
      version: app.getVersion(),
      uid: process.getuid(),
    }));
    assert.equal(identity.name, 'electron');
    assert.equal(identity.userData, join(config, 'electron'));
    assert.equal(identity.uid, process.getuid());
    if (protectedQuit) {
      await page.getByRole('link', {name: 'Add customer'}).click();
      const input = page.getByRole('textbox', {name: 'First name', exact: true});
      await input.fill('Unsaved bootstrap draft');
      await application.evaluate(({dialog, BrowserWindow}) => {
        globalThis.bootstrapDialogs = 0;
        dialog.showMessageBox = async () => {
          globalThis.bootstrapDialogs++;
          return {response: 0, checkboxChecked: false};
        };

        BrowserWindow.getAllWindows()[0].close();
      });
      await expect
        .poll(() => application.evaluate(() => globalThis.bootstrapDialogs))
        .toBe(1);
      await expect(input).toHaveValue('Unsaved bootstrap draft');
      await expect(input).toBeEnabled();
      assert.equal(application.windows().length, 1);
      await application.evaluate(({dialog}) => {
        dialog.showMessageBox = async () => ({response: 1, checkboxChecked: false});
      });
    }

    report.runtime.push({
      name,
      identity,
      shutdown: protectedQuit
        ? 'Stay retained draft; approved guarded close'
        : 'normal guarded clean close',
    });
  } finally {
    await application.close();
  }
}

try {
  const candidates = (await readdir(join(root, 'release'))).filter(name =>
    installerName.test(name)
  );
  assert.equal(candidates.length, 1, 'Require one exact tested ARM64 installer.');
  const candidate = join(root, 'release', candidates[0]);
  const legacy = join(directory, 'legacy.deb');
  command('/usr/bin/curl', [
    '--fail',
    '--location',
    '--max-filesize',
    '120000000',
    '--output',
    legacy,
    'https://github.com/nsdeschenes/shop-things/releases/download/v0.3.1/shop-things-0.3.1-linux-arm64.deb',
  ]);
  assert.equal(
    digest(await readFile(legacy)),
    '5cb87baef6c434b22f61f36178674ad3fe99569020a9ab0af28a199f2156bf11'
  );
  report.artifact = {
    candidate: basename(candidate),
    sha256: digest(await readFile(candidate)),
    legacySha256: digest(await readFile(legacy)),
  };
  const oldRoot = join(directory, 'legacy');
  const newRoot = join(directory, 'candidate');
  command('/usr/bin/dpkg-deb', ['--extract', legacy, oldRoot]);
  command('/usr/bin/dpkg-deb', ['--extract', candidate, newRoot]);
  const config = join(directory, 'config');
  const userData = join(config, 'electron');
  await mkdir(userData, {recursive: true});
  const databasePath = join(directory, 'working.sqlite');
  const database = await createDatabase(databasePath, {
    migrationsFolder: join(oldRoot, 'opt/Shop Things/resources/migrations'),
  });
  await createCustomer(database.db, {firstName: 'Bootstrap retained', balance: '12.34'});
  await database.db.run('PRAGMA wal_checkpoint(TRUNCATE)');
  database.close();
  await writeFile(join(userData, 'database.json'), JSON.stringify({path: databasePath}));
  const backupPath = join(userData, 'retained-backup.sqlite');
  await cp(databasePath, backupPath);
  const retained = digest(await readFile(backupPath));
  await runtime(
    join(oldRoot, 'opt/Shop Things/shop-things'),
    config,
    'published legacy before transition',
    true
  );
  const settings = await readFile(join(userData, 'database.json'));
  const before = digest(await readFile(databasePath));
  // Container operations below are isolated. Actual native defaults/data/guard behavior
  // above and below use exact archive bytes; the current protected installed baseline
  // comes from the preceding explicit disposable-runner package installation.
  const context = join(directory, 'context');
  await mkdir(join(context, 'scripts'), {recursive: true});
  await cp(candidate, join(context, 'candidate.deb'));
  await cp(legacy, join(context, 'legacy.deb'));
  await cp(process.execPath, join(context, 'node'));
  for (const name of [
    'verify-bootstrap.ts',
    'workspace.ts',
    'processes.ts',
    'updateRelease.ts',
  ]) {
    await cp(join(root, 'scripts', name), join(context, 'scripts', name));
  }

  await mkdir(join(context, 'packages/electron/src'), {recursive: true});
  await cp(
    join(root, 'packages/electron/src/updateManifest.ts'),
    join(context, 'packages/electron/src/updateManifest.ts')
  );
  await cp(join(root, 'acceptance/bootstrap'), join(context, 'acceptance/bootstrap'), {
    recursive: true,
  });
  command('docker', ['pull', 'ubuntu:24.04']);
  report.image = JSON.parse(
    command('docker', [
      'image',
      'inspect',
      'ubuntu:24.04',
      '--format',
      '{{json .RepoDigests}}',
    ])
  )[0];
  assert(report.image.startsWith('ubuntu@sha256:'));
  report.docker = command('docker', ['version']);
  report.os = await readFile('/etc/os-release', 'utf8');
  const imageName = 'shop-things-bootstrap-' + process.pid;
  command('docker', [
    'build',
    '--build-arg',
    'BASE_IMAGE=' + report.image,
    '-f',
    join(context, 'acceptance/bootstrap/Dockerfile'),
    '-t',
    imageName,
    context,
  ]);
  try {
    for (const scenario of ['fresh', 'legacy', 'unrelated']) {
      const container = 'shop-things-bootstrap-' + process.pid + '-' + scenario;
      try {
        command('docker', [
          'run',
          '--name',
          container,
          '--network',
          'bridge',
          imageName,
          scenario,
        ]);
        await mkdir(join(reportDirectory, scenario), {recursive: true});
        command('docker', [
          'cp',
          container + ':/report/result.json',
          join(reportDirectory, scenario, 'result.json'),
        ]);
        report.containers.push(
          JSON.parse(
            await readFile(join(reportDirectory, scenario, 'result.json'), 'utf8')
          )
        );
      } finally {
        command('docker', ['rm', '-f', container]);
      }
    }
  } finally {
    command('docker', ['image', 'rm', imageName]);
  }

  assert.equal(digest(await readFile(databasePath)), before);
  assert.deepEqual(await readFile(join(userData, 'database.json')), settings);
  assert.equal(digest(await readFile(backupPath)), retained);
  await runtime(
    join(newRoot, 'opt/Shop Things/shop-things'),
    config,
    'bootstrap after transition',
    true
  );
  assert.deepEqual(await readFile(join(userData, 'database.json')), settings);
  assert.equal(digest(await readFile(backupPath)), retained);
  const snapshots = await listMigrationSnapshots(join(userData, 'migration-backups'));
  assert.equal(snapshots.unavailableCount, 0);
  const oldMigrations = await readdir(
    join(oldRoot, 'opt/Shop Things/resources/migrations')
  );
  const newMigrations = await readdir(
    join(newRoot, 'opt/Shop Things/resources/migrations')
  );
  if (newMigrations.length > oldMigrations.length) {
    assert(
      snapshots.snapshots.length > 0,
      'First-open migration requires a retained snapshot.'
    );
  }

  report.migrationSnapshots = snapshots.snapshots.map(snapshot => ({
    snapshotDigest: snapshot.snapshotDigest,
    sourceHistory: snapshot.sourceHistory,
    targetMigrations: snapshot.targetMigrations,
  }));
  for (const path of [databasePath, backupPath, join(userData, 'database.json')]) {
    assert.equal((await stat(path)).uid, process.getuid());
  }

  report.retention = {
    beforeDatabase: before,
    afterDatabase: digest(await readFile(databasePath)),
    retainedBackup: retained,
    selectedPath: databasePath,
  };
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  throw error;
} finally {
  await persist();
  await rm(directory, {recursive: true, force: true});
}
