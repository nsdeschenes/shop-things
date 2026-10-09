import assert from 'node:assert/strict';
import {mkdir, readFile, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

import {stableVersion} from '../packages/electron/src/updateManifest.ts';
import {root, runIfMain} from './workspace.ts';

export async function prepareUpdateIdentity(directory = root) {
  const metadata = JSON.parse(
    await readFile(join(directory, 'packages/electron/package.json'), 'utf8')
  );
  assert.ok(typeof metadata.version === 'string' && stableVersion.test(metadata.version));
  const destination = join(directory, 'packages/electron/update');
  await mkdir(destination, {recursive: true});
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
