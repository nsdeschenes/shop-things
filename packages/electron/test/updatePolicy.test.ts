import {generateKeyPairSync} from 'node:crypto';

import {expect, test, vi} from 'vitest';

const filesystem = vi.hoisted(() => ({lstat: vi.fn(), open: vi.fn()}));
vi.mock('node:fs/promises', () => filesystem);

import {loadInstalledUpdatePolicy} from '../src/updatePolicy.js';

test('protected installed trust refuses private keys instead of converting and distributing them', async () => {
  const {privateKey, publicKey} = generateKeyPairSync('ed25519');
  const file = {
    stat: async () => ({isFile: () => true, uid: 0, mode: 0o644, size: 1024}),
    readFile: vi.fn(),
    close: vi.fn(),
  };
  filesystem.lstat.mockResolvedValue({isDirectory: () => true, uid: 0, mode: 0o755});
  filesystem.open.mockResolvedValue(file);
  file.readFile.mockResolvedValue(
    JSON.stringify({
      schemaVersion: 1,
      helperProtocol: 1,
      trustedKeys: [privateKey.export({type: 'pkcs8', format: 'pem'}).toString()],
    })
  );
  await expect(loadInstalledUpdatePolicy()).rejects.toThrow('Invalid publisher key');
  file.readFile.mockResolvedValue(
    JSON.stringify({
      schemaVersion: 1,
      helperProtocol: 1,
      trustedKeys: [publicKey.export({type: 'spki', format: 'pem'}).toString()],
    })
  );
  await expect(loadInstalledUpdatePolicy()).resolves.toMatchObject({helperProtocol: 1});
});
