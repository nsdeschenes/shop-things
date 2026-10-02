// Automated phases are sequential: source checks and builds replace emitted resources.
import assert from 'node:assert/strict';
import {spawn, spawnSync} from 'node:child_process';
import {cp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {release} from 'node:os';
import {join, resolve} from 'node:path';

const directory = resolve(process.env.ACCEPTANCE_REPORT_DIR ?? 'acceptance-reports');
await mkdir(directory, {recursive: true});
function git(args: string[]) {
  const result = spawnSync('git', args, {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const supporting = process.argv.includes('--supporting-macos');
const reuseSourceChecks = process.argv.includes('--reuse-source-checks');
const glibc = Reflect.get(
  Reflect.get(process.report.getReport(), 'header'),
  'glibcVersionRuntime'
);
const report: Record<string, unknown> = {
  schemaVersion: 3,
  status: 'running',
  startedAt: new Date().toISOString(),
  environment: {
    platform: process.platform,
    architecture: process.arch,
    os: release(),
    node: process.version,
    glibc: glibc ?? null,
    target: supporting ? 'darwin-arm64-supporting-unsigned' : 'linux-x64-glibc',
  },
  steps: [],
};
const steps: {
  name: string;
  status: string;
  command: string[];
  startedAt: string;
  finishedAt?: string;
  exitCode?: number | null;
  signal?: string | null;
  error?: string;
}[] = [];
report.steps = steps;
function persist() {
  return writeFile(
    join(directory, 'acceptance.json'),
    JSON.stringify(report, null, 2) + '\n'
  );
}

await persist();
async function command(
  name: string,
  executable: string,
  args: string[],
  extra: NodeJS.ProcessEnv = {}
) {
  const step = {
    name,
    status: 'running',
    command: [executable, ...args],
    startedAt: new Date().toISOString(),
  } as (typeof steps)[number];
  steps.push(step);
  await persist();
  let output = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable, args, {
        env: {
          ...process.env,
          ACCEPTANCE_REPORT_DIR: directory,
          SMOKE_REPORT_PATH: join(directory, 'package-smoke.json'),
          CSC_IDENTITY_AUTO_DISCOVERY: 'false',
          ...extra,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      for (const stream of [child.stdout, child.stderr]) {
        stream.on('data', chunk => {
          output += chunk;
          process.stdout.write(chunk);
        });
      }

      child.once('error', reject);
      child.once('close', (code, signal) => {
        step.exitCode = code;
        step.signal = signal;
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`${name} failed: ${signal ?? code}`));
        }
      });
    });
    step.status = 'passed';
  } catch (error) {
    step.status = 'failed';
    step.error = String(error);
    throw error;
  } finally {
    step.finishedAt = new Date().toISOString();
    await writeFile(join(directory, name + '.log'), output);
    await persist();
  }
}

async function successfulReport(name: string) {
  const result = JSON.parse(await readFile(join(directory, name), 'utf8'));
  assert.equal(result.status, 'passed', `${name} must pass`);
  assert.equal(result.commit, report.commit, `${name} must use this commit`);
  return result;
}

try {
  report.commit = git(['rev-parse', 'HEAD']);
  assert.equal(
    git(['status', '--porcelain', '--untracked-files=all']),
    '',
    'Require clean committed sources'
  );
  assert.ok(
    Number(process.versions.node.split('.')[0]) >= 26,
    'Node 26 or later required'
  );
  if (supporting) {
    assert.equal(process.platform, 'darwin');
    assert.equal(process.arch, 'arm64');
  } else {
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, 'x64');
    assert.ok(glibc, 'glibc required');
  }

  report.cleanBefore = true;
  if (reuseSourceChecks) {
    const sourceCommit = (
      await readFile(join(directory, 'source-checks.commit'), 'utf8')
    ).trim();
    assert.equal(sourceCommit, report.commit, 'Source checks must use this commit');
    report.sourceChecks = {
      origin: 'prior-workflow-steps',
      commit: sourceCommit,
      commands: [
        'pnpm fmt:check',
        'pnpm lint',
        'pnpm typecheck',
        'pnpm test --packages-only',
      ],
    };
  }

  const pnpmVersion = spawnSync('pnpm', ['--version'], {encoding: 'utf8'});
  assert.equal(pnpmVersion.status, 0, String(pnpmVersion.error ?? pnpmVersion.stderr));
  report.pnpm = pnpmVersion.stdout.trim();
  report.osDistribution =
    process.platform === 'linux'
      ? await readFile('/etc/os-release', 'utf8')
      : spawnSync('sw_vers', [], {encoding: 'utf8'}).stdout.trim();
  if (!reuseSourceChecks) {
    await command('install', 'pnpm', ['install', '--frozen-lockfile']);
    await command('electron-runtime', 'pnpm', [
      '--filter',
      'electron',
      'exec',
      'node',
      '-e',
      'require("electron/install.js")',
    ]);
    await command('source-tests', 'pnpm', ['test', '--packages-only']);
  }

  const source: Record<string, unknown> = {};
  for (const suite of ['contract', 'db', 'electron', 'interface']) {
    const results = JSON.parse(
      await readFile(join(directory, suite + '-tests.json'), 'utf8')
    );
    assert.equal(results.success, true);
    assert.ok(results.numTotalTests > 0);
    assert.equal(results.numPendingTests, 0);
    assert.equal(results.numTodoTests ?? 0, 0);
    assert.equal(results.numFailedTests, 0);
    assert.equal(
      results.numPassedTests,
      results.numTotalTests,
      `No skipped ${suite} checks`
    );
    source[suite] = {
      passed: results.numPassedTests,
      total: results.numTotalTests,
      skipped: 0,
    };
  }

  report.sourceTests = source;
  await command('chromium-runtime', 'pnpm', [
    'exec',
    'playwright',
    'install',
    'chromium',
  ]);
  const {chromium} = await import('@playwright/test');
  const browser = await chromium.launch();
  report.chromium = browser.version();
  await browser.close();
  await command('build', 'pnpm', ['build']);
  try {
    await command('renderer', 'pnpm', ['test:renderer']);
  } finally {
    await cp('acceptance-reports/renderer', join(directory, 'renderer-artifacts'), {
      recursive: true,
      force: true,
    }).catch(error => {
      report.rendererArtifactError = String(error);
    });
  }

  const renderer = JSON.parse(
    await readFile('acceptance-reports/renderer/results.json', 'utf8')
  );
  assert.ok(renderer.stats.expected > 0);
  for (const field of ['unexpected', 'skipped', 'flaky']) {
    assert.equal(renderer.stats[field], 0, `Renderer ${field} checks must be zero`);
  }

  await writeFile(
    join(directory, 'renderer-results.json'),
    JSON.stringify(renderer, null, 2)
  );
  report.renderer = {
    kind: 'built-test-entry-Electron-and-Chromium',
    stats: renderer.stats,
    results: 'renderer-results.json',
  };
  await command('package', 'pnpm', [
    '--filter',
    'electron',
    'exec',
    'electron-builder',
    ...(supporting
      ? ['--mac', 'dir', '--arm64', '-c.mac.identity=null']
      : ['--linux', 'deb', '--x64']),
    '--publish',
    'never',
  ]);
  if (supporting) {
    report.shippedBackend = {
      applicable: false,
      target: 'linux-x64-glibc',
      reason: 'The shipped backend smoke requires the Linux release artifact',
    };
  } else {
    await command('shipped-backend-node', 'pnpm', ['--filter', 'electron', 'test:smoke']);
    report.shippedBackend = await successfulReport('package-smoke.json');
  }

  await command(
    'packaged-renderer',
    process.execPath,
    ['acceptance/packagedRenderer.mjs'],
    {PACKAGED_RENDERER_TARGET: supporting ? 'darwin-arm64-supporting' : 'linux-x64'}
  );
  report.packagedRenderer = await successfulReport('packaged-renderer.json');
  await command('development-watcher', process.execPath, ['acceptance/watcher.mjs']);
  report.developmentWatcher = await successfulReport('watcher.json');
  assert.equal(
    git(['status', '--porcelain', '--untracked-files=all']),
    '',
    'Acceptance must restore all source bytes'
  );
  assert.equal(git(['rev-parse', 'HEAD']), report.commit);
  report.cleanAfter = true;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.error =
    error instanceof Error ? {message: error.message, stack: error.stack} : String(error);
  process.exitCode = 1;
} finally {
  report.finishedAt = new Date().toISOString();
  await persist();
}
