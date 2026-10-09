import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdir, mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import {acceptedBootstrapArtifact} from '../bootstrapArtifact.ts';

test.skipIf(process.platform !== 'linux')(
  'selects the real raw accepted ARM64 package and rejects stale or changed evidence',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'bootstrap-artifact-'));
    try {
      const control = join(directory, 'package/DEBIAN');
      await mkdir(control, {recursive: true});
      await writeFile(
        join(control, 'control'),
        'Package: shop-things\nVersion: 0.3.1\nArchitecture: arm64\nMaintainer: Fixture\nDescription: Fixture\n'
      );
      const name = 'electron_0.3.1_arm64.deb';
      const path = join(directory, name);
      execFileSync('/usr/bin/dpkg-deb', [
        '--build',
        '--root-owner-group',
        join(directory, 'package'),
        path,
      ]);
      const sha256 = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
      const commit = 'a'.repeat(40);
      const report = {
        status: 'passed',
        target: 'linux-arm64',
        commit,
        dirtyCheckout: false,
        artifacts: [{path: name, sha256}],
        installedSystem: {
          package: 'Package: shop-things\nVersion: 0.3.1\nArchitecture: arm64\n',
        },
      };
      await expect(acceptedBootstrapArtifact(directory, report, commit)).resolves.toEqual(
        {path, sha256}
      );
      await expect(
        acceptedBootstrapArtifact(directory, {...report, commit: 'b'.repeat(40)}, commit)
      ).rejects.toThrow();
      await expect(
        acceptedBootstrapArtifact(directory, {...report, status: 'failed'}, commit)
      ).rejects.toThrow();
      await expect(
        acceptedBootstrapArtifact(
          directory,
          {...report, artifacts: [{path: '../' + name, sha256}]},
          commit
        )
      ).rejects.toThrow();
      await expect(
        acceptedBootstrapArtifact(
          directory,
          {
            ...report,
            installedSystem: {
              package: 'Package: unrelated\nVersion: 0.3.1\nArchitecture: arm64\n',
            },
          },
          commit
        )
      ).rejects.toThrow();
      const duplicate = join(directory, 'second_arm64.deb');
      await writeFile(duplicate, 'second candidate');
      await expect(
        acceptedBootstrapArtifact(directory, report, commit)
      ).rejects.toThrow();
      await rm(duplicate);
      await writeFile(path, 'changed artifact');
      await expect(
        acceptedBootstrapArtifact(directory, report, commit)
      ).rejects.toThrow();
      await writeFile(
        join(control, 'control'),
        'Package: unrelated\nVersion: 0.3.1\nArchitecture: arm64\nMaintainer: Fixture\nDescription: Fixture\n'
      );
      execFileSync('/usr/bin/dpkg-deb', [
        '--build',
        '--root-owner-group',
        join(directory, 'package'),
        path,
      ]);
      const wrongDigest = createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
      await expect(
        acceptedBootstrapArtifact(
          directory,
          {
            ...report,
            artifacts: [{path: name, sha256: wrongDigest}],
            installedSystem: {
              package: 'Package: unrelated\nVersion: 0.3.1\nArchitecture: arm64\n',
            },
          },
          commit
        )
      ).rejects.toThrow();
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  }
);

test.skipIf(process.platform !== 'linux')(
  'real Debian control metadata declares the ELF-required ALSA runtime alternative',
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-dependencies-'));
    try {
      const configuration = JSON.parse(
        await readFile(
          new URL('../../packages/electron/package.json', import.meta.url),
          'utf8'
        )
      );
      await mkdir(join(directory, 'package/DEBIAN'), {recursive: true});
      await writeFile(
        join(directory, 'package/DEBIAN/control'),
        'Package: shop-things\nVersion: 0.3.1\nArchitecture: arm64\nMaintainer: Fixture\nDescription: Fixture\nDepends: ' +
          configuration.build.deb.depends.join(', ') +
          '\n'
      );
      const artifact = join(directory, 'candidate.deb');
      execFileSync('/usr/bin/dpkg-deb', [
        '--build',
        '--root-owner-group',
        join(directory, 'package'),
        artifact,
      ]);
      const metadata = execFileSync(
        '/usr/bin/dpkg-deb',
        ['--field', artifact, 'Depends'],
        {encoding: 'utf8'}
      );
      expect(metadata.split(',').map(value => value.trim())).toContain(
        'libasound2t64 | libasound2'
      );
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  }
);
