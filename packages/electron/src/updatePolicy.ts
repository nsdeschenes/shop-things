import {constants} from 'node:fs';
import {open, lstat} from 'node:fs/promises';

import {parseUniqueJson} from './updateManifest.js';

export const updatePolicyPath = '/usr/lib/shop-things/update/policy.json';
import {validatePublicPolicy, type PublicUpdatePolicy} from './publicUpdatePolicy.js';
export type UpdatePolicy = PublicUpdatePolicy;

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

    const bytes = await file.readFile();
    if (bytes.length === 0 || bytes.length > 65536) {
      throw new Error('Invalid update policy bounds.');
    }

    const value: unknown = parseUniqueJson(
      new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes)
    );
    return validatePublicPolicy(value);
  } finally {
    await file.close();
  }
}
