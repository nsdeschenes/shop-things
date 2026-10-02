import {readFile, rm} from 'node:fs/promises';
import {join} from 'node:path';

import {expect, test} from 'vitest';

import {createReleaseFixture, packagePaths, runReleaseScript} from './releaseHelpers.ts';

test('Craft bump synchronizes every workspace manifest and preserves other metadata', async () => {
  const directory = await createReleaseFixture();
  try {
    const result = runReleaseScript(directory, 'bump-version', {
      CRAFT_NEW_VERSION: '0.2.0',
    });
    expect(result).toMatchObject({status: 0});
    for (const path of packagePaths) {
      expect(JSON.parse(await readFile(join(directory, path), 'utf8'))).toStrictEqual({
        version: '0.2.0',
        private: true,
      });
    }
  } finally {
    await rm(directory, {recursive: true, force: true});
  }
});

test.each(['', 'v1.0.0', '1.0.0-beta.1', '1.0.0+build', '01.0.0', 'auto'])(
  'rejects invalid or unstable resolved Craft version %s without modifying manifests',
  async version => {
    const directory = await createReleaseFixture();
    try {
      expect(
        runReleaseScript(directory, 'bump-version', {CRAFT_NEW_VERSION: version}).status
      ).toBe(1);
      for (const path of packagePaths) {
        expect(JSON.parse(await readFile(join(directory, path), 'utf8')).version).toBe(
          '0.0.1'
        );
      }
    } finally {
      await rm(directory, {recursive: true, force: true});
    }
  }
);
