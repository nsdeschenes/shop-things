import {spawnSync} from 'node:child_process';
import {chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import {root} from '../workspace.ts';

test('packaged smoke validates existing outputs without rebuilding them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-smoke-command-'));
  try {
    await mkdir(join(directory, 'scripts'));
    await mkdir(join(directory, 'bin'));
    await cp(join(root, 'package.json'), join(directory, 'package.json'));
    for (const name of [
      'electron-smoke.ts',
      'testHelpers.ts',
      'processes.ts',
      'workspace.ts',
      'build.ts',
      'prepare.ts',
      'inspectBrowserDependencies.ts',
    ]) {
      await cp(join(root, 'scripts', name), join(directory, 'scripts', name));
    }

    const emitted = join(directory, 'packages/electron/dist/main.js');
    await mkdir(join(directory, 'packages/electron/dist'), {recursive: true});
    await writeFile(emitted, 'the build used for packaging');
    const commands = join(directory, 'commands.jsonl');
    await writeFile(
      join(directory, 'bin/pnpm'),
      '#!/usr/bin/env node\n' +
        'import {appendFileSync} from "node:fs";\n' +
        'appendFileSync(process.env.SMOKE_COMMAND_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\n'
    );
    await chmod(join(directory, 'bin/pnpm'), 0o755);
    const result = spawnSync(process.execPath, ['scripts/electron-smoke.ts'], {
      cwd: directory,
      encoding: 'utf8',
      timeout: 30000,
      env: {
        ...process.env,
        npm_execpath: '',
        ACCEPTANCE_REPORT_DIR: '',
        SMOKE_COMMAND_LOG: commands,
        PATH: join(directory, 'bin') + ':' + process.env.PATH,
      },
    });
    expect(result.status).toBe(0);
    expect(await readFile(emitted, 'utf8')).toBe('the build used for packaging');
    const invoked = (await readFile(commands, 'utf8'))
      .trim()
      .split('\n')
      .map(line => JSON.parse(line));
    expect(invoked).toContainEqual([
      '--filter',
      'electron',
      'exec',
      'vitest',
      'run',
      '--config',
      'vitest.smoke.config.ts',
    ]);
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
