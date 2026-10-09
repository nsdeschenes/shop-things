import {spawnSync} from 'node:child_process';
import {
  chmod,
  link as hardLink,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runInNewContext} from 'node:vm';

import {expect, test} from 'vitest';

import {root} from '../workspace.ts';
const require = createRequire(import.meta.url);
function hook() {
  return require(join(root, 'packages/electron/update/after-pack.cjs'));
}

test('generated Linux packaging makes protected parents and resources nonwritable while preserving executable intent', async () => {
  const output = await mkdtemp(join(tmpdir(), 'package-modes-'));
  const directory = join(output, 'resources/update');
  const plain = join(directory, 'identity.json');
  const executable = join(output, 'shop-things');
  try {
    await mkdir(directory, {recursive: true});
    await chmod(output, 0o775);
    await chmod(join(output, 'resources'), 0o775);
    await chmod(directory, 0o775);
    await writeFile(plain, 'fixture identity');
    await chmod(plain, 0o664);
    await writeFile(executable, 'fixture binary');
    await chmod(executable, 0o775);
    await hook()({electronPlatformName: 'linux', appOutDir: output});
    for (const path of [output, join(output, 'resources'), directory, executable]) {
      expect((await stat(path)).mode & 0o777).toBe(0o755);
    }

    expect((await stat(plain)).mode & 0o777).toBe(0o644);
    expect(await readFile(plain, 'utf8')).toBe('fixture identity');
    await chmod(plain, 0o664);
    await hook()({electronPlatformName: 'darwin', appOutDir: output});
    await hook()({electronPlatformName: 'win32', appOutDir: output});
    expect((await stat(plain)).mode & 0o777).toBe(0o664);
  } finally {
    await rm(output, {recursive: true, force: true});
  }
});

test('packaging refuses symlink and hardlink output without changing external permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'package-link-'));
  const external = join(root, 'outside');
  const output = join(root, 'output');
  const link = join(root, 'link');
  try {
    await mkdir(external);
    await chmod(external, 0o777);
    await symlink(external, link);
    await expect(
      hook()({electronPlatformName: 'linux', appOutDir: link})
    ).rejects.toThrow('Unsafe packaging output');
    await mkdir(output);
    await symlink(external, join(output, 'resources'));
    await expect(
      hook()({electronPlatformName: 'linux', appOutDir: output})
    ).rejects.toThrow('Unsafe packaging output');
    expect((await stat(external)).mode & 0o777).toBe(0o777);
    await rm(join(output, 'resources'));
    const outsideFile = join(external, 'shared');
    await writeFile(outsideFile, 'external bytes');
    await chmod(outsideFile, 0o666);
    await hardLink(outsideFile, join(output, 'linked'));
    await expect(
      hook()({electronPlatformName: 'linux', appOutDir: output})
    ).rejects.toThrow('Unsafe packaging output');
    expect((await stat(outsideFile)).mode & 0o777).toBe(0o666);
  } finally {
    await rm(root, {recursive: true, force: true});
  }
});

test('supported parent config tightens only Linux builder umask and preserves stricter masks', async () => {
  const path = join(root, 'packages/electron/update/build-config.cjs');
  const source = await readFile(path, 'utf8');
  const configuration = JSON.parse(
    await readFile(join(root, 'packages/electron/package.json'), 'utf8')
  );
  expect(configuration.build.extends).toBe('update/build-config.cjs');
  for (const [platform, initial, expected] of [
    ['linux', 0o002, 0o022],
    ['linux', 0o077, 0o077],
    ['darwin', 0o002, 0o002],
    ['win32', 0o002, 0o002],
  ] as const) {
    let mask: number = initial;
    const module = {exports: {}};
    runInNewContext(source, {
      module,
      process: {
        platform,
        umask(value?: number) {
          const previous = mask;
          if (value !== undefined) {
            mask = value;
          }

          return previous;
        },
      },
    });
    expect(mask).toBe(expected);
    expect(module.exports).toEqual({});
  }
});

test.skipIf(process.platform !== 'linux')(
  'direct Linux builder parent module tightens its own process mask',
  () => {
    const path = join(root, 'packages/electron/update/build-config.cjs');
    for (const initial of [0o002, 0o077]) {
      const child = spawnSync(
        process.execPath,
        [
          '-e',
          'process.umask(Number(process.argv[1])); require(process.argv[2]); console.log(process.umask());',
          String(initial),
          path,
        ],
        {encoding: 'utf8'}
      );
      expect(child.status).toBe(0);
      expect(Number(child.stdout.trim())).toBe(initial | 0o022);
    }
  }
);
