import {spawnSync} from 'node:child_process';
import {readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import {prepareUpdateIdentity} from '../prepareUpdateIdentity.ts';
import {root} from '../workspace.ts';
import {createReleaseFixture} from './releaseHelpers.ts';

function beforePack(directory: string) {
  return spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '-e',
      'require(process.argv[1])({packager:{projectDir:process.argv[2]}}).catch(e=>{console.error(e);process.exitCode=1})',
      join(root, 'packages/electron/update/before-pack.cjs'),
      join(directory, 'packages/electron'),
    ],
    {encoding: 'utf8'}
  );
}

test('generates packaged application identity from the same Electron package metadata', async () => {
  const directory = await createReleaseFixture();
  try {
    expect(beforePack(directory).status).toBe(0);
    expect(
      JSON.parse(
        await readFile(join(directory, 'packages/electron/update/identity.json'), 'utf8')
      )
    ).toEqual({schemaVersion: 1, packageName: 'shop-things', appVersion: '0.0.1'});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('ordinary builds reject a private PEM in packaged public policy before emitting identity', async () => {
  const {generateKeyPairSync} = await import('node:crypto');
  const {mkdir, writeFile} = await import('node:fs/promises');
  const directory = await createReleaseFixture();
  const {privateKey} = generateKeyPairSync('ed25519');
  try {
    const update = join(directory, 'packages/electron/update');
    await mkdir(update, {recursive: true});
    await writeFile(
      join(update, 'policy.json'),
      JSON.stringify({
        schemaVersion: 1,
        helperProtocol: 1,
        trustedKeys: [privateKey.export({type: 'pkcs8', format: 'pem'}).toString()],
      })
    );
    await expect(prepareUpdateIdentity(directory)).rejects.toThrow('Only public SPKI');
    const packaged = beforePack(directory);
    expect(packaged.status).toBe(1);
    expect(packaged.stderr).toContain('Only public SPKI');
    await expect(readFile(join(update, 'identity.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('normal and direct builder builds reject duplicate trust fields concealing private material', async () => {
  const {generateKeyPairSync} = await import('node:crypto');
  const {mkdir, writeFile} = await import('node:fs/promises');
  const directory = await createReleaseFixture();
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  try {
    const update = join(directory, 'packages/electron/update');
    await mkdir(update, {recursive: true});
    const privatePem = privateKey.export({type: 'pkcs8', format: 'pem'}).toString();
    const publicPem = publicKey.export({type: 'spki', format: 'pem'}).toString();
    await writeFile(
      join(update, 'policy.json'),
      `{"schemaVersion":1,"helperProtocol":1,"trustedKeys":${JSON.stringify([privatePem])},"trustedKeys":${JSON.stringify([publicPem])}}`
    );
    await expect(prepareUpdateIdentity(directory)).rejects.toThrow('Duplicate JSON key');
    const packaged = beforePack(directory);
    expect(packaged.status).toBe(1);
    expect(packaged.stderr).toContain('Duplicate JSON key');
    expect(packaged.stderr).not.toContain(privatePem);
    await expect(readFile(join(update, 'identity.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test('build policy byte validation rejects BOM, invalid UTF-8 and oversized input', async () => {
  const {generateKeyPairSync} = await import('node:crypto');
  const {mkdir, writeFile} = await import('node:fs/promises');
  const directory = await createReleaseFixture();
  const {publicKey} = generateKeyPairSync('ed25519');
  const valid = JSON.stringify({
    schemaVersion: 1,
    helperProtocol: 1,
    trustedKeys: [publicKey.export({type: 'spki', format: 'pem'}).toString()],
  });
  try {
    const update = join(directory, 'packages/electron/update');
    await mkdir(update, {recursive: true});
    for (const bytes of [
      Buffer.from('\ufeff' + valid),
      Buffer.concat([Buffer.from(valid), Buffer.from([0xff])]),
      Buffer.from(valid + ' '.repeat(65536)),
    ]) {
      await writeFile(join(update, 'policy.json'), bytes);
      await expect(prepareUpdateIdentity(directory)).rejects.toThrow();
      expect(beforePack(directory).status).toBe(1);
      await expect(readFile(join(update, 'identity.json'))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
