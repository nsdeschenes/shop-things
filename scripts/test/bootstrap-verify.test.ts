import {execFileSync} from 'node:child_process';
import {generateKeyPairSync} from 'node:crypto';
import {chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';

import {expect, test} from 'vitest';

import {inspectBootstrap, legacyIdentity} from '../verify-bootstrap.ts';
import {requireElectron} from '../workspace.ts';

async function fixture(packageName = 'electron') {
  const root = await mkdtemp(join(tmpdir(), 'bootstrap-check-'));
  const admin = join(root, 'var/lib/dpkg');
  await mkdir(join(admin, 'info'), {recursive: true, mode: 0o755});
  const payload = 'known fixture bytes';
  const files = legacyIdentity.files.map(file => ({
    ...file,
    // Independent SHA-256 of the literal fixture bytes, not derived by the verifier.
    sha256: '1e58731f01b8333fbc43d9bee72403bbe9e088b9b27825986f43772270f9e652',
    size: Buffer.byteLength(payload),
  }));
  const scripts = legacyIdentity.scripts.map(file => ({
    ...file,
    sha256: files[0]!.sha256,
    size: Buffer.byteLength(payload),
  }));
  for (const file of [...files, ...scripts]) {
    const path = join(root, file.path);
    await mkdir(dirname(path), {recursive: true, mode: 0o755});
    await writeFile(path, payload, {mode: 0o644});
  }

  await writeFile(
    join(admin, 'status'),
    `Package: ${packageName}\nStatus: install ok installed\nVersion: 0.3.1\nArchitecture: arm64\nMaintainer: ${legacyIdentity.maintainer}\nVendor: ${legacyIdentity.maintainer}\nHomepage: ${legacyIdentity.homepage}\nDescription: \n  ${legacyIdentity.description}\n\n`,
    {mode: 0o644}
  );
  await writeFile(
    join(admin, 'info', `${packageName}.list`),
    files.map(file => file.path).join('\n') + '\n',
    {mode: 0o644}
  );
  return {
    root,
    files,
    options: {
      root,
      ownerUid: process.getuid!(),
      legacy: {...legacyIdentity, files, scripts},
    },
  };
}

test('verifies real dpkg metadata, ownership and protected known legacy bytes without changing them', async () => {
  const value = await fixture();
  try {
    const before = await readFile(join(value.root, 'var/lib/dpkg/status'));
    const result = await inspectBootstrap(value.options);
    expect(result).toMatchObject({kind: 'verified-legacy'});
    expect(await readFile(join(value.root, 'var/lib/dpkg/status'))).toEqual(before);
    await writeFile(
      join(value.root, legacyIdentity.scripts[1]!.path),
      'changed removal script'
    );
    expect((await inspectBootstrap(value.options)).kind).toBe('unsafe');
  } finally {
    await rm(value.root, {recursive: true, force: true});
  }
});

test('checks packaged runtime identity against protected bootstrap identity and preserves unrelated electron', async () => {
  const value = await fixture('shop-things');
  try {
    const packageDirectory = join(value.root, 'package');
    await mkdir(packageDirectory);
    await writeFile(
      join(packageDirectory, 'package.json'),
      JSON.stringify({name: 'electron', version: '0.4.0'})
    );
    const builder = createRequire(requireElectron.resolve('electron-builder'));
    const asar = createRequire(builder.resolve('app-builder-lib'))('@electron/asar');
    await asar.createPackage(
      packageDirectory,
      join(value.root, '/opt/Shop Things/resources/app.asar')
    );
    for (const path of [
      '/usr/lib/shop-things/updater-helper',
      '/usr/lib/shop-things/update-supervisor',
      '/usr/lib/shop-things/update/identity.json',
      '/usr/share/polkit-1/actions/com.shopthings.app.update.policy',
    ]) {
      await mkdir(dirname(join(value.root, path)), {recursive: true, mode: 0o755});
      await writeFile(join(value.root, path), 'fixture protected resource', {
        mode: 0o644,
      });
    }

    const identity = join(value.root, '/usr/lib/shop-things/update/identity.json');
    await writeFile(
      identity,
      JSON.stringify({schemaVersion: 1, packageName: 'shop-things', appVersion: '0.4.0'})
    );
    const status = join(value.root, 'var/lib/dpkg/status');
    await writeFile(
      status,
      (await readFile(status, 'utf8')) +
        'Package: electron\nStatus: install ok installed\nVersion: 2\nArchitecture: arm64\nMaintainer: Another application\nDescription: Unrelated electron\n\n'
    );
    const result = await inspectBootstrap(value.options);
    expect(result).toMatchObject({kind: 'verified-bootstrap'});
    expect(result.appVersion).toBe('0.4.0');
    const policyPath = join(value.root, '/usr/lib/shop-things/update/policy.json');
    const publicKey = generateKeyPairSync('ed25519')
      .publicKey.export({type: 'spki', format: 'pem'})
      .toString();
    const policy = {schemaVersion: 1, helperProtocol: 1, trustedKeys: [publicKey]};
    await writeFile(policyPath, JSON.stringify(policy), {mode: 0o644});
    expect((await inspectBootstrap(value.options)).kind).toBe('verified-bootstrap');
    for (const invalid of [
      '{"schemaVersion":1,"helperProtocol":1,"trustedKeys":["-----BEGIN PRIVATE KEY-----\\nprivate fixture"],"trustedKeys":' +
        JSON.stringify(policy.trustedKeys) +
        '}',
      JSON.stringify({...policy, privateKey: 'private fixture'}),
      '\ufeff' + JSON.stringify(policy),
    ]) {
      await writeFile(policyPath, invalid);
      const refused = await inspectBootstrap(value.options);
      expect(refused.kind).toBe('unsafe');
      expect(refused.diagnostics.join()).not.toContain('private fixture');
    }

    await rm(policyPath);
    await writeFile(
      identity,
      '{"schemaVersion":1,"schemaVersion":1,"packageName":"shop-things","appVersion":"0.4.0"}'
    );
    expect((await inspectBootstrap(value.options)).kind).toBe('unsafe');
    await writeFile(
      identity,
      JSON.stringify({schemaVersion: 1, packageName: 'shop-things', appVersion: '0.5.0'})
    );
    expect((await inspectBootstrap(value.options)).kind).toBe('unsafe');
    await writeFile(
      identity,
      JSON.stringify({schemaVersion: 1, packageName: 'shop-things', appVersion: '0.4.0'})
    );
    await writeFile(
      join(packageDirectory, 'package.json'),
      JSON.stringify({name: 'shop-things', version: '0.4.0'})
    );
    await asar.createPackage(
      packageDirectory,
      join(value.root, '/opt/Shop Things/resources/app.asar')
    );
    expect((await inspectBootstrap(value.options)).kind).toBe('unsafe');
    expect(await readFile(status, 'utf8')).toContain('Maintainer: Another application');
  } finally {
    await rm(value.root, {recursive: true, force: true});
  }
});

test('fresh installation requires unused shared paths and never treats a dirty legacy as removal approval', async () => {
  const value = await fixture();
  try {
    const status = join(value.root, 'var/lib/dpkg/status');
    await writeFile(
      status,
      (await readFile(status, 'utf8')).replace(
        'install ok installed',
        'install ok unpacked'
      )
    );
    expect((await inspectBootstrap(value.options)).kind).toBe('unsafe');
    await writeFile(status, '');
    expect((await inspectBootstrap(value.options)).kind).toBe('unsafe');
    for (const file of value.files) {
      await rm(join(value.root, file.path));
    }

    const result = await inspectBootstrap(value.options);
    expect(result).toMatchObject({kind: 'fresh'});
    expect(result.shutdownConsent).toBe('operator-required');
  } finally {
    await rm(value.root, {recursive: true, force: true});
  }
});

test('refuses unrelated electron and modified or unsafe installed Shop Things files', async () => {
  const value = await fixture();
  try {
    const status = join(value.root, 'var/lib/dpkg/status');
    const original = await readFile(status, 'utf8');
    await writeFile(
      status,
      original.replace(legacyIdentity.homepage, 'https://example.com/unrelated')
    );
    expect((await inspectBootstrap(value.options)).kind).toBe('unrelated-electron');
    await writeFile(status, original);
    const path = join(value.root, value.files[0]!.path);
    await writeFile(path, 'modified');
    expect((await inspectBootstrap(value.options)).kind).toBe('unsafe');
    await writeFile(path, 'known fixture bytes', {mode: 0o644});
    await chmod(path, 0o666);
    expect((await inspectBootstrap(value.options)).kind).toBe('unsafe');
    await rm(path);
    await symlink(join(value.root, value.files[1]!.path), path);
    expect((await inspectBootstrap(value.options)).kind).toBe('unsafe');
    // A matching label cannot compensate for another package owning the executable.
    await rm(path);
    await writeFile(path, 'known fixture bytes', {mode: 0o644});
    await writeFile(
      join(value.root, 'var/lib/dpkg/info/other.list'),
      value.files[0]!.path + '\n'
    );
    await writeFile(
      status,
      original +
        'Package: other\nStatus: install ok installed\nVersion: 1\nArchitecture: arm64\nMaintainer: Fixture\nDescription: Another installed owner\n\n'
    );
    expect((await inspectBootstrap(value.options)).kind).toBe('unsafe');
    expect(
      execFileSync(
        '/usr/bin/dpkg-query',
        ['--admindir=' + join(value.root, 'var/lib/dpkg'), '--show', 'electron'],
        {encoding: 'utf8'}
      )
    ).toContain('0.3.1');
  } finally {
    await rm(value.root, {recursive: true, force: true});
  }
});
