import {createPublicKey} from 'node:crypto';
import {constants} from 'node:fs';
import {open, lstat} from 'node:fs/promises';

export const updatePolicyPath = '/usr/lib/shop-things/update/policy.json';
export interface UpdatePolicy {
  schemaVersion: 1;
  helperProtocol: 1;
  trustedKeys: string[];
}

export async function loadInstalledUpdatePolicy(): Promise<UpdatePolicy> {
  for (const path of [
    '/usr',
    '/usr/lib',
    '/usr/lib/shop-things',
    '/usr/lib/shop-things/update',
  ]) {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.uid !== 0 || (metadata.mode & 0o022) !== 0) {
      throw new Error('Update policy directory is not protected.');
    }
  }

  const file = await open(updatePolicyPath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.uid !== 0 ||
      (metadata.mode & 0o022) !== 0 ||
      metadata.size > 65536
    ) {
      throw new Error('Update policy is not protected.');
    }

    const value: unknown = JSON.parse(await file.readFile('utf8'));
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      Object.keys(value).length !== 3 ||
      !('schemaVersion' in value) ||
      value.schemaVersion !== 1 ||
      !('helperProtocol' in value) ||
      value.helperProtocol !== 1 ||
      !('trustedKeys' in value) ||
      !Array.isArray(value.trustedKeys) ||
      value.trustedKeys.length === 0 ||
      value.trustedKeys.length > 16
    ) {
      throw new Error('Invalid installed update policy.');
    }

    const trustedKeys: string[] = [];
    for (const key of value.trustedKeys) {
      if (
        typeof key !== 'string' ||
        key.length > 4096 ||
        !key.startsWith('-----BEGIN PUBLIC KEY-----\n') ||
        createPublicKey(key).asymmetricKeyType !== 'ed25519'
      ) {
        throw new Error('Invalid publisher key.');
      }

      const publicKey = createPublicKey(key)
        .export({type: 'spki', format: 'pem'})
        .toString();
      if (key.trim() !== publicKey.trim()) {
        throw new Error('Publisher key must contain only public SPKI PEM.');
      }

      trustedKeys.push(publicKey);
    }

    return {schemaVersion: 1, helperProtocol: 1, trustedKeys};
  } finally {
    await file.close();
  }
}
