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
