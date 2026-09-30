import {spawnSync} from 'node:child_process';
import {cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import {root} from '../workspace.ts';

const cleanCheckoutError = /Require clean committed sources/;

function run(
  command: string,
  args: string[],
  directory: string,
  env: NodeJS.ProcessEnv = {}
) {
  return spawnSync(command, args, {
    cwd: directory,
    encoding: 'utf8',
    env: {...process.env, ...env},
    timeout: 30000,
  });
}

function git(args: string[], directory: string) {
  const result = run('git', args, directory);
  expect(result.status, `${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

test('both acceptance gates reject nonignored untracked source and migrations while permitting ignored build/report files', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-provenance-'));
  try {
    await mkdir(join(directory, 'packages/electron/smoke'), {recursive: true});
    await mkdir(join(directory, 'scripts'), {recursive: true});
    await cp(
      join(root, 'scripts/acceptance.ts'),
      join(directory, 'scripts/acceptance.ts')
    );
    await cp(
      join(root, 'packages/electron/smoke/packaged.test.ts'),
      join(directory, 'packages/electron/smoke/packaged.test.ts')
    );
    await writeFile(
      join(directory, '.gitignore'),
      'node_modules\nacceptance-reports\npackages/electron/dist\n'
    );
    await writeFile(
      join(directory, 'package.json'),
      '{"private":true,"type":"module"}\n'
    );
    git(['init', '-b', 'nd/test-provenance'], directory);
    git(['config', 'user.name', 'Provenance fixture'], directory);
    git(['config', 'user.email', 'noreply@example.com'], directory);
    git(['config', 'core.hooksPath', '/dev/null'], directory);
    git(['config', 'commit.gpgsign', 'false'], directory);
    git(['add', '.'], directory);
    git(
      [
        'commit',
        '-m',
        'test: Initialize isolated provenance fixture',
        '-m',
        'Co-Authored-By: Codex <noreply@openai.com>',
      ],
      directory
    );
    await symlink(
      join(root, 'packages/electron/node_modules'),
      join(directory, 'packages/electron/node_modules'),
      'dir'
    );
    await mkdir(join(directory, 'acceptance-reports'));
    await mkdir(join(directory, 'packages/electron/dist'));
    await writeFile(join(directory, 'acceptance-reports/generated.json'), '{}');
    await writeFile(join(directory, 'packages/electron/dist/generated.js'), 'generated');
    expect(git(['status', '--porcelain', '--untracked-files=all'], directory)).toBe('');
    const reportPath = join(directory, 'acceptance-reports/smoke.json');
    function invokeSmoke() {
      return run(
        join(root, 'packages/electron/node_modules/.bin/vitest'),
        ['run', 'packages/electron/smoke/packaged.test.ts'],
        directory,
        {SMOKE_REPORT_PATH: reportPath}
      );
    }

    // Platform/package prerequisites may fail, but ignored artifacts must pass the clean gate.
    expect(invokeSmoke().status).toBe(1);
    const cleanSmoke = JSON.parse(await readFile(reportPath, 'utf8'));
    expect(cleanSmoke.dirtyCheckout).toBe(false);
    for (const input of [
      'packages/electron/src/uncommitted.ts',
      'packages/db/migrations/uncommitted/migration.sql',
    ]) {
      const path = join(directory, input);
      await mkdir(join(path, '..'), {recursive: true});
      await writeFile(path, 'uncommitted input');
      const accepted = run(
        process.execPath,
        ['--experimental-strip-types', 'scripts/acceptance.ts'],
        directory,
        {
          ACCEPTANCE_REPORT_DIR: join(directory, 'acceptance-reports'),
        }
      );
      expect(accepted.status).toBe(1);
      const acceptance = JSON.parse(
        await readFile(join(directory, 'acceptance-reports/acceptance.json'), 'utf8')
      );
      expect(acceptance.status).toBe('failed');
      expect(acceptance.error.message).toMatch(cleanCheckoutError);
      expect(acceptance.steps).toStrictEqual([]);
      expect(invokeSmoke().status).toBe(1);
      const smoke = JSON.parse(await readFile(reportPath, 'utf8'));
      expect(smoke.status).toBe('failed');
      expect(smoke.dirtyCheckout).toBe(true);
      expect('artifacts' in smoke).toBe(false);
      await rm(path);
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
