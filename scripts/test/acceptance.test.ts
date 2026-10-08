import {execFileSync, spawnSync} from 'node:child_process';
import {chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {afterEach, beforeEach, expect, test} from 'vitest';

import {root} from '../workspace.ts';

const fixture = join(root, 'scripts/test/fixtures/acceptance-command.mjs');
const commands = [
  'install',
  'electron-runtime',
  'source-tests',
  'chromium-runtime',
  'build',
  'renderer',
  'package',
  ...(process.platform === 'darwin' ? [] : ['shipped-backend-node']),
  'packaged-renderer',
  'development-watcher',
];

const expectedTarget =
  process.platform === 'darwin'
    ? 'darwin-arm64-supporting-unsigned'
    : `linux-${process.arch}-glibc`;
let directory: string;
let reports: string;

function git(args: string[]) {
  return execFileSync('git', args, {cwd: directory, encoding: 'utf8'}).trim();
}

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'shop-things-acceptance-command-'));
  reports = join(directory, 'acceptance-reports');
  await mkdir(join(directory, 'scripts'), {recursive: true});
  await mkdir(join(directory, 'acceptance'));
  await mkdir(join(directory, 'bin'));
  await cp(join(root, 'scripts/acceptance.ts'), join(directory, 'scripts/acceptance.ts'));
  for (const name of ['packagedRenderer.mjs', 'watcher.mjs']) {
    await cp(fixture, join(directory, 'acceptance', name));
  }

  await writeFile(
    join(directory, 'bin/pnpm'),
    '#!/usr/bin/env node\n' + (await readFile(fixture, 'utf8'))
  );
  await chmod(join(directory, 'bin/pnpm'), 0o755);
  await writeFile(join(directory, 'package.json'), '{"type":"module"}');
  await writeFile(join(directory, '.gitignore'), 'node_modules\nacceptance-reports\n');
  // Chromium launch is an external boundary; no application coverage is simulated here.
  const playwright = join(directory, 'node_modules/@playwright/test');
  await mkdir(playwright, {recursive: true});
  await writeFile(
    join(playwright, 'package.json'),
    '{"type":"module","exports":"./index.js"}'
  );
  await writeFile(
    join(playwright, 'index.js'),
    'export const chromium = {launch: async () => ({version: () => "fixture", close: async () => {}})};'
  );
  git(['init', '-b', 'nd/test-acceptance']);
  git(['config', 'user.name', 'Acceptance fixture']);
  git(['config', 'user.email', 'noreply@example.com']);
  git(['config', 'core.hooksPath', '/dev/null']);
  git(['config', 'commit.gpgsign', 'false']);
});

afterEach(async () => {
  await rm(directory, {recursive: true, force: true});
});

async function runScenario(scenario: string) {
  if (scenario !== 'missing revision') {
    git(['add', '.']);
    git([
      'commit',
      '-m',
      'test: Initialize acceptance fixture',
      '-m',
      'Co-Authored-By: Codex <noreply@openai.com>',
    ]);
  }

  const reuseRendererChecks =
    scenario.includes('renderer checks') || scenario.includes('watcher checks');
  const reuseSourceChecks =
    reuseRendererChecks ||
    [
      'reused checks',
      'stale source checks',
      'missing source checks',
      'skipped source test',
    ].includes(scenario);
  if (reuseSourceChecks && scenario !== 'missing source checks') {
    execFileSync(process.execPath, [fixture, 'test'], {
      encoding: 'utf8',
      env: {...process.env, ACCEPTANCE_REPORT_DIR: reports},
    });
    await writeFile(
      join(reports, 'source-checks.commit'),
      scenario === 'stale source checks' ? 'another-commit' : git(['rev-parse', 'HEAD'])
    );
    if (scenario === 'skipped source test') {
      const path = join(reports, 'contract-tests.json');
      const sourceReport = JSON.parse(await readFile(path, 'utf8'));
      sourceReport.numPendingTests = 1;
      await writeFile(path, JSON.stringify(sourceReport));
    }
  }

  if (reuseRendererChecks) {
    execFileSync(process.execPath, [fixture, 'test:renderer'], {
      cwd: directory,
      encoding: 'utf8',
      env: {...process.env, ACCEPTANCE_REPORT_DIR: reports},
    });
    await cp(join(reports, 'renderer'), join(reports, 'renderer-artifacts'), {
      recursive: true,
    });
    await cp(
      join(reports, 'renderer/results.json'),
      join(reports, 'renderer-results.json')
    );
    if (scenario !== 'missing renderer checks') {
      await writeFile(
        join(reports, 'renderer-checks.commit'),
        scenario === 'stale renderer checks'
          ? 'another-commit'
          : git(['rev-parse', 'HEAD'])
      );
    }

    await writeFile(
      join(reports, 'watcher.json'),
      JSON.stringify({
        status: scenario === 'failed watcher checks' ? 'failed' : 'passed',
        commit:
          scenario === 'stale watcher checks'
            ? 'another-commit'
            : git(['rev-parse', 'HEAD']),
      })
    );
    if (scenario === 'flaky renderer checks') {
      await writeFile(
        join(reports, 'renderer-results.json'),
        JSON.stringify({stats: {expected: 1, unexpected: 0, skipped: 0, flaky: 1}})
      );
    }
  }

  const result = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      'scripts/acceptance.ts',
      ...(process.platform === 'darwin' ? ['--supporting-macos'] : []),
      ...(reuseSourceChecks ? ['--reuse-source-checks'] : []),
      ...(reuseRendererChecks ? ['--reuse-renderer-checks'] : []),
    ],
    {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        ACCEPTANCE_REPORT_DIR: reports,
        PATH: join(directory, 'bin') + ':' + process.env.PATH,
        FIXTURE_FAIL_COMMAND: scenario === 'child failure' ? 'build' : '',
      },
    }
  );
  const report = JSON.parse(await readFile(join(reports, 'acceptance.json'), 'utf8'));
  return {result, report};
}

test('acceptance command reports passed with current-run diagnostics', async () => {
  const {result, report} = await runScenario('passed');
  const expectedCommands = commands;
  expect(report.schemaVersion).toBe(3);
  expect(report.environment).toMatchObject({
    platform: process.platform,
    architecture: process.arch,
  });
  expect(report.environment.target).toBe(expectedTarget);
  expect(report.finishedAt).toBeTruthy();
  expect(report).not.toHaveProperty('deferred');
  expect(report).not.toHaveProperty('acceptance');
  expect(result.status).toBe(0);
  expect(report.status).toBe('passed');
  expect(report.commit).toBe(git(['rev-parse', 'HEAD']));
  expect(report.cleanBefore && report.cleanAfter).toBe(true);
  expect(report.steps.map((step: {name: string}) => step.name)).toEqual(expectedCommands);
  expect(report.sourceTests).not.toHaveProperty('scripts');
  for (const step of report.steps) {
    expect(step.status).toBe('passed');
    expect(step.exitCode).toBe(0);
    expect(await readFile(join(reports, step.name + '.log'), 'utf8')).toContain(
      'fixture command:'
    );
  }

  expect(
    await readFile(join(reports, 'renderer-artifacts/results.json'), 'utf8')
  ).toContain('expected');
  expect(
    report.steps.find((step: {name: string}) => step.name === 'source-tests').command
  ).toEqual(['pnpm', 'test', '--packages-only']);
});

test('acceptance command reports reused checks with current-run diagnostics', async () => {
  const {result, report} = await runScenario('reused checks');
  const expectedCommands = commands.filter(
    name => !['install', 'electron-runtime', 'source-tests'].includes(name)
  );
  expect(report.schemaVersion).toBe(3);
  expect(report.environment).toMatchObject({
    platform: process.platform,
    architecture: process.arch,
  });
  expect(report.environment.target).toBe(expectedTarget);
  expect(report.finishedAt).toBeTruthy();
  expect(report).not.toHaveProperty('deferred');
  expect(report).not.toHaveProperty('acceptance');
  expect(result.status).toBe(0);
  expect(report.status).toBe('passed');
  expect(report.commit).toBe(git(['rev-parse', 'HEAD']));
  expect(report.cleanBefore && report.cleanAfter).toBe(true);
  expect(report.steps.map((step: {name: string}) => step.name)).toEqual(expectedCommands);
  expect(report.sourceTests).not.toHaveProperty('scripts');
  for (const step of report.steps) {
    expect(step.status).toBe('passed');
    expect(step.exitCode).toBe(0);
    expect(await readFile(join(reports, step.name + '.log'), 'utf8')).toContain(
      'fixture command:'
    );
  }

  expect(
    await readFile(join(reports, 'renderer-artifacts/results.json'), 'utf8')
  ).toContain('expected');
  expect(report.sourceChecks).toMatchObject({
    origin: 'prior-workflow-steps',
    commit: git(['rev-parse', 'HEAD']),
  });
  expect(report.sourceTests.contract).toEqual({passed: 1, total: 1, skipped: 0});
});

test('acceptance command reports reused renderer checks with current-run diagnostics', async () => {
  const {result, report} = await runScenario('reused renderer checks');
  const expectedCommands = commands.filter(
    name =>
      ![
        'install',
        'electron-runtime',
        'source-tests',
        'chromium-runtime',
        'renderer',
        'development-watcher',
      ].includes(name)
  );
  expect(report.schemaVersion).toBe(3);
  expect(report.environment).toMatchObject({
    platform: process.platform,
    architecture: process.arch,
  });
  expect(report.environment.target).toBe(expectedTarget);
  expect(report.finishedAt).toBeTruthy();
  expect(report).not.toHaveProperty('deferred');
  expect(report).not.toHaveProperty('acceptance');
  expect(result.status).toBe(0);
  expect(report.status).toBe('passed');
  expect(report.commit).toBe(git(['rev-parse', 'HEAD']));
  expect(report.cleanBefore && report.cleanAfter).toBe(true);
  expect(report.steps.map((step: {name: string}) => step.name)).toEqual(expectedCommands);
  expect(report.sourceTests).not.toHaveProperty('scripts');
  for (const step of report.steps) {
    expect(step.status).toBe('passed');
    expect(step.exitCode).toBe(0);
    expect(await readFile(join(reports, step.name + '.log'), 'utf8')).toContain(
      'fixture command:'
    );
  }

  expect(
    await readFile(join(reports, 'renderer-artifacts/results.json'), 'utf8')
  ).toContain('expected');
  expect(report.sourceChecks).toMatchObject({
    origin: 'prior-workflow-steps',
    commit: git(['rev-parse', 'HEAD']),
  });
  expect(report.sourceTests.contract).toEqual({passed: 1, total: 1, skipped: 0});
  expect(report.rendererChecks).toEqual({
    origin: 'prior-workflow-job',
    commit: git(['rev-parse', 'HEAD']),
  });
  expect(report.developmentWatcher.status).toBe('passed');
});

test('acceptance command reports child failure with current-run diagnostics', async () => {
  const {result, report} = await runScenario('child failure');
  expect(report.schemaVersion).toBe(3);
  expect(report.environment).toMatchObject({
    platform: process.platform,
    architecture: process.arch,
  });
  expect(report.environment.target).toBe(expectedTarget);
  expect(report.finishedAt).toBeTruthy();
  expect(report).not.toHaveProperty('deferred');
  expect(report).not.toHaveProperty('acceptance');
  expect(result.status).toBe(1);
  expect(report.status).toBe('failed');
  expect(report.error.stack).toBeTruthy();
  expect(report.error.message).toContain('build failed: 23');
  expect(report.steps.at(-1)).toMatchObject({
    name: 'build',
    status: 'failed',
    exitCode: 23,
  });
  expect(await readFile(join(reports, 'build.log'), 'utf8')).toContain(
    'fixture child diagnostic'
  );
});

test.each([
  {scenario: 'missing revision', message: 'HEAD'},
  {scenario: 'stale source checks', message: 'Source checks must use this commit'},
  {scenario: 'missing source checks', message: 'source-checks.commit'},
  {scenario: 'skipped source test', message: '1 !== 0'},
])(
  'acceptance command reports $scenario before running any commands',
  async ({scenario, message}) => {
    const {result, report} = await runScenario(scenario);
    expect(report.schemaVersion).toBe(3);
    expect(report.environment).toMatchObject({
      platform: process.platform,
      architecture: process.arch,
    });
    expect(report.environment.target).toBe(expectedTarget);
    expect(report.finishedAt).toBeTruthy();
    expect(report).not.toHaveProperty('deferred');
    expect(report).not.toHaveProperty('acceptance');
    expect(result.status).toBe(1);
    expect(report.status).toBe('failed');
    expect(report.error.stack).toBeTruthy();
    expect(report.steps).toEqual([]);
    expect(report.error.message).toContain(message);
  }
);

test.each([
  {
    scenario: 'stale renderer checks',
    message: 'Renderer checks must use this commit',
    steps: [],
  },
  {scenario: 'missing renderer checks', message: 'renderer-checks.commit', steps: []},
  {scenario: 'failed watcher checks', message: 'watcher.json must pass', steps: []},
  {
    scenario: 'stale watcher checks',
    message: 'watcher.json must use this commit',
    steps: [],
  },
  {
    scenario: 'flaky renderer checks',
    message: 'Renderer flaky checks must be zero',
    steps: ['build'],
  },
])(
  'acceptance command reports $scenario with current-run diagnostics',
  async ({scenario, message, steps}) => {
    const {result, report} = await runScenario(scenario);
    expect(report.schemaVersion).toBe(3);
    expect(report.environment).toMatchObject({
      platform: process.platform,
      architecture: process.arch,
    });
    expect(report.environment.target).toBe(expectedTarget);
    expect(report.finishedAt).toBeTruthy();
    expect(report).not.toHaveProperty('deferred');
    expect(report).not.toHaveProperty('acceptance');
    expect(result.status).toBe(1);
    expect(report.status).toBe('failed');
    expect(report.error.stack).toBeTruthy();
    expect(report.steps.map((step: {name: string}) => step.name)).toEqual(steps);
    expect(report.error.message).toContain(message);
  }
);

test
  .runIf(process.platform === 'darwin')
  .each(['passed', 'reused checks', 'reused renderer checks'])(
  'acceptance command excludes the Linux shipped backend for %s on macOS',
  async scenario => {
    const {result, report} = await runScenario(scenario);
    expect(result.status).toBe(0);
    expect(report.shippedBackend.applicable).toBe(false);
    expect(report.shippedBackend.reason).toContain('Linux release artifact');
  }
);
