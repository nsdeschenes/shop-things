import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {stableVersion} from '../packages/electron/src/updateManifest.ts';
import {validatePublicPolicy} from './updateRelease.ts';
import {root, runIfMain} from './workspace.ts';

export async function prepareUpdateIdentity(directory = root) {
  const metadata = JSON.parse(
    await readFile(join(directory, 'packages/electron/package.json'), 'utf8')
  );
  assert.ok(typeof metadata.version === 'string' && stableVersion.test(metadata.version));
  const destination = join(directory, 'packages/electron/update');
  await mkdir(destination, {recursive: true});
  let policy: Buffer | null = null;
  try {
    policy = await readFile(join(destination, 'policy.json'));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }

  if (policy) {
    assert.ok(policy.length > 0 && policy.length <= 65536);
    validatePublicPolicy(
      JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(policy))
    );
  }

  await writeFile(
    join(destination, 'identity.json'),
    JSON.stringify({
      schemaVersion: 1,
      packageName: 'shop-things',
      appVersion: metadata.version,
    }) + '\n'
  );
}

await runIfMain(import.meta.url, () => prepareUpdateIdentity());
