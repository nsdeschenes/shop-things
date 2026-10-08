import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';
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

export async function createDebianFixture(
  directory: string,
  options: {
    filename?: string;
    packageName?: string;
    packageVersion?: string;
    architecture?: string;
    policy?: unknown;
  } = {}
) {
  const source = join(directory, 'deb-fixture');
  await mkdir(join(source, 'DEBIAN'), {recursive: true});
  await writeFile(
    join(source, 'DEBIAN/control'),
    `Package: ${options.packageName ?? 'shop-things'}\nVersion: ${options.packageVersion ?? '0.0.1-1'}\nArchitecture: ${options.architecture ?? 'arm64'}\nMaintainer: Release fixture <noreply@example.com>\nDescription: Controlled release test fixture\n`
  );
  if (options.policy) {
    const resources = join(source, 'opt/Shop Things/resources/update');
    await mkdir(resources, {recursive: true});
    await writeFile(join(resources, 'policy.json'), JSON.stringify(options.policy));
  }

  const filename = options.filename ?? 'shop-things_0.0.1_arm64.deb';
  const destination = join(directory, 'release', filename);
  await mkdir(join(directory, 'release'), {recursive: true});
  const result = spawnSync(
    '/usr/bin/dpkg-deb',
    ['--build', '--root-owner-group', source, destination],
    {encoding: 'utf8'}
  );
  if (result.status !== 0) {
    throw new Error('Could not build controlled Debian fixture: ' + result.stderr);
  }

  return destination;
}

export async function releaseAcceptance(commit: string, installer: string) {
  const digest = createHash('sha256')
    .update(await readFile(installer))
    .digest('hex');
  const evidence = {
    schemaVersion: 2,
    status: 'passed',
    commit,
    artifacts: [{path: 'shop-things_0.0.1_arm64.deb', sha256: digest}],
  };
  return {
    schemaVersion: 3,
    status: 'passed',
    commit,
    environment: {target: 'linux-arm64-glibc'},
    shippedBackend: evidence,
    packagedRenderer: evidence,
  };
}
