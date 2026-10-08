import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {root} from '../workspace.ts';

export const packagePaths = [
  'package.json',
  'packages/electron/package.json',
  'packages/interface/package.json',
  'packages/db/package.json',
  'packages/contract/package.json',
];

export async function createReleaseFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'shop-things-release-'));
  for (const path of packagePaths) {
    await mkdir(join(directory, path, '..'), {recursive: true});
    await writeFile(
      join(directory, path),
      JSON.stringify({version: '0.0.1', private: true})
    );
  }

  return directory;
}

export function runReleaseScript(
  directory: string,
  script: string,
  env: NodeJS.ProcessEnv = {}
) {
  return spawnSync(
    process.execPath,
    ['--experimental-strip-types', join(root, 'scripts', `${script}.ts`)],
    {cwd: directory, env: {...process.env, ...env}, encoding: 'utf8'}
  );
}
