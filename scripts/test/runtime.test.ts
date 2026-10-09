import {spawnSync} from 'node:child_process';
import {copyFile, mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

import {expect, test} from 'vitest';

import {root} from '../workspace.ts';

const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const pnpmPath = process.env.npm_execpath;
const javascriptExtension = /\.[cm]?js$/;

function command(
  args: string[],
  cwd: string,
  env = process.env,
  node = process.execPath
) {
  const executable = pnpmPath ?? 'pnpm';
  const javascript = javascriptExtension.test(executable);
  const result = spawnSync(
    javascript ? node : executable,
    javascript ? [executable, ...args] : args,
    {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 60_000,
    }
  );
  expect(result.error).toBeUndefined();
  if (result.status !== 0) {
    throw new Error(result.stdout + result.stderr);
  }

  expect(result.status).toBe(0);
  return result.stdout.trim();
}

test('root runtime selects locked Node for filtered scripts, exec and grandchildren from a Node 24 shell', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-runtime-'));
  try {
    await writeFile(join(directory, 'pnpm-workspace.yaml'), 'packages:\n  - leaf\n');
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: manifest.packageManager,
        devEngines: {runtime: {name: 'node', version: '24.21.0', onFail: 'download'}},
      })
    );
    command(['install'], directory);
    const node24 = command(['exec', 'node', '-p', 'process.execPath'], directory);
    expect(spawnSync(node24, ['--version'], {encoding: 'utf8'}).stdout.trim()).toBe(
      'v24.21.0'
    );
    const env = {
      ...process.env,
      PATH: `${dirname(node24)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH}`,
    };
    expect(spawnSync('node', ['--version'], {env, encoding: 'utf8'}).stdout.trim()).toBe(
      'v24.21.0'
    );
    await mkdir(join(directory, 'leaf'));
    await writeFile(
      join(directory, 'package.json'),
      JSON.stringify({
        private: true,
        packageManager: manifest.packageManager,
        devEngines: manifest.devEngines,
        scripts: {...manifest.scripts, probe: 'node probe.cjs'},
      })
    );
    await writeFile(
      join(directory, 'leaf/package.json'),
      JSON.stringify({name: 'runtime-leaf', scripts: {probe: 'node ../probe.cjs'}})
    );
    await writeFile(
      join(directory, 'probe.cjs'),
      `
const {spawnSync} = require('node:child_process');
const child = spawnSync('node', ['-p', 'process.version'], {encoding: 'utf8'});
const nested = spawnSync('pnpm', ['--filter', 'runtime-leaf', 'exec', 'node', '-p', 'process.version'], {encoding: 'utf8'});
console.log(JSON.stringify({parent: process.version, child: child.stdout.trim(), nested: nested.stdout.trim(), codes: [child.status, nested.status]}));
`
    );
    command(['install'], directory, env, node24);
    const lock = await readFile(join(directory, 'pnpm-lock.yaml'), 'utf8');
    command(['install', '--frozen-lockfile', '--offline'], directory, env, node24);
    expect(await readFile(join(directory, 'pnpm-lock.yaml'), 'utf8')).toBe(lock);
    for (const args of [
      ['run', 'probe'],
      ['--filter', 'runtime-leaf', 'run', 'probe'],
      ['--filter', 'runtime-leaf', 'exec', 'node', '../probe.cjs'],
    ]) {
      const output = command(args, directory, env, node24);
      const line = output.split('\n').find(value => value.startsWith('{'));
      expect(line).toBeDefined();
      expect(JSON.parse(line ?? 'null')).toEqual({
        parent: 'v26.11.0',
        child: 'v26.11.0',
        nested: 'v26.11.0',
        codes: [0, 0],
      });
    }

    await mkdir(join(directory, 'scripts'));
    await copyFile(
      join(root, 'scripts/workspace.ts'),
      join(directory, 'scripts/workspace.ts')
    );
    await copyFile(
      join(root, 'scripts/processes.ts'),
      join(directory, 'scripts/processes.ts')
    );
    await writeFile(
      join(directory, 'scripts/build.ts'),
      "import {rm} from 'node:fs/promises'; import {runIfMain, root} from './workspace.ts'; await runIfMain(import.meta.url, () => rm(root + '/dist', {recursive: true, force: true}));"
    );
    await mkdir(join(directory, 'dist'));
    await writeFile(join(directory, 'dist/sentinel'), 'preserve existing output');
    const direct = spawnSync(node24, ['--experimental-strip-types', 'scripts/build.ts'], {
      cwd: directory,
      env,
      encoding: 'utf8',
    });
    expect(direct.status).toBe(1);
    expect(direct.stderr).toContain('pnpm build');
    expect(direct.stderr).toContain('26.11.0');
    expect(await readFile(join(directory, 'dist/sentinel'), 'utf8')).toBe(
      'preserve existing output'
    );
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
