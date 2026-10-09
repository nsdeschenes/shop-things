import {readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import {prepareUpdateIdentity} from '../prepareUpdateIdentity.ts';
import {createReleaseFixture} from './releaseHelpers.ts';

test('generates packaged application identity from the same Electron package metadata', async () => {
  const directory = await createReleaseFixture();
  try {
    await prepareUpdateIdentity(directory);
    expect(
      JSON.parse(
        await readFile(join(directory, 'packages/electron/update/identity.json'), 'utf8')
      )
    ).toEqual({schemaVersion: 1, packageName: 'shop-things', appVersion: '0.0.1'});
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});
