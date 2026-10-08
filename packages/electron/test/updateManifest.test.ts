import {generateKeyPairSync, sign} from 'node:crypto';

import {expect, test} from 'vitest';

import {verifyUpdateManifest} from '../src/updateManifest.js';

const keys = generateKeyPairSync('ed25519');
export const manifest = {
  schemaVersion: 1,
  applicationId: 'com.shopthings.app',
  repository: 'nsdeschenes/shop-things',
  channel: 'stable',
  appVersion: '0.4.0',
  packageName: 'shop-things',
  packageVersion: '0.4.0',
  platform: 'linux',
  architecture: 'arm64',
  helperProtocol: {min: 1, max: 1},
  artifact: {
    filename: 'shop-things-0.4.0-linux-arm64.deb',
    byteLength: 100,
    sha256: 'a'.repeat(64),
  },
};

function verify(text: string) {
  const bytes = Buffer.from(text);
  return verifyUpdateManifest(bytes, sign(null, bytes, keys.privateKey), [
    keys.publicKey,
  ]);
}

test('verifies the exact published bytes with installed Ed25519 trust', () => {
  expect(verify(JSON.stringify(manifest, null, 2))).toEqual(manifest);
  const bytes = Buffer.from(JSON.stringify(manifest));
  expect(() =>
    verifyUpdateManifest(bytes, sign(null, Buffer.from('other'), keys.privateKey), [
      keys.publicKey,
    ])
  ).toThrow();
  expect(() =>
    verifyUpdateManifest(bytes, sign(null, bytes, keys.privateKey), [])
  ).toThrow();
});

test.each([
  [
    'duplicate field',
    JSON.stringify(manifest).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1'
    ),
  ],
  [
    'escaped duplicate',
    JSON.stringify(manifest).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"\\u0073chemaVersion":1'
    ),
  ],
  ['nested duplicate', JSON.stringify(manifest).replace('"min":1', '"min":1,"min":1')],
  ['unknown field', JSON.stringify({...manifest, command: 'install'})],
  ['wrong identity', JSON.stringify({...manifest, packageName: 'electron'})],
  ['prerelease', JSON.stringify({...manifest, appVersion: '0.4.0-beta.1'})],
  ['unsupported helper', JSON.stringify({...manifest, helperProtocol: {min: 2, max: 2}})],
  [
    'artifact path',
    JSON.stringify({
      ...manifest,
      artifact: {...manifest.artifact, filename: '../update.deb'},
    }),
  ],
  [
    'oversized installer',
    JSON.stringify({
      ...manifest,
      artifact: {...manifest.artifact, byteLength: 1073741825},
    }),
  ],
  ['trailing data', JSON.stringify(manifest) + '{}'],
])('rejects a signed %s manifest', (_name, text) => {
  expect(() => verify(text)).toThrow();
});

test('rejects invalid UTF-8 and wire size even with an authorized signature', () => {
  for (const bytes of [Buffer.from([0xff]), Buffer.alloc(65537, 32)]) {
    expect(() =>
      verifyUpdateManifest(bytes, sign(null, bytes, keys.privateKey), [keys.publicKey])
    ).toThrow();
  }

  expect(() =>
    verifyUpdateManifest(Buffer.from('{}'), Buffer.alloc(63), [keys.publicKey])
  ).toThrow();
});
